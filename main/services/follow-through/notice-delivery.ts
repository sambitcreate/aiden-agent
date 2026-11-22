// Delivers follow-up notices to a chat. A running turn takes the notice as a
// queued follow-up, so the agent reads it before it finishes. An idle chat is
// woken with a main-owned turn that nobody is watching, within an hourly
// budget; otherwise the notice is only recorded and the agent reads it with
// the person's next message. A run another feature owns (a scheduled task's)
// never takes a notice: delivery waits for it to settle, for at most
// `waitForRunToSettle`'s bound, then joins or wakes the chat's own turn. A run
// that still holds the chat after that keeps the notice waiting longer, for at
// most `waitForRunToEnd`'s bound (a day; nothing else ends a run that never
// does), and then the notice is only recorded, never woken; a chat still held
// then drops it, and says so through `onError`. While the chat has an active
// keep-going goal, a waking notice starts a goal round instead, which the
// person attends and which uses no wake budget. Notices for one chat are
// delivered in order. Delivery lives in memory: a notice still waiting when
// Aiden quits is lost, except a started chat's ending, which its link keeps
// owed until `ChildChatCompletions.recoverOwed` posts it at the next start.

import type { AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";

export interface AgentNoticePost {
  chatId: string;
  notice: AgentNoticeV1;
  /** Model-facing text; command output and GitHub text are already fenced as data. */
  text: string;
  /** Start a follow-up turn when the chat is idle. False only records the card. */
  wake: boolean;
}

export type AgentNoticeOutcome =
  | { kind: "queued"; messageId: string }
  | { kind: "woke"; messageId: string; streamId: string }
  | { kind: "recorded"; messageId: string; reason: "not-waking" | "wake-budget" | "wake-unavailable" }
  /** Not delivered. `gone`: the chat itself no longer exists, so a retry never could be. */
  | { kind: "dropped"; reason: string; gone?: true };

export type QueueIntoRunResult =
  /** Nothing is running in the chat that takes input. */
  | { kind: "no-run" }
  /**
   * A run another feature owns holds the chat (a scheduled task posting
   * there). It never reads notices, so its tools could not act on one: wait.
   */
  | { kind: "busy" }
  | { kind: "queued"; messageId: string }
  /** The run ended after the message was saved: it is in the transcript, unread. */
  | { kind: "saved"; messageId: string }
  | { kind: "rejected" };

export type StartTurnResult =
  | { kind: "started"; streamId: string; messageId?: string }
  /** Another turn holds the chat right now. */
  | { kind: "busy" }
  /**
   * The chat cannot take a follow-up turn (no model, a Bot, gone, access off).
   * `messageId` is set when the notice was saved before the turn failed.
   */
  | { kind: "unavailable"; reason: string; messageId?: string };

export type AppendResult = { kind: "appended"; messageId: string } | { kind: "busy" } | { kind: "gone"; reason: string };

export interface NoticeDeliveryDeps {
  queueIntoRun(post: AgentNoticePost): Promise<QueueIntoRunResult>;
  /**
   * Start an unattended turn. With `post`, its notice is appended first; without,
   * the newest saved message is already the notice to answer.
   */
  startTurn(chatId: string, post?: AgentNoticePost): Promise<StartTurnResult>;
  /**
   * While the chat has an active keep-going goal, a notice that would wake it
   * starts a goal round instead: attended, outside the hourly wake budget.
   * Undefined when the chat has no active goal, so the notice wakes as usual.
   */
  startGoalRound?(chatId: string, post?: AgentNoticePost): Promise<StartTurnResult | undefined>;
  append(post: AgentNoticePost): Promise<AppendResult>;
  waitForIdle(chatId: string): Promise<void>;
  /**
   * Waits, for as long as a whole run may take, until a run that holds the
   * chat settles. A notice waits like this at most once.
   */
  waitForRunToSettle(chatId: string): Promise<void>;
  /**
   * Waits, for at most a day, until a run that still holds the chat after
   * `waitForRunToSettle` settles. Runs have no time limit of their own, so
   * this bound is what keeps a stuck run from holding the chat's notices.
   */
  waitForRunToEnd(chatId: string): Promise<void>;
  now(): number;
  onError?(error: unknown): void;
}

/**
 * How the unattended follow-up turn runs. It declares the chat's tools so its
 * request extends the chat's cached prefix; the client refuses what nobody is
 * there to approve or watch (hooks, Computer Use, subagents) when the call
 * arrives, and never resolves a subagent's connector inventory for it.
 * The chat's own connectors stay withheld: declaring them would start MCP
 * connections in a run nobody started.
 */
export const UNATTENDED_FOLLOW_UP_GENERATION = Object.freeze({
  usageSource: "chat",
  unattended: true,
  allowMcpTools: false,
} as const);

/** Unattended turns one chat may start in an hour; more notices are only recorded. */
export const MAX_WAKES_PER_CHAT_PER_HOUR = 6;
const WAKE_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;

export class NoticeDelivery {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly wakes = new Map<string, number[]>();
  /** Chats whose notice is waiting out a run another feature owns, and how many such waits. */
  private readonly waitingOnRun = new Map<string, number>();

  constructor(private readonly deps: NoticeDeliveryDeps) {}

  /** Delivers after any earlier notice for the same chat. Never rejects. */
  post(post: AgentNoticePost): Promise<AgentNoticeOutcome> {
    const previous = this.chains.get(post.chatId) ?? Promise.resolve();
    const next = previous.then(() => this.deliver(post)).catch((error: unknown): AgentNoticeOutcome => {
      this.deps.onError?.(error);
      return { kind: "dropped", reason: error instanceof Error ? error.message : String(error) };
    });
    this.chains.set(post.chatId, next);
    void next.finally(() => {
      if (this.chains.get(post.chatId) === next) this.chains.delete(post.chatId);
    });
    return next;
  }

  /**
   * Runs `work` after any earlier notice for the chat, so a scheduled task
   * run's prompt keeps its place among notices. The chain waits only for
   * `work`, so keep it to admission, not a whole turn.
   */
  inOrder<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chatId) ?? Promise.resolve();
    const next = previous.then(work);
    const settled = next.catch(() => undefined);
    this.chains.set(chatId, settled);
    void settled.finally(() => {
      if (this.chains.get(chatId) === settled) this.chains.delete(chatId);
    });
    return next;
  }

  /**
   * A notice for the chat is on its way. Not while it waits out a run another
   * feature owns: that run already keeps the chat busy, and its settling is
   * what a keep-going goal looks again after.
   */
  hasPending(chatId: string): boolean {
    return this.chains.has(chatId) && !this.waitingOnRun.has(chatId);
  }

  private async waitOnRun(chatId: string, wait: (chatId: string) => Promise<void>): Promise<void> {
    this.waitingOnRun.set(chatId, (this.waitingOnRun.get(chatId) ?? 0) + 1);
    try {
      await wait(chatId);
    } finally {
      const left = (this.waitingOnRun.get(chatId) ?? 1) - 1;
      if (left > 0) this.waitingOnRun.set(chatId, left);
      else this.waitingOnRun.delete(chatId);
    }
  }

  /** Wakes left in the current hour for a chat. */
  wakesLeft(chatId: string): number {
    return MAX_WAKES_PER_CHAT_PER_HOUR - this.recentWakes(chatId).length;
  }

  private recentWakes(chatId: string): number[] {
    const since = this.deps.now() - WAKE_WINDOW_MS;
    const recent = (this.wakes.get(chatId) ?? []).filter((at) => at > since);
    if (recent.length > 0) this.wakes.set(chatId, recent);
    else this.wakes.delete(chatId);
    return recent;
  }

  private async deliver(post: AgentNoticePost): Promise<AgentNoticeOutcome> {
    let waitedOnRun = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const queued = await this.deps.queueIntoRun(post);
      if (queued.kind === "queued") return { kind: "queued", messageId: queued.messageId };
      if (queued.kind === "saved") {
        // Saved but the run had just ended: answer it with a turn of its own.
        return this.wakeSaved(post, queued.messageId);
      }
      if (queued.kind === "rejected") {
        await this.deps.waitForIdle(post.chatId);
        continue;
      }
      if (queued.kind === "busy") {
        if (!waitedOnRun) {
          waitedOnRun = true;
          await this.waitOnRun(post.chatId, (chatId) => this.deps.waitForRunToSettle(chatId));
          continue;
        }
        // Still held after the long wait: stay waiting until that run settles,
        // however long, then only record; the news is too old to wake for.
        await this.waitOnRun(post.chatId, (chatId) => this.deps.waitForRunToEnd(chatId));
        const recorded = await this.record(post, post.wake ? "wake-unavailable" : "not-waking");
        if (recorded.kind === "dropped" && !recorded.gone) {
          this.deps.onError?.(new Error("A notice waited a day for another run in its chat to end, and was dropped."));
        }
        return recorded;
      }
      const round = post.wake ? await this.deps.startGoalRound?.(post.chatId, post) : undefined;
      if (round) {
        if (round.kind === "started") return { kind: "woke", messageId: round.messageId ?? "", streamId: round.streamId };
        if (round.kind === "busy") {
          await this.deps.waitForIdle(post.chatId);
          continue;
        }
        if (round.messageId) return { kind: "recorded", messageId: round.messageId, reason: "wake-unavailable" };
        return this.record(post, "wake-unavailable");
      }
      if (post.wake && this.wakesLeft(post.chatId) > 0) {
        const started = await this.deps.startTurn(post.chatId, post);
        if (started.kind === "started") {
          this.recordWake(post.chatId);
          return { kind: "woke", messageId: started.messageId ?? "", streamId: started.streamId };
        }
        if (started.kind === "busy") {
          await this.deps.waitForIdle(post.chatId);
          continue;
        }
        if (started.messageId) return { kind: "recorded", messageId: started.messageId, reason: "wake-unavailable" };
        return this.record(post, "wake-unavailable");
      }
      return this.record(post, post.wake ? "wake-budget" : "not-waking");
    }
    return this.record(post, post.wake ? "wake-unavailable" : "not-waking");
  }

  private async wakeSaved(post: AgentNoticePost, messageId: string): Promise<AgentNoticeOutcome> {
    const round = post.wake ? await this.deps.startGoalRound?.(post.chatId) : undefined;
    if (round) {
      return round.kind === "started"
        ? { kind: "woke", messageId, streamId: round.streamId }
        : { kind: "recorded", messageId, reason: "wake-unavailable" };
    }
    if (!post.wake || this.wakesLeft(post.chatId) <= 0) {
      return { kind: "recorded", messageId, reason: post.wake ? "wake-budget" : "not-waking" };
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const started = await this.deps.startTurn(post.chatId);
      if (started.kind === "started") {
        this.recordWake(post.chatId);
        return { kind: "woke", messageId, streamId: started.streamId };
      }
      // Busy means someone else's turn now reads the saved notice anyway.
      if (started.kind === "busy") return { kind: "recorded", messageId, reason: "wake-unavailable" };
      break;
    }
    return { kind: "recorded", messageId, reason: "wake-unavailable" };
  }

  private async record(
    post: AgentNoticePost,
    reason: "not-waking" | "wake-budget" | "wake-unavailable",
  ): Promise<AgentNoticeOutcome> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const appended = await this.deps.append(post);
      if (appended.kind === "appended") return { kind: "recorded", messageId: appended.messageId, reason };
      if (appended.kind === "gone") return { kind: "dropped", reason: appended.reason, gone: true };
      // A turn started meanwhile: hand the notice to it instead.
      const queued = await this.deps.queueIntoRun(post);
      if (queued.kind === "queued") return { kind: "queued", messageId: queued.messageId };
      if (queued.kind === "saved") return { kind: "recorded", messageId: queued.messageId, reason };
      // Recording never waits out another feature's run: a short wait, then it gives up.
      await this.deps.waitForIdle(post.chatId);
    }
    return { kind: "dropped", reason: "The chat stayed busy." };
  }

  private recordWake(chatId: string): void {
    this.wakes.set(chatId, [...this.recentWakes(chatId), this.deps.now()]);
  }
}

/** A running generation, as far as notice routing cares. */
export interface NoticeRunCandidate {
  chatId: string;
  cancelRequested: boolean;
  /**
   * The chat's own turn: the person's, an owed turn, a follow-up or a goal
   * round. A scheduled task, Telegram, a Bot or the Assistant run their own way.
   */
  chatTurn: boolean;
}

/**
 * Where a notice for `chatId` goes now: into the chat's own running turn,
 * `"busy"` while a run another feature owns holds the chat, or undefined when
 * nothing runs there.
 */
export function agentNoticeRun(
  runs: Iterable<readonly [string, NoticeRunCandidate]>,
  chatId: string,
): { streamId: string } | "busy" | undefined {
  let busy = false;
  for (const [streamId, run] of runs) {
    if (run.chatId !== chatId || run.cancelRequested) continue;
    if (run.chatTurn) return { streamId };
    busy = true;
  }
  return busy ? "busy" : undefined;
}
