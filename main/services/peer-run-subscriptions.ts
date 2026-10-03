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
    }
    return true;
  }

  view(subscriptionId: string, afterSequence: number): PeerRunSubscription {
    const events = this.buffer
      .map((entry) => entry.event)
      .filter(
        (event) =>
          event.sequence > afterSequence ||
          (event.type === "run.ended" && event.sequence === afterSequence),
      );
    return {
      subscriptionId,
      key: this.key,
      runId: this.runId,
      chatId: this.chatId,
      state: this.state,
      events,
      truncated: afterSequence < this.floor,
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
