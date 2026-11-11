// The set of followed pull requests: starting and stopping a follow, the
// polling loop that reads each one when it is due, and turning each read's
// news into chat notices. Reads run one at a time so a slow GitHub never
// stacks requests.
//
// Besides the timed sweep, a nudge asks for a follow to be read soon because
// something Aiden did or saw may have changed it: a push, a `gh` command, the
// person opening the follow, or the app coming back to the foreground or the
// network. Nudges are debounced and coalesced per follow, so a burst of them
// costs one read, and they never read a follow more often than its minimum
// interval or before a rate limit lifts.

import {
  MAX_PULL_REQUEST_FOLLOWS_PER_CHAT,
  type PullRequestFollowView,
} from "../../../renderer/shared/follow-through.js";
import {
  FOLLOW_POLL_SETTLED_MS,
  checksNeedingLogs,
  evaluateFollow,
  followKey,
  followMayProbe,
  followReadFailed,
  followStayedQuiet,
  followUnavailable,
  followUnchanged,
  followView,
  newFollowRecord,
  stopFollow,
  type FollowNotice,
  type PullRequestFollowRecord,
} from "./pull-request-follow.js";
import type { FollowReadResult, PullRequestFollowReader } from "./pull-request-follow-github.js";

/** Followed pull requests across every chat. */
export const MAX_PULL_REQUEST_FOLLOWS = 20;
/** Ended follows each chat keeps showing. */
const MAX_ENDED_PER_CHAT = 3;
const TICK_MS = 30_000;
/** A nudge waits this long for more to arrive and for GitHub to catch up. */
export const FOLLOW_NUDGE_DEBOUNCE_MS = 5_000;
/** A stream of nudges still reads within this long of the first. */
export const FOLLOW_NUDGE_MAX_WAIT_MS = 30_000;
/** After Aiden's own push or comment, or the person opening the follow: no sooner than this after the last read. */
export const FOLLOW_NUDGE_ACTION_INTERVAL_MS = 30_000;
/**
 * After the app regains focus, wakes or comes back online: no sooner than
 * this after the last read, the settled sweep's own cadence, so switching
 * windows never reads a quiet pull request more often than the sweep did.
 */
export const FOLLOW_NUDGE_AMBIENT_INTERVAL_MS = FOLLOW_POLL_SETTLED_MS;

/** Why a follow should be read soon. `ambient` nudges come from focus, wake and network, not from a change Aiden made. */
export type FollowNudgeKind = "action" | "ambient";

interface PendingNudge {
  first: number;
  last: number;
  interval: number;
}

export interface FollowTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: FollowTimers = {
  set(run, ms) {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface PullRequestFollowsDeps {
  reader: Pick<PullRequestFollowReader, "read" | "jobLogTail">;
  post(chatId: string, notice: FollowNotice): void;
  persist(records: PullRequestFollowRecord[]): void;
  onChange?(chatId: string): void;
  /** Whether this chat's agent was mid-answer at `at`, so a comment then is its own. */
  chatWasAnswering(chatId: string, at: number): boolean;
  now(): number;
  log?(message: string, error?: unknown): void;
  /** One-shot timers for nudges; the system's by default. */
  timers?: FollowTimers;
}

export interface StartFollowInput {
  chatId: string;
  host: string;
  repository: string;
  number: number;
  url: string;
  title?: string;
  startedBy: "agent" | "person";
}

export class PullRequestFollows {
  private readonly records = new Map<string, PullRequestFollowRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private readonly pausedChats = new Set<string>();
  private pollInFlight?: { id: string; controller: AbortController };
  private readonly nudges = new Map<string, PendingNudge>();
  private nudgeTimer: { handle: unknown; at: number } | undefined;

  constructor(private readonly deps: PullRequestFollowsDeps) {}

  private get timers(): FollowTimers {
    return this.deps.timers ?? systemTimers;
  }

  private static id(chatId: string, key: string): string {
    return `${chatId}\u0000${key}`;
  }

  restore(records: readonly PullRequestFollowRecord[]): void {
    for (const record of records) {
      if (record?.version !== 1 || typeof record.chatId !== "string" || typeof record.repository !== "string") continue;
      this.records.set(PullRequestFollows.id(record.chatId, followKey(record)), { ...record });
    }
  }

  list(chatId: string): PullRequestFollowView[] {
    return [...this.records.values()]
      .filter((record) => record.chatId === chatId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(followView);
  }

  all(): PullRequestFollowRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Start following, or keep following if this chat already does. Reads it right away. */
  follow(input: StartFollowInput): PullRequestFollowView {
    if (this.closed) throw new Error("Aiden is closing.");
    const key = followKey(input);
    const id = PullRequestFollows.id(input.chatId, key);
    const existing = this.records.get(id);
    if (existing?.state === "following") return followView(existing);
    const active = [...this.records.values()].filter((record) => record.state === "following");
    if (active.filter((record) => record.chatId === input.chatId).length >= MAX_PULL_REQUEST_FOLLOWS_PER_CHAT) {
      throw new Error(`This chat already follows ${MAX_PULL_REQUEST_FOLLOWS_PER_CHAT} pull requests. Stop one first.`);
    }
    if (active.length >= MAX_PULL_REQUEST_FOLLOWS) {
      throw new Error(`Aiden already follows ${MAX_PULL_REQUEST_FOLLOWS} pull requests. Stop one first.`);
    }
    const record = newFollowRecord({ ...input, now: this.deps.now() });
    this.records.set(id, record);
    this.pruneEnded(input.chatId);
    this.changed(input.chatId);
    this.kick();
    return followView(record);
  }

  stop(chatId: string, key: { host: string; repository: string; number: number }, reason: "person" | "agent" | "access-changed"): boolean {
    const id = PullRequestFollows.id(chatId, followKey(key));
    const record = this.records.get(id);
    if (!record || record.state !== "following") return false;
    if (this.pollInFlight?.id === id) this.pollInFlight.controller.abort();
    this.records.set(id, stopFollow(record, reason, this.deps.now()));
    this.nudges.delete(id);
    this.armNudgeTimer();
    this.changed(chatId);
    return true;
  }

  /** Suspend polling across a workspace mutation without losing its saved follows. */
  pauseChats(chatIds: readonly string[]): () => void {
    for (const chatId of chatIds) this.pausedChats.add(chatId);
    const poll = this.pollInFlight;
    const current = poll && this.records.get(poll.id);
    if (current && this.pausedChats.has(current.chatId)) poll?.controller.abort();
    return () => {
      for (const chatId of chatIds) this.pausedChats.delete(chatId);
      void this.kick();
    };
  }

  deleteChat(chatId: string): void {
    let removed = false;
    for (const [id, record] of this.records) {
      if (record.chatId === chatId) {
        if (this.pollInFlight?.id === id) this.pollInFlight.controller.abort();
        this.records.delete(id);
        this.nudges.delete(id);
        removed = true;
      }
    }
    if (!removed) return;
    this.armNudgeTimer();
    this.changed(chatId);
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.timer.unref?.();
    this.kick();
  }

  shutdown(): void {
    this.closed = true;
    this.pollInFlight?.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.nudges.clear();
    this.armNudgeTimer();
  }

  /**
   * Read this chat's followed pull requests soon: all of them, or the ones
   * `which` picks. Returns how many were nudged.
   */
  nudge(
    chatId: string,
    kind: FollowNudgeKind,
    which: (follow: Pick<PullRequestFollowRecord, "host" | "repository" | "number">) => boolean = () => true,
  ): number {
    return this.nudgeWhere((record) => record.chatId === chatId && which(record), kind);
  }

  /** Read every followed pull request soon, e.g. when the app is back in front or online. */
  nudgeAll(kind: FollowNudgeKind): number {
    return this.nudgeWhere(() => true, kind);
  }

  private nudgeWhere(match: (record: PullRequestFollowRecord) => boolean, kind: FollowNudgeKind): number {
    if (this.closed) return 0;
    const now = this.deps.now();
    const interval = kind === "action" ? FOLLOW_NUDGE_ACTION_INTERVAL_MS : FOLLOW_NUDGE_AMBIENT_INTERVAL_MS;
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.state !== "following" || !match(record)) continue;
      const pending = this.nudges.get(id);
      this.nudges.set(id, pending
        ? { first: pending.first, last: now, interval: Math.min(pending.interval, interval) }
        : { first: now, last: now, interval });
      count += 1;
    }
    if (count) this.armNudgeTimer();
    return count;
  }

  /** When a nudge reads this follow: after its debounce, its minimum interval and any rate-limit hold. */
  private nudgeDueAt(record: PullRequestFollowRecord, nudge: PendingNudge): number {
    return Math.max(
      Math.min(nudge.last + FOLLOW_NUDGE_DEBOUNCE_MS, nudge.first + FOLLOW_NUDGE_MAX_WAIT_MS),
      (record.lastCheckedAt ?? Number.NEGATIVE_INFINITY) + nudge.interval,
      record.holdUntil ?? Number.NEGATIVE_INFINITY,
    );
  }

  /** When this follow is next due: its timed read, or a nudge, whichever is first. */
  private dueAt(id: string, record: PullRequestFollowRecord): number {
    const nudge = this.nudges.get(id);
    return nudge ? Math.min(record.nextCheckAt, this.nudgeDueAt(record, nudge)) : record.nextCheckAt;
  }

  /** One timer for the soonest nudge; nudges for ended or forgotten follows are dropped. */
  private armNudgeTimer(): void {
    let soonest = Number.POSITIVE_INFINITY;
    if (!this.closed) {
      for (const [id, nudge] of this.nudges) {
        const record = this.records.get(id);
        if (record?.state !== "following") {
          this.nudges.delete(id);
          continue;
        }
        if (this.pausedChats.has(record.chatId)) continue;
        soonest = Math.min(soonest, this.nudgeDueAt(record, nudge));
      }
    }
    if (this.nudgeTimer && this.nudgeTimer.at === soonest) return;
    if (this.nudgeTimer) this.timers.clear(this.nudgeTimer.handle);
    this.nudgeTimer = undefined;
    if (!Number.isFinite(soonest)) return;
    const handle = this.timers.set(() => {
      if (this.nudgeTimer?.handle === handle) this.nudgeTimer = undefined;
      void this.kick();
    }, Math.max(0, soonest - this.deps.now()));
    this.nudgeTimer = { handle, at: soonest };
  }

  /** Read every follow that is due, one at a time. */
  kick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ticking ??= this.tick().finally(() => {
      this.ticking = undefined;
      this.armNudgeTimer();
    });
    return this.ticking;
  }

  private async tick(): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      const due = [...this.records.entries()]
        .filter(([id, record]) => record.state === "following" && !this.pausedChats.has(record.chatId) && this.dueAt(id, record) <= now)
        .sort(([leftId, left], [rightId, right]) => this.dueAt(leftId, left) - this.dueAt(rightId, right))[0];
      if (!due || this.closed) return;
      const [id, record] = due;
      const controller = new AbortController();
      this.pollInFlight = { id, controller };
      // A nudge that arrives while this read runs is not served by it, and
      // neither is one still inside its debounce: a timed read that came due
      // first may be too early to see the change the nudge is about.
      const pending = this.nudges.get(id);
      const served = pending && this.nudgeDueAt(record, pending) <= now ? pending : undefined;
      try {
        await this.poll(id, record, controller.signal);
        if (served && this.nudges.get(id) === served) this.nudges.delete(id);
      } catch (error) {
        if (served && this.nudges.get(id) === served) this.nudges.delete(id);
        if (controller.signal.aborted) continue;
        this.deps.log?.("A followed pull request could not be read.", error);
        const current = this.records.get(id);
        if (current === record) {
          this.records.set(id, followReadFailed(record, "Aiden could not read this pull request.", this.deps.now()));
          this.changed(record.chatId);
        }
      } finally {
        this.pollInFlight = undefined;
      }
    }
  }

  private async poll(id: string, record: PullRequestFollowRecord, signal: AbortSignal): Promise<void> {
    // While a check fails, every read must be a full one (the failure clock
    // decides, not a change), so skip the probe and its requests entirely.
    const probe = record.failingSince === undefined
      ? { ...(record.etags ? { etags: record.etags } : {}), skipIfUnchanged: followMayProbe(record, this.deps.now()) }
      : undefined;
    const read: FollowReadResult = await this.deps.reader.read(record, signal, probe);
    // Stopped or deleted while the read was in flight.
    if (signal.aborted || this.records.get(id) !== record) return;
    if (read.kind === "unchanged") {
      // GitHub said nothing moved: no logs, no evaluation, no notices.
      this.records.set(id, followUnchanged(record, this.deps.now()));
      this.changed(record.chatId);
      return;
    }
    if (read.kind === "gone") {
      this.records.set(id, followUnavailable(record, read.message, this.deps.now()));
      this.changed(record.chatId);
      return;
    }
    if (read.kind === "retry") {
      this.records.set(id, followReadFailed(record, read.message, this.deps.now(), read.retryAt));
      this.changed(record.chatId);
      return;
    }
    const observation = {
      ...read.observation,
      comments: read.observation.comments.map((comment) =>
        comment.byViewer && this.deps.chatWasAnswering(record.chatId, comment.createdAt)
          ? { ...comment, ownEcho: true }
          : comment,
      ),
    };
    const logs = new Map<string, string>();
    for (const check of checksNeedingLogs(record, observation)) {
      if (signal.aborted) return;
      const tail = await this.deps.reader.jobLogTail(record, check, signal).catch(() => undefined);
      if (tail) logs.set(check.name, tail);
    }
    if (signal.aborted || this.records.get(id) !== record) return;
    const now = this.deps.now();
    const evaluation = evaluateFollow(record, observation, logs, now);
    // The probe said nothing moved and the full read agreed: still quiet.
    let next = (read.probedUnchanged ? followStayedQuiet(record, evaluation, now) : evaluation).record;
    if (next.state === "following" && read.etags && Object.keys(read.etags).length) {
      next = { ...next, etags: read.etags, etagsAt: now };
    } else if (next.etags || next.etagsAt !== undefined) {
      next = { ...next };
      delete next.etags;
      delete next.etagsAt;
    }
    this.records.set(id, next);
    if (next.state === "ended") this.pruneEnded(record.chatId);
    this.changed(record.chatId);
    for (const notice of evaluation.notices) this.deps.post(record.chatId, notice);
  }

  private pruneEnded(chatId: string): void {
    const ended = [...this.records.entries()]
      .filter(([, record]) => record.chatId === chatId && record.state === "ended")
      .sort(([, left], [, right]) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
    for (const [id] of ended.slice(MAX_ENDED_PER_CHAT)) this.records.delete(id);
  }

  private changed(chatId: string): void {
    this.deps.persist(this.all());
    this.deps.onChange?.(chatId);
  }
}
