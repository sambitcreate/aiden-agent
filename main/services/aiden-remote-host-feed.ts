import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  AIDEN_REMOTE_HOST_FEED_MAX_BYTES,
  AIDEN_REMOTE_HOST_FEED_MAX_EVENTS,
  AIDEN_REMOTE_HOST_FEED_SNAPSHOT_CHUNK_BYTES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  type AidenRemoteCapability,
  type AidenRemoteHostFeedEventType,
  type AidenRemoteRunState,
} from "./aiden-remote-protocol.js";
import type { AidenRemoteChatSummaryProjection } from "./aiden-remote-chats.js";
import type { AidenRemoteWorkspaceProjection } from "./aiden-remote-workspaces.js";
import { openCursorSse, sseFrame, type CursorSseHandle, type CursorSsePull } from "./aiden-remote-sse.js";
import type { HostRunSummary } from "./host-run-registry.js";
import { clipPendingAttentionSummary } from "../../renderer/shared/chat-pending-attention.js";
import type { BotLiveSummary } from "../../renderer/shared/bot-live.js";

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

/** A Bot row's revision-48 Inbox signals; each is present only when it holds. */
export interface AidenRemoteHostFeedBotSignals {
  /** An approval, a question, a hand-off or an open issue waits on the person. */
  needsYou?: true;
  /** The Bot's last turn was cut short, or its model cannot be used. */
  failed?: true;
  /** When the Bot's newest reply with visible text arrived, RFC 3339. */
  lastReplyAt?: string;
}

/** The Inbox signals of one Bot from its live summary; none when the summary is unknown. */
export function hostFeedBotSignals(
  live: Pick<BotLiveSummary, "state" | "needsYou" | "lastReplyAt"> | undefined,
): AidenRemoteHostFeedBotSignals {
  if (!live) return {};
  const failed = live.state.kind === "interrupted" || live.state.kind === "model_error";
  const replied = live.lastReplyAt !== null && Number.isSafeInteger(live.lastReplyAt) && live.lastReplyAt >= 0
    ? new Date(live.lastReplyAt)
    : undefined;
  return {
    ...(live.needsYou ? { needsYou: true as const } : {}),
    ...(failed ? { failed: true as const } : {}),
    ...(replied && Number.isFinite(replied.getTime()) ? { lastReplyAt: replied.toISOString() } : {}),
  };
}

/** One transcript-free read of everything the feed projects. */
export interface AidenRemoteHostFeedState {
  /** Non-Bot chat summaries, exactly as `/chat-summaries` projects them. */
  summaries: readonly AidenRemoteChatSummaryProjection[];
  /** Bot-owned chats; their run states reach `bot:read` desktops only. */
  botChatIds: ReadonlySet<string>;
  workspaces: readonly AidenRemoteHostFeedWorkspace[];
  /** Bot rows as a desktop without `bot:handoffs` reads them (revision 35: no `paused`). */
  bots: readonly AidenRemoteHostFeedBot[];
  /**
   * The same Bots as a `bot:handoffs` desktop reads them (revision 37: a
   * paused Bot is `sessionState: "paused"` with `paused: true`). Absent means
   * every device reads `bots`.
   */
  handoffBots?: readonly AidenRemoteHostFeedBot[];
}

export interface AidenRemoteHostFeedSource {
  /**
   * Every item is a new object or one returned unchanged by an earlier read:
   * the feed serializes each item object once, so mutating a returned item in
   * place would hide that change.
   */
  read(): Promise<AidenRemoteHostFeedState>;
}

export interface AidenRemoteHostFeedDevice {
  id: string;
  capabilities: ReadonlySet<AidenRemoteCapability>;
  /** The device is sent revision-37 Bot rows: it holds `bot:handoffs` and the host serves it. */
  botHandoffs?: boolean;
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
  /** Item budget of one snapshot frame; tests lower it. */
  snapshotChunkBytes?: number;
  /** Fixed epoch for tests; random per process otherwise. */
  epoch?: string;
  /**
   * Revision 48: the bounded summary of what a waiting run asks (its oldest
   * approval summary or question text, at most `AIDEN_REMOTE_ATTENTION_SUMMARY_MAX`
   * characters). Only `runs:observe` desktops are sent it, on `run.state`.
   */
  attentionSummary?(runId: string): string | undefined;
  /**
   * Revision 48: the host's runs as they are now. After a `runs:observe`
   * device takes a snapshot, which carries no runs, it is sent a `run.state`
   * for each one still waiting, so a run that was waiting before it connected
   * still brings its `attentionSummary`.
   */
  liveRuns?(): readonly Pick<HostRunSummary, "chatId" | "runId" | "state">[];
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

/** Which desktops read an entry: every one, or only those with or without `bot:handoffs`. */
type Audience = "all" | "legacy" | "handoffs";

interface JournalEntry {
  sequence: number;
  frame: string;
  /** The same event for a `runs:observe` device, when it carries more (revision 48). */
  observerFrame?: string;
  bytes: number;
  botOnly: boolean;
  audience: Audience;
  /** Sent only to this `runs:observe` device: a waiting run re-announced after its snapshot. */
  deviceId?: string;
}

interface RunStateChange {
  chatId: string;
  runId: string;
  state: AidenRemoteRunState;
}

const MAX_FRAMES_PER_PULL = 64;

function isWaiting(state: string): boolean {
  return state === "needs_approval" || state === "needs_input";
}

/** The shared one-line clip, at most `AIDEN_REMOTE_ATTENTION_SUMMARY_MAX` characters; undefined when empty. */
function clipAttentionSummary(text: string | undefined): string | undefined {
  return clipPendingAttentionSummary(text) || undefined;
}
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
  /**
   * The Bot rows each device last opened the feed with, and the head when it
   * switched to them: a cursor older than that belongs to the other rows.
   */
  private readonly audiences = new Map<string, { audience: Audience; since: number }>();
  private closed = false;
  private readonly serializedItems = new WeakMap<object, string>();

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
   *
   * `admit` is the caller's revocation fence. It runs synchronously after the
   * refresh and immediately before the subscription becomes visible to
   * `revokeDevice`, and throws when the device lost its authorization while
   * the refresh was awaited. Nothing is written to `response` in that case.
   */
  async open(
    device: AidenRemoteHostFeedDevice,
    cursor: string | undefined,
    response: ServerResponse,
    admit: () => void = () => {},
  ): Promise<void> {
    await this.refresh();
    admit();
    const botVisible = device.capabilities.has("bot:read");
    const observer = device.capabilities.has("runs:observe");
    const audience: Audience = device.botHandoffs === true ? "handoffs" : "legacy";
    // A device that gained or lost `bot:handoffs` since its cursor read other
    // Bot rows: replaying from it would keep a paused Bot as it read before.
    // The switch advances the head, so every cursor from before it, including
    // one kept through a snapshot that never finished arriving, gets a snapshot.
    let record = this.audiences.get(device.id);
    if (record === undefined) {
      record = { audience, since: 0 };
    } else if (record.audience !== audience) {
      this.appendMarker();
      record = { audience, since: this.head };
    }
    this.audiences.set(device.id, record);
    let position = this.resumePosition(cursor);
    if (position !== undefined && position < record.since) position = undefined;
    /** Remaining frames of a snapshot being delivered one frame per pull. */
    let snapshot: string[] = [];
    const pull = (): CursorSsePull => {
      if (snapshot.length > 0) return { frames: [snapshot.shift()!] };
      if (position === undefined || position < this.floor) {
        position = this.head;
        snapshot = this.snapshotFrames(botVisible, audience);
        if (observer) {
          this.announceWaitingRuns(device.id, botVisible);
          // Only these re-announcements can have been trimmed past the snapshot.
          if (position < this.floor) position = this.floor;
        }
        return { frames: [snapshot.shift()!] };
      }
      const frames: string[] = [];
      for (
        let index = this.indexAfter(position);
        index < this.journal.length && frames.length < MAX_FRAMES_PER_PULL;
        index += 1
      ) {
        const entry = this.journal[index]!;
        position = entry.sequence;
        if (entry.frame === "") continue;
        if (entry.botOnly && !botVisible) continue;
        if (entry.audience !== "all" && entry.audience !== audience) continue;
        if (entry.deviceId !== undefined && (entry.deviceId !== device.id || !observer)) continue;
        frames.push(observer && entry.observerFrame !== undefined ? entry.observerFrame : entry.frame);
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
    // A change signalled while the opening refresh awaited its source was
    // refused by `schedule` (no subscriber yet); deliver it now.
    if (this.dirty) this.schedule();
  }

  /** Close every feed a revoked device holds. */
  revokeDevice(deviceId: string): void {
    this.audiences.delete(deviceId);
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
      this.diffBots(previous, next);
    }
    const runs = [...this.pendingRuns.values()];
    this.pendingRuns.clear();
    const summaries = new Map(next.summaries.map((summary) => [summary.id, summary]));
    for (const run of runs) {
      const event = this.runStateEvent(run, summaries, next.botChatIds);
      if (!event) continue;
      this.append("run.state", event.payload, event.botOnly, "all", event.observerPayload);
    }
    for (const owned of this.subscriptions.values()) {
      for (const handle of owned) handle.wake();
    }
  }

  /**
   * A run's `run.state` payloads: the plain one, and the `runs:observe` one
   * when it carries an `attentionSummary`. A chat outside every projection
   * (assistant workspace, deleted) is never announced.
   */
  private runStateEvent(
    run: RunStateChange,
    summaries: ReadonlyMap<string, AidenRemoteChatSummaryProjection>,
    botChatIds: ReadonlySet<string>,
  ): { payload: Record<string, unknown>; observerPayload?: Record<string, unknown>; botOnly: boolean } | undefined {
    const summary = summaries.get(run.chatId);
    const botOnly = !summary && botChatIds.has(run.chatId);
    if (!summary && !botOnly) return undefined;
    const payload = {
      chatId: run.chatId,
      runId: run.runId,
      state: run.state,
      unread: summary?.unread === true,
    };
    const attentionSummary = isWaiting(run.state)
      ? clipAttentionSummary(this.options.attentionSummary?.(run.runId))
      : undefined;
    return { payload, ...(attentionSummary ? { observerPayload: { ...payload, attentionSummary } } : {}), botOnly };
  }

  /**
   * Revision 48: a snapshot carries no runs, so right after one an observer
   * is sent a `run.state` for each run still waiting, as journal entries only
   * that device reads. Other devices skip their sequences.
   *
   * Cost: every observer (re)snapshot appends these entries to the one shared
   * journal, so a burst of reconnecting observers with many waiting runs uses
   * up retention that other devices' cursors rely on. Each pass is capped at
   * half the journal by count and by bytes, so one pass alone never trims a
   * cursor taken at the snapshot; repeated passes can still age a slow
   * device's cursor out, and that device then resnapshots as usual.
   */
  private announceWaitingRuns(deviceId: string, botVisible: boolean): void {
    const live = this.options.liveRuns?.();
    if (!live || live.length === 0) return;
    const state = this.state!;
    const summaries = new Map(state.summaries.map((summary) => [summary.id, summary]));
    let budget = Math.floor(this.maxEvents / 2);
    let byteBudget = Math.floor(this.maxBytes / 2);
    for (const run of live) {
      if (budget <= 0) break;
      if (!isWaiting(run.state)) continue;
      const event = this.runStateEvent(
        { chatId: run.chatId, runId: run.runId, state: run.state },
        summaries,
        state.botChatIds,
      );
      if (!event || (event.botOnly && !botVisible)) continue;
      const payload = event.observerPayload ?? event.payload;
      const bytes = Buffer.byteLength(this.frame(this.head + 1, "run.state", payload));
      if (bytes > byteBudget) break;
      this.append("run.state", payload, event.botOnly, "all", undefined, deviceId);
      budget -= 1;
      byteBudget -= bytes;
    }
  }

  private diff(
    kind: "chat" | "workspace",
    previous: readonly { id: string }[],
    next: readonly { id: string }[],
    botOnly: boolean,
  ): void {
    const before = new Map(previous.map((item) => [item.id, this.serialized(item)]));
    const seen = new Set<string>();
    for (const item of next) {
      seen.add(item.id);
      if (before.get(item.id) !== this.serialized(item)) {
        this.append(`${kind}.upsert`, item as unknown as Record<string, unknown>, botOnly);
      }
    }
    for (const id of before.keys()) {
      if (!seen.has(id)) this.append(`${kind}.remove`, { id }, botOnly);
    }
  }

  /**
   * Bot rows differ by audience only while a Bot is paused, so a change both
   * audiences read alike is one entry; otherwise each audience whose row
   * changed gets its own.
   */
  private diffBots(previous: AidenRemoteHostFeedState, next: AidenRemoteHostFeedState): void {
    const rows = (bots: readonly AidenRemoteHostFeedBot[]) =>
      new Map(bots.map((bot) => [bot.id, { bot, json: this.serialized(bot) }]));
    const before = { legacy: rows(previous.bots), handoffs: rows(previous.handoffBots ?? previous.bots) };
    const after = { legacy: rows(next.bots), handoffs: rows(next.handoffBots ?? next.bots) };
    const ids = new Set([...after.legacy.keys(), ...after.handoffs.keys(), ...before.legacy.keys(), ...before.handoffs.keys()]);
    for (const id of ids) {
      const changes = (["legacy", "handoffs"] as const).flatMap((audience) => {
        const was = before[audience].get(id);
        const now = after[audience].get(id);
        if (was?.json === now?.json) return [];
        return [{ audience, row: now }];
      });
      const [first, second] = changes;
      if (!first) continue;
      if (second && first.row?.json === second.row?.json) {
        this.appendBot(id, first.row?.bot, "all");
        continue;
      }
      for (const change of changes) this.appendBot(id, change.row?.bot, change.audience);
    }
  }

  /**
   * An item's JSON, computed once per object. The previous read's items were
   * serialized when they were the newest, and both Bot audiences usually
   * share row objects, so a refresh serializes each new item only once.
   */
  private serialized(item: object): string {
    let json = this.serializedItems.get(item);
    if (json === undefined) {
      json = JSON.stringify(item);
      this.serializedItems.set(item, json);
    }
    return json;
  }

  private appendBot(id: string, bot: AidenRemoteHostFeedBot | undefined, audience: Audience): void {
    if (bot) this.append("bot.upsert", bot as unknown as Record<string, unknown>, true, audience);
    else this.append("bot.remove", { id }, true, audience);
  }

  private append(
    type: Exclude<AidenRemoteHostFeedEventType, "snapshot">,
    payload: Record<string, unknown>,
    botOnly: boolean,
    audience: Audience = "all",
    observerPayload?: Record<string, unknown>,
    deviceId?: string,
  ): void {
    this.head += 1;
    const frame = this.frame(this.head, type, payload);
    const observerFrame = observerPayload ? this.frame(this.head, type, observerPayload) : undefined;
    const bytes = Buffer.byteLength(frame) + (observerFrame ? Buffer.byteLength(observerFrame) : 0);
    this.journal.push({
      sequence: this.head,
      frame,
      ...(observerFrame ? { observerFrame } : {}),
      bytes,
      botOnly,
      audience,
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
    this.journalBytes += bytes;
    this.trimJournal();
  }

  private trimJournal(): void {
    while (
      this.journal.length > this.maxEvents ||
      (this.journalBytes > this.maxBytes && this.journal.length > 0)
    ) {
      const dropped = this.journal.shift()!;
      this.journalBytes -= dropped.bytes;
      this.floor = dropped.sequence;
    }
  }

  /** An entry no device is sent: it only moves the head past every earlier cursor. */
  private appendMarker(): void {
    this.head += 1;
    this.journal.push({ sequence: this.head, frame: "", bytes: 0, botOnly: false, audience: "all" });
    this.trimJournal();
  }

  private truncateJournal(): void {
    this.journal.length = 0;
    this.journalBytes = 0;
  }

  /**
   * The snapshot at the current head as one or more frames. Items are packed
   * in order (summaries, workspaces, Bots) up to the chunk budget. Every frame
   * but the last carries `partial: true` and no SSE id, so a reader that
   * disconnects mid-snapshot resumes from its previous cursor; the last frame
   * carries the `<epoch>:<sequence>` id. A host that fits in one chunk sends
   * exactly one frame without `partial`.
   */
  private snapshotFrames(botVisible: boolean, audience: Audience): string[] {
    const state = this.state!;
    const bots = audience === "handoffs" ? (state.handoffBots ?? state.bots) : state.bots;
    const budget = this.options.snapshotChunkBytes ?? AIDEN_REMOTE_HOST_FEED_SNAPSHOT_CHUNK_BYTES;
    const sections = {
      summaries: state.summaries,
      workspaces: state.workspaces,
      bots: botVisible ? bots : [],
    } as const;
    type Section = keyof typeof sections;
    const empty = (): Record<Section, unknown[]> => ({ summaries: [], workspaces: [], bots: [] });
    const chunks: Record<Section, unknown[]>[] = [];
    let current = empty();
    let bytes = 0;
    for (const section of ["summaries", "workspaces", "bots"] as const) {
      for (const item of sections[section]) {
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes > 0 && bytes + size > budget) {
          chunks.push(current);
          current = empty();
          bytes = 0;
        }
        current[section].push(item);
        bytes += size;
      }
    }
    chunks.push(current);
    return chunks.map((chunk, index) => {
      const final = index === chunks.length - 1;
      return this.frame(this.head, "snapshot", {
        epoch: this.epoch,
        sequence: this.head,
        ...chunk,
        ...(final ? {} : { partial: true }),
      }, final);
    });
  }

  private frame(
    sequence: number,
    type: AidenRemoteHostFeedEventType,
    payload: Record<string, unknown>,
    withId = true,
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
    return sseFrame(withId ? `${this.epoch}:${sequence}` : undefined, type, wire);
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
