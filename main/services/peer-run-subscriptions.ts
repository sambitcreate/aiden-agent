import { randomUUID } from "node:crypto";
import type {
  PeerRunEvent,
  PeerRunStreamState,
  PeerRunSubscription,
  PeerRunTarget,
} from "../../renderer/shared/peer-host.js";

/** A stream with no viewers stays open this long before it is closed. */
export const PEER_RUN_EVICT_MS = 300_000;
/** Live run streams per host; the host feed is the seventeenth stream slot. */
export const PEER_LIVE_RUNS_PER_HOST = 16;
/** Live run streams plus host feeds across every host. */
export const PEER_LIVE_STREAMS_TOTAL = 64;
export const PEER_RUN_BUFFER_EVENTS = 512;
export const PEER_RUN_BUFFER_BYTES = 1_048_576;

const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CHAT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

export class PeerRunLimitError extends Error {
  constructor() {
    super("Too many live conversations are open on other devices.");
  }
}

/** Validates a renderer-supplied target into its stream key. */
export function peerRunTarget(value: unknown): PeerRunTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid run target.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) throw new Error("Invalid run target.");
  if (typeof record.chatId === "string" && CHAT_ID.test(record.chatId))
    return { chatId: record.chatId };
  if (typeof record.runId === "string" && RUN_ID.test(record.runId))
    return { runId: record.runId };
  throw new Error("Invalid run target.");
}

export function peerRunKey(target: PeerRunTarget): string {
  return "chatId" in target ? `chat:${target.chatId}` : `run:${target.runId}`;
}

/**
 * Prompts still pending as of the newest event dropped from a stream's
 * buffer, keyed by approval or prompt id with the host's own payload.
 */
interface EvictedAttention {
  approvals: Map<string, Record<string, unknown>>;
  questions: Map<string, Record<string, unknown>>;
  /** The newest dropped event, which the summary stands in for. */
  last: PeerRunEvent | null;
  /** A dropped event settled the run; `run.ended` settles its viewers. */
  settled: boolean;
}

function noAttention(): EvictedAttention {
  return { approvals: new Map(), questions: new Map(), last: null, settled: false };
}

function promptEntries(value: unknown, idKey: string): [string, Record<string, unknown>][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): [string, Record<string, unknown>][] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = (entry as Record<string, unknown>)[idKey];
    return typeof id === "string" && id ? [[id, entry as Record<string, unknown>]] : [];
  });
}

/** Folds a dropped event into the prompts pending at the buffer's floor. */
function foldAttention(attention: EvictedAttention, event: PeerRunEvent): void {
  attention.last = event;
  const payload = event.payload;
  switch (event.type) {
    case "approval_required":
      if (typeof payload.approvalId === "string" && payload.approvalId)
        attention.approvals.set(payload.approvalId, payload);
      return;
    case "approval_resolved":
      if (typeof payload.approvalId === "string") attention.approvals.delete(payload.approvalId);
      return;
    case "question_required":
      if (typeof payload.promptId === "string" && payload.promptId)
        attention.questions.set(payload.promptId, payload);
      return;
    case "question_resolved":
      if (typeof payload.promptId === "string") attention.questions.delete(payload.promptId);
      return;
    case "snapshot":
      if (payload.reason === "gap") {
        attention.approvals = new Map(promptEntries(payload.approvals, "approvalId"));
        attention.questions = new Map(promptEntries(payload.questions, "promptId"));
      }
      return;
    default:
      if (event.terminal || event.type === "run.ended") {
        attention.approvals.clear();
        attention.questions.clear();
        attention.settled = true;
      }
  }
}

/**
 * One shared run stream on one host: the event buffer every viewer replays
 * from, deduplicated by sequence across reconnects.
 */
export class PeerRunStream {
  runId: string | null;
  chatId: string | null;
  state: PeerRunStreamState = "waiting";
  /** Last accepted sequence of `runId`; the next connection's `Last-Event-ID`. */
  cursor: number;
  ended = false;
  /** Every event of `runId` with a sequence above `floor` is in the buffer. */
  private floor: number;
  private buffer: { event: PeerRunEvent; bytes: number }[] = [];
  private bytes = 0;
  /**
   * What the dropped events still had pending. A viewer whose replay starts
   * below `floor` gets it as a `gap` snapshot, so an unanswered approval or
   * question outlives the bounded buffer.
   */
  private evicted: EvictedAttention = noAttention();
  /** Viewer subscription ids. */
  readonly subscribers = new Set<string>();
  evictTimer: unknown;
  /** Aborts the stream's current connection; owned by the manager. */
  controller: AbortController | undefined;
  /** Changes whenever the manager restarts the stream loop. */
  loop = 0;

  constructor(
    readonly hostId: string,
    readonly key: string,
    readonly target: PeerRunTarget,
    openAfter: number,
  ) {
    this.runId = "runId" in target ? target.runId : null;
    this.chatId = "chatId" in target ? target.chatId : null;
    this.cursor = openAfter;
    this.floor = openAfter;
  }

  /** A chat target moved on to a newer run: start its buffer from scratch. */
  switchRun(runId: string): void {
    if (this.runId === runId) return;
    this.runId = runId;
    this.cursor = 0;
    this.floor = 0;
    this.ended = false;
    this.buffer = [];
    this.bytes = 0;
    this.evicted = noAttention();
  }

  /** True when the event is new and was buffered for delivery. */
  accept(event: PeerRunEvent): boolean {
    if (this.runId !== null && event.streamId !== this.runId) return false;
    // A chat target learns its run from the first event; the caller's cursor
    // already referred to that chat's current run.
    if (this.runId === null) this.runId = event.streamId;
    const chatId = event.payload.chatId;
    if (this.chatId === null && typeof chatId === "string" && CHAT_ID.test(chatId))
      this.chatId = chatId;
    if (event.type === "run.ended") {
      // `run.ended` repeats the terminal event's sequence; it is new once.
      if (this.ended || event.sequence < this.cursor) return false;
      this.ended = true;
    } else if (event.type === "snapshot") {
      if (event.sequence < this.cursor) return false;
      // The host summarised a gap: what came before it is not replayable.
      if (event.payload.reason === "gap") {
        this.buffer = [];
        this.bytes = 0;
        this.floor = event.sequence - 1;
        // The snapshot itself carries what was pending before it.
        this.evicted = noAttention();
      }
    } else if (event.sequence <= this.cursor) return false;
    this.cursor = event.sequence;
    const bytes = JSON.stringify(event).length;
    this.buffer.push({ event, bytes });
    this.bytes += bytes;
    while (
      this.buffer.length > PEER_RUN_BUFFER_EVENTS ||
      (this.bytes > PEER_RUN_BUFFER_BYTES && this.buffer.length > 1)
    ) {
      const dropped = this.buffer.shift()!;
      this.bytes -= dropped.bytes;
      this.floor = Math.max(this.floor, dropped.event.sequence);
      foldAttention(this.evicted, dropped.event);
    }
    return true;
  }

  /**
   * What dropped events left pending, summarised as the host summarises a
   * gap. It is sent even when nothing is pending, so a viewer resubscribing
   * after a resolution it missed drops the prompt it still shows.
   */
  private evictedSnapshot(): PeerRunEvent | null {
    const { approvals, questions, last, settled } = this.evicted;
    if (!last || settled) return null;
    return {
      protocolVersion: last.protocolVersion,
      streamId: last.streamId,
      sequence: this.floor,
      timestamp: last.timestamp,
      type: "snapshot",
      terminal: false,
      payload: {
        reason: "gap",
        state: approvals.size > 0 ? "needs_approval" : questions.size > 0 ? "needs_input" : "working",
        approvals: [...approvals.values()],
        questions: [...questions.values()],
        nextSequence: this.floor + 1,
      },
    };
  }

  view(subscriptionId: string, afterSequence: number): PeerRunSubscription {
    const events = this.buffer
      .map((entry) => entry.event)
      .filter(
        (event) =>
          event.sequence > afterSequence ||
          (event.type === "run.ended" && event.sequence === afterSequence),
      );
    const truncated = afterSequence < this.floor;
    // Prompts dropped from the buffer may still be pending on the host.
    const summary = truncated ? this.evictedSnapshot() : null;
    return {
      subscriptionId,
      key: this.key,
      runId: this.runId,
      chatId: this.chatId,
      state: this.state,
      events: summary ? [summary, ...events] : events,
      truncated,
    };
  }
}

export interface PeerRunTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface Subscription {
  stream: PeerRunStream;
  owner: string;
}

/**
 * Ref-counted run streams shared by every window. A stream closes
 * `PEER_RUN_EVICT_MS` after its last viewer leaves, unless a viewer returns.
 */
export class PeerRunSubscriptions {
  private readonly streams = new Map<string, Map<string, PeerRunStream>>();
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly options: {
      timers: PeerRunTimers;
      /** Closes a stream's connection; called once when a stream is dropped. */
      onDrop(stream: PeerRunStream): void;
      /** Open host feeds, which share the global stream budget. */
      feeds(): number;
      evictAfterMs?: number;
    },
  ) {}

  get size(): number {
    let total = 0;
    for (const host of this.streams.values()) total += host.size;
    return total;
  }

  forHost(hostId: string): PeerRunStream[] {
    return [...(this.streams.get(hostId)?.values() ?? [])];
  }

  all(): PeerRunStream[] {
    return [...this.streams.values()].flatMap((host) => [...host.values()]);
  }

  acquire(
    hostId: string,
    target: PeerRunTarget,
    owner: string,
    afterSequence: number,
  ): { subscriptionId: string; stream: PeerRunStream; created: boolean } {
    const key = peerRunKey(target);
    let host = this.streams.get(hostId);
    let stream = host?.get(key);
    const created = !stream;
    if (!stream) {
      this.makeRoom(hostId);
      stream = new PeerRunStream(hostId, key, target, afterSequence);
      host ??= new Map();
      host.set(key, stream);
      this.streams.set(hostId, host);
    }
    if (stream.evictTimer !== undefined) {
      this.options.timers.clear(stream.evictTimer);
      stream.evictTimer = undefined;
    }
    const subscriptionId = randomUUID();
    stream.subscribers.add(subscriptionId);
    this.subscriptions.set(subscriptionId, { stream, owner });
    return { subscriptionId, stream, created };
  }

  /** Only the owning document may release its own subscription. */
  release(subscriptionId: string, owner: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || subscription.owner !== owner) return false;
    this.subscriptions.delete(subscriptionId);
    const { stream } = subscription;
    stream.subscribers.delete(subscriptionId);
    if (stream.subscribers.size === 0 && stream.evictTimer === undefined) {
      stream.evictTimer = this.options.timers.set(() => {
        stream.evictTimer = undefined;
        if (stream.subscribers.size === 0) this.drop(stream);
      }, this.options.evictAfterMs ?? PEER_RUN_EVICT_MS);
    }
    return true;
  }

  releaseOwner(owner: string): void {
    for (const [id, subscription] of [...this.subscriptions])
      if (subscription.owner === owner) this.release(id, owner);
  }

  dropHost(hostId: string): void {
    for (const stream of this.forHost(hostId)) this.drop(stream);
  }

  close(): void {
    for (const stream of this.all()) this.drop(stream);
  }

  private drop(stream: PeerRunStream): void {
    const host = this.streams.get(stream.hostId);
    if (host?.get(stream.key) !== stream) return;
    host.delete(stream.key);
    if (host.size === 0) this.streams.delete(stream.hostId);
    if (stream.evictTimer !== undefined) this.options.timers.clear(stream.evictTimer);
    stream.evictTimer = undefined;
    for (const id of stream.subscribers) this.subscriptions.delete(id);
    stream.subscribers.clear();
    this.options.onDrop(stream);
  }

  /** Close an idle stream (no viewers, awaiting eviction) before refusing a new one. */
  private makeRoom(hostId: string): void {
    const hostFull = (this.streams.get(hostId)?.size ?? 0) >= PEER_LIVE_RUNS_PER_HOST;
    const totalFull = this.size + this.options.feeds() >= PEER_LIVE_STREAMS_TOTAL;
    if (!hostFull && !totalFull) return;
    const candidates = (hostFull ? this.forHost(hostId) : this.all()).filter(
      (stream) => stream.subscribers.size === 0,
    );
    if (candidates.length === 0) throw new PeerRunLimitError();
    this.drop(candidates[0]!);
  }
}
