import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  AIDEN_REMOTE_HOST_FEED_MAX_BYTES,
  AIDEN_REMOTE_HOST_FEED_MAX_EVENTS,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  type AidenRemoteCapability,
  type AidenRemoteHostFeedEventType,
  type AidenRemoteRunState,
} from "./aiden-remote-protocol.js";
import type { AidenRemoteChatSummaryProjection } from "./aiden-remote-chats.js";
import type { AidenRemoteWorkspaceProjection } from "./aiden-remote-workspaces.js";
import { openCursorSse, sseFrame, type CursorSseHandle, type CursorSsePull } from "./aiden-remote-sse.js";
import type { HostRunSummary } from "./host-run-registry.js";

/** Optional repository identity on a host-feed workspace (contract revision 19). */
export interface AidenRemoteRepositoryIdentity {
  /** Credential-free `host/owner/name` derived from the cached origin URL. */
  canonicalKey: string;
  /** POSIX path of the workspace folder inside the repository; `""` at the root. */
  relativePath: string;
}

export type AidenRemoteHostFeedWorkspace = AidenRemoteWorkspaceProjection & {
  repository?: AidenRemoteRepositoryIdentity;
};

export interface AidenRemoteHostFeedBot {
  id: string;
  [key: string]: unknown;
}

/** One transcript-free read of everything the feed projects. */
export interface AidenRemoteHostFeedState {
  /** Non-Bot chat summaries, exactly as `/chat-summaries` projects them. */
  summaries: readonly AidenRemoteChatSummaryProjection[];
  /** Bot-owned chats; their run states reach `bot:read` desktops only. */
  botChatIds: ReadonlySet<string>;
  workspaces: readonly AidenRemoteHostFeedWorkspace[];
  bots: readonly AidenRemoteHostFeedBot[];
}

export interface AidenRemoteHostFeedSource {
  read(): Promise<AidenRemoteHostFeedState>;
}

export interface AidenRemoteHostFeedDevice {
  id: string;
  capabilities: ReadonlySet<AidenRemoteCapability>;
}

export interface AidenRemoteHostFeedOptions {
  source: AidenRemoteHostFeedSource;
  now(): number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  /** Coalescing window for change signals while subscribers are attached. */
  debounceMs?: number;
  maxEvents?: number;
  maxBytes?: number;
  /** Fixed epoch for tests; random per process otherwise. */
  epoch?: string;
}

/** The `GET /host/events` envelope; `streamId` is always `host`. */
export interface AidenRemoteHostFeedEvent {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  streamId: "host";
  sequence: number;
  timestamp: string;
  type: AidenRemoteHostFeedEventType;
  terminal: false;
  payload: Record<string, unknown>;
}

interface JournalEntry {
  sequence: number;
  frame: string;
  bytes: number;
  botOnly: boolean;
}

interface RunStateChange {
  chatId: string;
  runId: string;
  state: AidenRemoteRunState;
}

const MAX_FRAMES_PER_PULL = 64;
const DEFAULT_DEBOUNCE_MS = 50;

/**
 * Host-wide change feed for paired desktop controllers. It never scans
 * transcripts: every refresh is one transcript-free `source.read()` diffed
 * against the previous read, and run states come from HostRunRegistry
 * change notifications. The journal is the only queue; a reader that falls
 * behind retention, or presents a cursor from another epoch, gets a fresh
 * snapshot instead of a replay.
 */
export class AidenRemoteHostFeedService {
  readonly epoch: string;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly journal: JournalEntry[] = [];
  private journalBytes = 0;
  private head = 0;
  /** Lowest cursor from which the journal still replays without a gap. */
  private floor = 0;
  private state: AidenRemoteHostFeedState | undefined;
  private dirty = true;
  private refreshChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingRuns = new Map<string, RunStateChange>();
  private readonly subscriptions = new Map<string, Set<CursorSseHandle>>();
  private closed = false;

  constructor(private readonly options: AidenRemoteHostFeedOptions) {
    this.epoch = options.epoch ?? randomBytes(9).toString("base64url");
    this.maxEvents = options.maxEvents ?? AIDEN_REMOTE_HOST_FEED_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? AIDEN_REMOTE_HOST_FEED_MAX_BYTES;
  }

  /** The current journal head, for diagnostics and tests. */
  get sequence(): number {
    return this.head;
  }

  /** Chats, workspaces or Bots may have changed. Cheap and safe to call often. */
  invalidate(): void {
    if (this.closed) return;
    this.dirty = true;
    this.schedule();
  }

  /** A HostRunRegistry change. Retired (evicted) runs add nothing new. */
  noteRun(summary: HostRunSummary, removed: boolean): void {
    if (this.closed || removed) return;
    this.pendingRuns.set(summary.runId, {
      chatId: summary.chatId,
      runId: summary.runId,
      state: summary.state,
    });
    if (this.pendingRuns.size > this.maxEvents) {
      // Nobody drained the queue for a long time: drop it and force every
      // existing cursor onto a snapshot rather than replay an incomplete gap.
      this.pendingRuns.clear();
      this.head += 1;
      this.floor = this.head;
      this.truncateJournal();
    }
    this.invalidate();
  }

  /**
   * Open `GET /host/events`. Always refreshes first, so a reconnecting reader
   * sees every change made while nobody was subscribed.
   */
  async open(
    device: AidenRemoteHostFeedDevice,
    cursor: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    await this.refresh();
    const botVisible = device.capabilities.has("bot:read");
    let position = this.resumePosition(cursor);
    const pull = (): CursorSsePull => {
      if (position === undefined || position < this.floor) {
        position = this.head;
        return { frames: [this.snapshotFrame(botVisible)] };
      }
      const frames: string[] = [];
      for (
        let index = this.indexAfter(position);
        index < this.journal.length && frames.length < MAX_FRAMES_PER_PULL;
        index += 1
      ) {
        const entry = this.journal[index]!;
        position = entry.sequence;
        if (entry.botOnly && !botVisible) continue;
        frames.push(entry.frame);
      }
      return { frames };
    };
    const handle = openCursorSse(response, {
      pull,
      heartbeatMs: this.options.heartbeatMs,
      drainTimeoutMs: this.options.drainTimeoutMs,
      onClose: () => {
        const owned = this.subscriptions.get(device.id);
        owned?.delete(handle);
        if (owned?.size === 0) this.subscriptions.delete(device.id);
      },
    });
    if (handle.closed) return;
    const owned = this.subscriptions.get(device.id) ?? new Set<CursorSseHandle>();
    owned.add(handle);
    this.subscriptions.set(device.id, owned);
    // A refresh that landed between the first pull and registration is not missed.
    handle.wake();
  }

  /** Close every feed a revoked device holds. */
  revokeDevice(deviceId: string): void {
    const owned = this.subscriptions.get(deviceId);
    if (!owned) return;
    this.subscriptions.delete(deviceId);
    for (const handle of [...owned]) handle.close();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const deviceId of [...this.subscriptions.keys()]) this.revokeDevice(deviceId);
  }

  /** Serialized, coalesced refresh. Exposed for tests and for `open`. */
  refresh(): Promise<void> {
    const run = this.refreshChain.then(() => this.refreshNow());
    this.refreshChain = run.catch(() => {});
    return run;
  }

  private schedule(): void {
    // Without subscribers the next `open` refreshes; nothing reads in between.
    if (this.timer || this.subscriptions.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => {
        // A failed read stays dirty; the next signal or open retries.
      });
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private async refreshNow(): Promise<void> {
    if (this.closed || (!this.dirty && this.state)) return;
    this.dirty = false;
    let next: AidenRemoteHostFeedState;
    try {
      next = await this.options.source.read();
    } catch (error) {
      this.dirty = true;
      throw error;
    }
    const previous = this.state;
    this.state = next;
    if (previous) {
      this.diff("chat", previous.summaries, next.summaries, false);
      this.diff("workspace", previous.workspaces, next.workspaces, false);
      this.diff("bot", previous.bots, next.bots, true);
    }
    const runs = [...this.pendingRuns.values()];
    this.pendingRuns.clear();
    const summaries = new Map(next.summaries.map((summary) => [summary.id, summary]));
    for (const run of runs) {
      const summary = summaries.get(run.chatId);
      const botOnly = !summary && next.botChatIds.has(run.chatId);
      // A chat outside every projection (assistant workspace, deleted) is never announced.
      if (!summary && !botOnly) continue;
      this.append("run.state", {
        chatId: run.chatId,
        runId: run.runId,
        state: run.state,
        unread: summary?.unread === true,
      }, botOnly);
    }
    for (const owned of this.subscriptions.values()) {
      for (const handle of owned) handle.wake();
    }
  }

  private diff(
    kind: "chat" | "workspace" | "bot",
    previous: readonly { id: string }[],
    next: readonly { id: string }[],
    botOnly: boolean,
  ): void {
    const before = new Map(previous.map((item) => [item.id, JSON.stringify(item)]));
    const seen = new Set<string>();
    for (const item of next) {
      seen.add(item.id);
      if (before.get(item.id) !== JSON.stringify(item)) {
        this.append(`${kind}.upsert`, item as unknown as Record<string, unknown>, botOnly);
      }
    }
    for (const id of before.keys()) {
      if (!seen.has(id)) this.append(`${kind}.remove`, { id }, botOnly);
    }
  }

  private append(
    type: Exclude<AidenRemoteHostFeedEventType, "snapshot">,
    payload: Record<string, unknown>,
    botOnly: boolean,
  ): void {
    this.head += 1;
    const frame = this.frame(this.head, type, payload);
    const bytes = Buffer.byteLength(frame);
    this.journal.push({ sequence: this.head, frame, bytes, botOnly });
    this.journalBytes += bytes;
    while (
      this.journal.length > this.maxEvents ||
      (this.journalBytes > this.maxBytes && this.journal.length > 0)
    ) {
      const dropped = this.journal.shift()!;
      this.journalBytes -= dropped.bytes;
      this.floor = dropped.sequence;
    }
  }

  private truncateJournal(): void {
    this.journal.length = 0;
    this.journalBytes = 0;
  }

  private snapshotFrame(botVisible: boolean): string {
    const state = this.state!;
    return this.frame(this.head, "snapshot", {
      epoch: this.epoch,
      sequence: this.head,
      summaries: state.summaries,
      workspaces: state.workspaces,
      bots: botVisible ? state.bots : [],
    });
  }

  private frame(
    sequence: number,
    type: AidenRemoteHostFeedEventType,
    payload: Record<string, unknown>,
  ): string {
    const wire: AidenRemoteHostFeedEvent = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      streamId: "host",
      sequence,
      timestamp: new Date(this.options.now()).toISOString(),
      type,
      terminal: false,
      payload,
    };
    return sseFrame(`${this.epoch}:${sequence}`, type, wire);
  }

  /** A replayable cursor position, or undefined when the reader needs a snapshot. */
  private resumePosition(cursor: string | undefined): number | undefined {
    if (cursor === undefined) return undefined;
    const match = /^([A-Za-z0-9_-]{1,64}):(0|[1-9]\d{0,14})$/u.exec(cursor);
    if (!match || match[1] !== this.epoch) return undefined;
    const sequence = Number(match[2]);
    if (sequence > this.head || sequence < this.floor) return undefined;
    return sequence;
  }

  private indexAfter(position: number): number {
    const first = this.journal[0]?.sequence;
    if (first === undefined) return 0;
    return Math.max(0, position - first + 1);
  }
}
