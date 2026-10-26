// Delivers follow-up notices to a chat. A running turn takes the notice as a
// queued follow-up, so the agent reads it before it finishes. An idle chat is
// woken with a main-owned turn that nobody is watching, within an hourly
// budget; otherwise the notice is only recorded and the agent reads it with
// the person's next message. Notices for one chat are delivered in order.

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
  | { kind: "dropped"; reason: string };

export type QueueIntoRunResult =
  /** Nothing is running in the chat that takes input. */
  | { kind: "no-run" }
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
  append(post: AgentNoticePost): Promise<AppendResult>;
  waitForIdle(chatId: string): Promise<void>;
  now(): number;
  onError?(error: unknown): void;
}

/** Unattended turns one chat may start in an hour; more notices are only recorded. */
export const MAX_WAKES_PER_CHAT_PER_HOUR = 6;
const WAKE_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;

export class NoticeDelivery {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly wakes = new Map<string, number[]>();

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
    return this.record(post, "wake-unavailable");
  }

  private async wakeSaved(post: AgentNoticePost, messageId: string): Promise<AgentNoticeOutcome> {
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
      if (appended.kind === "gone") return { kind: "dropped", reason: appended.reason };
      // A turn started meanwhile: hand the notice to it instead.
      const queued = await this.deps.queueIntoRun(post);
      if (queued.kind === "queued") return { kind: "queued", messageId: queued.messageId };
      if (queued.kind === "saved") return { kind: "recorded", messageId: queued.messageId, reason };
      await this.deps.waitForIdle(post.chatId);
    }
    return { kind: "dropped", reason: "The chat stayed busy." };
  }

  private recordWake(chatId: string): void {
    this.wakes.set(chatId, [...this.recentWakes(chatId), this.deps.now()]);
  }
}
