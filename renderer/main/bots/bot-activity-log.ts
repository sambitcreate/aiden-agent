// The side panel's Activity tab (spec §8): every step of every reply, newest
// reply first, grouped under the message or routine that started it. Built
// from the transcript tool calls slice B enriched, whose details are already
// redacted; read-only. One pass over the transcript, no rescans per reply.

import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botSettleSteps, botStepFromCall, type BotRecapStep } from "./bot-activity-steps";

export interface BotActivityReply {
  id: string;
  /** The person's message, shortened, or the routine's name. */
  title: string;
  routine: boolean;
  at?: number;
  steps: BotRecapStep[];
}

export const BOT_ACTIVITY_TITLE_CHARS = 60;

interface OpenReply extends BotActivityReply {
  byCall: Map<string, BotRecapStep>;
  /** The person pressed Stop during this reply. */
  stopped: boolean;
  /** The app restarted mid-reply; a call with no result was cut short, not failed. */
  interrupted: boolean;
}

function shortTitle(text: string, fallback: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (!line) return fallback;
  const points = [...line];
  return points.length > BOT_ACTIVITY_TITLE_CHARS
    ? `${points.slice(0, BOT_ACTIVITY_TITLE_CHARS - 1).join("").trimEnd()}…`
    : line;
}

function openReply(id: string, title: string, routine: boolean, at: number | undefined): OpenReply {
  return {
    id,
    title,
    routine,
    ...(at === undefined ? {} : { at }),
    steps: [],
    byCall: new Map(),
    stopped: false,
    interrupted: false,
  };
}

/** Newest reply first; steps in the order they ran; a reply with no steps is left out. */
export function botActivityLog(
  entries: readonly BotTranscriptEntry[],
  { running }: { running: boolean },
): BotActivityReply[] {
  const replies: OpenReply[] = [];
  // Held in an object so the closure below does not narrow it to `never`.
  const state: { current: OpenReply | null } = { current: null };

  const begin = (id: string, title: string, routine: boolean, at: number | undefined) => {
    state.current = openReply(id, title, routine, at);
    replies.push(state.current);
  };

  // Same reading as the chat: a run that carries on after a stop marker was
  // cut short by a restart, not stopped by the person.
  const carriedOn = (reply: OpenReply) => {
    if (!reply.stopped) return;
    reply.stopped = false;
    reply.interrupted = true;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "user": {
        const photos = entry.imageCount === 1 ? "Photo" : `${entry.imageCount} photos`;
        begin(entry.id, shortTitle(entry.text, entry.imageCount > 0 ? photos : "Message"), false, entry.at);
        break;
      }
      case "question_answer":
        begin(entry.id, shortTitle(entry.text, "Answer"), false, entry.at);
        break;
      case "routine":
        begin(entry.id, entry.label, true, entry.at);
        break;
      case "assistant": {
        // A reply with no visible input (the self-intro) still gets a group.
        if (!state.current) begin(entry.id, "Reply", false, entry.at);
        const reply = state.current!;
        for (const call of entry.toolCalls) {
          // Asking the person a question is not an action, as in the chat recap.
          if (call.kind === "waiting") continue;
          const step = botStepFromCall(call);
          reply.steps.push(step);
          reply.byCall.set(call.id, step);
        }
        if (entry.stopReason === "aborted") reply.stopped = true;
        else carriedOn(reply);
        break;
      }
      case "tool_result": {
        const reply = state.current;
        const step = reply?.byCall.get(entry.toolCallId);
        if (step) step.status = entry.status;
        if (entry.status === "stopped" && reply) reply.stopped = true;
        break;
      }
      case "notice": {
        const reply = state.current;
        if (entry.notice === "interrupted" && reply) {
          reply.stopped = false;
          reply.interrupted = true;
        }
        state.current = null;
        break;
      }
      case "failed_turn":
        if (state.current) carriedOn(state.current);
        break;
      default:
        break;
    }
  }

  const liveId = running ? replies[replies.length - 1]?.id : undefined;
  const log: BotActivityReply[] = [];
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const { byCall: _byCall, stopped, interrupted, ...reply } = replies[index]!;
    if (reply.steps.length === 0) continue;
    log.push({
      ...reply,
      steps: reply.id === liveId ? reply.steps : botSettleSteps(reply.steps, stopped || interrupted),
    });
  }
  return log;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Today, 6:41 PM", "Yesterday, 9:05 AM", "Oct 6, 7:00 PM"; "Earlier" when the time is unknown. */
export function formatBotActivityWhen(at: number | undefined, now: number): string {
  if (at === undefined) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  const time = clock.format(at);
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${day.format(at)}, ${time}`;
}
