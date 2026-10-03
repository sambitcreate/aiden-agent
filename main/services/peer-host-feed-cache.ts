import { PeerTransportError } from "./peer-transport.js";
import type {
  PeerFeedRow,
  PeerHostFeedChange,
  PeerHostFeedSnapshot,
  PeerRunEvent,
  PeerRunState,
} from "../../renderer/shared/peer-host.js";

/** At most this many chats are kept per host; the oldest by `updatedAt` go first. */
export const PEER_FEED_MAX_CHATS = 2_000;
export const PEER_FEED_MAX_WORKSPACES = 500;
export const PEER_FEED_MAX_BOTS = 500;
export const PEER_FEED_MAX_RUNS = 2_000;

const ROW_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const EPOCH = /^[A-Za-z0-9_-]{1,64}$/u;
const RUN_STATE = /^[a-z_]{1,32}$/u;

function malformed(): never {
  throw new PeerTransportError("invalid_response");
}

function row(value: unknown): PeerFeedRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string" || !ROW_ID.test(id)) malformed();
  return value as PeerFeedRow;
}

function rows(value: unknown): PeerFeedRow[] {
  if (!Array.isArray(value)) malformed();
  return value.map(row);
}

function runState(value: unknown): PeerRunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const { chatId, runId, state, unread } = value as Record<string, unknown>;
  if (
    typeof chatId !== "string" ||
    !ROW_ID.test(chatId) ||
    typeof runId !== "string" ||
    !ROW_ID.test(runId) ||
    typeof state !== "string" ||
    !RUN_STATE.test(state) ||
    typeof unread !== "boolean"
  )
    malformed();
  return { chatId, runId, state, unread };
}

function updatedAt(item: PeerFeedRow): number {
  const value = Date.parse(String(item.updatedAt ?? ""));
  return Number.isFinite(value) ? value : 0;
}

/** Newest-first ordering by `updatedAt`, ties by id so eviction is deterministic. */
function newestFirst(left: PeerFeedRow, right: PeerFeedRow): number {
  return updatedAt(right) - updatedAt(left) || (left.id < right.id ? -1 : 1);
}

function capChats(items: PeerFeedRow[]): PeerFeedRow[] {
  return items.length <= PEER_FEED_MAX_CHATS
    ? items
    : [...items].sort(newestFirst).slice(0, PEER_FEED_MAX_CHATS);
}

interface PendingSnapshot {
  epoch: string;
  sequence: number;
  summaries: PeerFeedRow[];
  workspaces: PeerFeedRow[];
  bots: PeerFeedRow[];
}

/**
 * The bounded, last-known projection of one host's `/host/events` feed.
 * Pure: it consumes validated envelopes and returns the changes to broadcast.
 */
export class PeerHostFeedCache {
  epoch: string | null = null;
  sequence = 0;
  stale = false;
  private summaries = new Map<string, PeerFeedRow>();
  private workspaces = new Map<string, PeerFeedRow>();
  private bots = new Map<string, PeerFeedRow>();
  /** Insertion-ordered so the least recently updated run is evicted first. */
  private runs = new Map<string, PeerRunState>();
  private pending: PendingSnapshot | undefined;

  constructor(readonly hostId: string) {}

  /** `Last-Event-ID` for the next connection, once a snapshot has completed. */
  cursor(): string | undefined {
    return this.epoch === null ? undefined : `${this.epoch}:${this.sequence}`;
  }

  /** A reconnect restarts any snapshot that was mid-delivery. */
  abandonPartial(): void {
    this.pending = undefined;
  }

  snapshot(): PeerHostFeedSnapshot {
    return {
      hostId: this.hostId,
      epoch: this.epoch,
      sequence: this.sequence,
      stale: this.stale,
      summaries: [...this.summaries.values()],
      workspaces: [...this.workspaces.values()],
      bots: [...this.bots.values()],
      runs: [...this.runs.values()],
    };
  }

  run(runId: string): PeerRunState | undefined {
    return this.runs.get(runId);
  }

  runForChat(chatId: string): PeerRunState | undefined {
    let latest: PeerRunState | undefined;
    for (const run of this.runs.values()) if (run.chatId === chatId) latest = run;
    return latest;
  }

  markStale(stale: boolean): PeerHostFeedChange[] {
    if (this.stale === stale) return [];
    this.stale = stale;
    return [{ type: "stale", stale }];
  }

  apply(event: PeerRunEvent): PeerHostFeedChange[] {
    if (event.streamId !== "host") malformed();
    if (event.type === "snapshot") return this.applySnapshot(event);
    // Nothing is incremental before the first complete snapshot.
    if (this.epoch === null || this.pending) malformed();
    // Replays and Bot-only entries this device cannot see make sequences
    // repeat or jump; only strictly newer entries apply.
    if (event.sequence <= this.sequence) return [];
    this.sequence = event.sequence;
    const payload = event.payload;
    switch (event.type) {
      case "chat.upsert":
        return this.upsertChat(row(payload));
      case "workspace.upsert":
        return this.upsertBounded(this.workspaces, row(payload), PEER_FEED_MAX_WORKSPACES, "workspace.upsert");
      case "bot.upsert":
        return this.upsertBounded(this.bots, row(payload), PEER_FEED_MAX_BOTS, "bot.upsert");
      case "chat.remove":
        return this.remove(this.summaries, row(payload).id, "chat.remove");
      case "workspace.remove":
        return this.remove(this.workspaces, row(payload).id, "workspace.remove");
      case "bot.remove":
        return this.remove(this.bots, row(payload).id, "bot.remove");
      case "run.state": {
        const run = runState(payload);
        this.runs.delete(run.runId);
        this.runs.set(run.runId, run);
        if (this.runs.size > PEER_FEED_MAX_RUNS)
          this.runs.delete(this.runs.keys().next().value!);
        return [{ type: "run.state", run }];
      }
      default:
        // A newer host may add feed vocabulary; skip it without losing position.
        return [];
    }
  }

  private applySnapshot(event: PeerRunEvent): PeerHostFeedChange[] {
    const payload = event.payload;
    const epoch = payload.epoch;
    if (
      typeof epoch !== "string" ||
      !EPOCH.test(epoch) ||
      payload.sequence !== event.sequence ||
      (payload.partial !== undefined && payload.partial !== true)
    )
      malformed();
    if (
      this.pending &&
      (this.pending.epoch !== epoch || this.pending.sequence !== event.sequence)
    )
      this.pending = undefined;
    const pending = (this.pending ??= {
      epoch,
      sequence: event.sequence,
      summaries: [],
      workspaces: [],
      bots: [],
    });
    pending.summaries.push(...rows(payload.summaries));
    // Hold at most twice the cap while chunks stream in, trimming to the newest.
    if (pending.summaries.length > 2 * PEER_FEED_MAX_CHATS)
      pending.summaries = capChats(pending.summaries);
    pending.workspaces.push(...rows(payload.workspaces));
    pending.workspaces.length = Math.min(pending.workspaces.length, PEER_FEED_MAX_WORKSPACES);
    pending.bots.push(...rows(payload.bots));
    pending.bots.length = Math.min(pending.bots.length, PEER_FEED_MAX_BOTS);
    // A partial chunk never moves the cursor; a reconnect replays the snapshot whole.
    if (payload.partial === true) return [];
    this.pending = undefined;
    // Run states are not in snapshots: a new epoch is a new host process whose
    // runs are unknown, while a same-epoch resync keeps what it already learned.
    if (epoch !== this.epoch) this.runs.clear();
    this.epoch = epoch;
    this.sequence = event.sequence;
    this.summaries = new Map(capChats(pending.summaries).map((item) => [item.id, item]));
    this.workspaces = new Map(pending.workspaces.map((item) => [item.id, item]));
    this.bots = new Map(pending.bots.map((item) => [item.id, item]));
    const snapshot = this.snapshot();
    return [
      {
        type: "reset",
        summaries: snapshot.summaries,
        workspaces: snapshot.workspaces,
        bots: snapshot.bots,
        runs: snapshot.runs,
      },
    ];
  }

  private upsertChat(item: PeerFeedRow): PeerHostFeedChange[] {
    this.summaries.set(item.id, item);
    if (this.summaries.size <= PEER_FEED_MAX_CHATS)
      return [{ type: "chat.upsert", row: item }];
    let oldest: PeerFeedRow | undefined;
    for (const candidate of this.summaries.values())
      if (!oldest || newestFirst(candidate, oldest) > 0) oldest = candidate;
    this.summaries.delete(oldest!.id);
    // The upsert itself may be the oldest chat; then nothing visible changed.
    return oldest!.id === item.id
      ? []
      : [
          { type: "chat.upsert", row: item },
          { type: "chat.remove", id: oldest!.id },
        ];
  }

  private upsertBounded(
    target: Map<string, PeerFeedRow>,
    item: PeerFeedRow,
    max: number,
    type: "workspace.upsert" | "bot.upsert",
  ): PeerHostFeedChange[] {
    if (!target.has(item.id) && target.size >= max) return [];
    target.set(item.id, item);
    return [{ type, row: item }];
  }

  private remove(
    target: Map<string, PeerFeedRow>,
    id: string,
    type: "chat.remove" | "workspace.remove" | "bot.remove",
  ): PeerHostFeedChange[] {
    return target.delete(id) ? [{ type, id }] : [];
  }
}
