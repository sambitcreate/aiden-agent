// Tells a lead chat when the chats it started finish (docs/plans/proactive-aiden-plan.md,
// Phase 5, D4). A turn the lead started that ends (done, stopped, failed or
// interrupted) is recorded on its link as owed, then posted to the lead as a
// `chat` notice through `NoticeDelivery`: queued into a running lead, or
// waking an idle one within the hourly wake budget. Chats that end within 10
// seconds of each other share one notice. A run the lead already got back
// from `wait`, or stopped itself, is never told again. Waiting for an approval
// or an answer never ends a turn, so it never wakes the lead.
//
// After the person presses Stop in the lead, notices are only recorded, never
// waking it, until the person next sends there.

import { agentNotice, fenceAsData, type AgentNoticeTone } from "../../../renderer/shared/agent-notices.js";
import type { AgentNoticeOutcome, AgentNoticePost } from "../follow-through/notice-delivery.js";
import type { ChildChatRunEnded } from "./child-chats.js";
import type { ChatLink, ChatLinkRunEnd, ChatLinkStore } from "./links.js";

/** Chats that end within this long of the first share one notice. */
export const CHILD_COMPLETION_GROUP_MS = 10_000;
/** The most of a reply a notice carries; the lead reads the rest with `child_chats read`. */
export const CHILD_COMPLETION_REPLY_CHARS = 4_000;

export interface ChildChatCompletionDeps {
  links: Pick<ChatLinkStore, "restore" | "get" | "update">;
  post(post: AgentNoticePost): Promise<AgentNoticeOutcome>;
  /** The started chat's newest assistant reply, if any. */
  lastReply(chatId: string): Promise<string | undefined>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  onError?(error: unknown): void;
}

const END_WORDS: Readonly<Record<ChatLinkRunEnd, string>> = {
  done: "finished",
  stopped: "was stopped",
  failed: "stopped with an error",
  interrupted: "was interrupted",
};

export class ChildChatCompletions {
  private readonly groups = new Map<string, { timer: unknown; chats: Set<string> }>();
  private readonly quiet = new Set<string>();

  constructor(private readonly deps: ChildChatCompletionDeps) {}

  /** A lead-started turn in a started chat ended. Never rejects. */
  async runEnded(event: ChildChatRunEnded): Promise<void> {
    try {
      await this.deps.links.restore();
      const link = this.deps.links.get(event.chatId);
      if (!link || link.leadChatId !== event.leadChatId || link.runId !== event.runId) return;
      if (link.delivered?.includes(event.runId)) return;
      await this.deps.links.update(event.chatId, (draft) => {
        draft.owed = { runId: event.runId, end: event.end, at: this.deps.now() };
      });
      const group = this.groups.get(event.leadChatId);
      if (group) {
        group.chats.add(event.chatId);
        return;
      }
      const chats = new Set([event.chatId]);
      const timer = this.deps.setTimer(() => void this.flush(event.leadChatId), CHILD_COMPLETION_GROUP_MS);
      this.groups.set(event.leadChatId, { timer, chats });
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  /** The person pressed Stop in the lead: its notices only record until they next send. */
  quietLead(leadChatId: string): void {
    this.quiet.add(leadChatId);
  }

  /** The person sent in the lead: notices may wake it again. */
  resumeLead(leadChatId: string): void {
    this.quiet.delete(leadChatId);
  }

  isQuiet(leadChatId: string): boolean {
    return this.quiet.has(leadChatId);
  }

  /** Posts the lead's grouped notice now. The timer calls this; tests may too. */
  async flush(leadChatId: string): Promise<AgentNoticeOutcome | undefined> {
    const group = this.groups.get(leadChatId);
    if (!group) return undefined;
    this.groups.delete(leadChatId);
    this.deps.clearTimer(group.timer);
    try {
      const owed: Array<ChatLink & { owed: NonNullable<ChatLink["owed"]> }> = [];
      for (const chatId of group.chats) {
        const link = this.deps.links.get(chatId);
        // `wait` may have returned it in the meantime.
        if (link?.owed && !link.delivered?.includes(link.owed.runId)) owed.push(link as (typeof owed)[number]);
      }
      if (owed.length === 0) return undefined;
      const replies = await Promise.all(owed.map((link) => this.deps.lastReply(link.childChatId).catch(() => undefined)));
      const outcome = await this.deps.post({
        chatId: leadChatId,
        notice: noticeFor(owed),
        text: noticeText(owed, replies),
        wake: !this.quiet.has(leadChatId),
      });
      if (outcome.kind !== "dropped") {
        for (const link of owed) {
          await this.deps.links.update(link.childChatId, (draft) => {
            if (!draft.delivered?.includes(link.owed.runId)) draft.delivered = [...(draft.delivered ?? []), link.owed.runId];
            if (draft.owed?.runId === link.owed.runId) delete draft.owed;
          });
        }
      }
      return outcome;
    } catch (error) {
      this.deps.onError?.(error);
      return undefined;
    }
  }
}

function noticeFor(links: ReadonlyArray<ChatLink & { owed: NonNullable<ChatLink["owed"]> }>) {
  const troubled = links.some((link) => link.owed.end === "failed" || link.owed.end === "interrupted");
  const tone: AgentNoticeTone = troubled ? "failure" : links.every((link) => link.owed.end === "done") ? "success" : "info";
  const title =
    links.length === 1
      ? `“${links[0]!.title}” ${END_WORDS[links[0]!.owed.end]}`
      : `${links.length} started chats ${troubled ? "ended" : "finished"}`;
  const summary = links.length === 1 ? "" : links.map((link) => `${link.title}: ${END_WORDS[link.owed.end]}`).join(" · ");
  return agentNotice({ source: "chat", tone, title, summary });
}

function noticeText(
  links: ReadonlyArray<ChatLink & { owed: NonNullable<ChatLink["owed"]> }>,
  replies: ReadonlyArray<string | undefined>,
): string {
  const parts = [links.length === 1 ? "A chat this chat started has ended." : "Chats this chat started have ended."];
  links.forEach((link, index) => {
    parts.push(`“${link.title}” (chat_id ${link.childChatId}) ${END_WORDS[link.owed.end]}.`);
    const reply = replies[index];
    if (reply) {
      const cut = [...reply].length > CHILD_COMPLETION_REPLY_CHARS;
      const text = cut ? [...reply].slice(0, CHILD_COMPLETION_REPLY_CHARS).join("") : reply;
      parts.push(fenceAsData(`Its last reply${cut ? " (cut; use child_chats read for the rest)" : ""}`, text));
    }
  });
  parts.push("Carry on with your task: read or send to these chats with child_chats, or tell the person what they found.");
  return parts.join("\n\n");
}
