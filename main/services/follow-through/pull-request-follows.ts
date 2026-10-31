// The set of followed pull requests: starting and stopping a follow, the
// polling loop that reads each one when it is due, and turning each read's
// news into chat notices. Reads run one at a time so a slow GitHub never
// stacks requests.

import {
  MAX_PULL_REQUEST_FOLLOWS_PER_CHAT,
  type PullRequestFollowView,
} from "../../../renderer/shared/follow-through.js";
import {
  checksNeedingLogs,
  evaluateFollow,
  followKey,
  followReadFailed,
  followUnavailable,
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

export interface PullRequestFollowsDeps {
  reader: Pick<PullRequestFollowReader, "read" | "jobLogTail">;
  post(chatId: string, notice: FollowNotice): void;
  persist(records: PullRequestFollowRecord[]): void;
  onChange?(chatId: string): void;
  /** Whether this chat's agent was mid-answer at `at`, so a comment then is its own. */
  chatWasAnswering(chatId: string, at: number): boolean;
  now(): number;
  log?(message: string, error?: unknown): void;
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

  constructor(private readonly deps: PullRequestFollowsDeps) {}

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

  stop(chatId: string, key: { host: string; repository: string; number: number }, reason: "person" | "agent"): boolean {
    const id = PullRequestFollows.id(chatId, followKey(key));
    const record = this.records.get(id);
    if (!record || record.state !== "following") return false;
    this.records.set(id, stopFollow(record, reason, this.deps.now()));
    this.changed(chatId);
    return true;
  }

  deleteChat(chatId: string): void {
    let removed = false;
    for (const [id, record] of this.records) {
      if (record.chatId === chatId) {
        this.records.delete(id);
        removed = true;
      }
    }
    if (removed) this.changed(chatId);
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.timer.unref?.();
    this.kick();
  }

  shutdown(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Read every follow that is due, one at a time. */
  kick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ticking ??= this.tick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async tick(): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      const due = [...this.records.entries()]
        .filter(([, record]) => record.state === "following" && record.nextCheckAt <= now)
        .sort(([, left], [, right]) => left.nextCheckAt - right.nextCheckAt)[0];
      if (!due || this.closed) return;
      const [id, record] = due;
      try {
        await this.poll(id, record);
      } catch (error) {
        this.deps.log?.("A followed pull request could not be read.", error);
        const current = this.records.get(id);
        if (current === record) {
          this.records.set(id, followReadFailed(record, "Aiden could not read this pull request.", this.deps.now()));
          this.changed(record.chatId);
        }
      }
    }
  }

  private async poll(id: string, record: PullRequestFollowRecord): Promise<void> {
    const read: FollowReadResult = await this.deps.reader.read(record);
    // Stopped or deleted while the read was in flight.
    if (this.records.get(id) !== record) return;
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
      const tail = await this.deps.reader.jobLogTail(record, check).catch(() => undefined);
      if (tail) logs.set(check.name, tail);
    }
    if (this.records.get(id) !== record) return;
    const evaluation = evaluateFollow(record, observation, logs, this.deps.now());
    this.records.set(id, evaluation.record);
    if (evaluation.record.state === "ended") this.pruneEnded(record.chatId);
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
