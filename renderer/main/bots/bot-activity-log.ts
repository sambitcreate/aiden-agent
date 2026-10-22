// The side panel's Activity tab (spec §8): every step of every reply, newest
// reply first, grouped under the message or routine that started it. Built
// from the transcript tool calls slice B enriched, whose details are already
// redacted; read-only. One pass over the transcript, no rescans per reply.

import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botSettleSteps, type BotRecapStep } from "./bot-activity-steps";
import { walkBotTurns, type BotTurn } from "./bot-turns";

export interface BotActivityReply {
  id: string;
  /** The person's message, shortened, or the routine's name. */
  title: string;
  routine: boolean;
  at?: number;
  steps: BotRecapStep[];
}

export const BOT_ACTIVITY_TITLE_CHARS = 60;

/** Enough of a message to fill a title after its spaces collapse; a huge message is never copied whole. */
const TITLE_SCAN_UNITS = BOT_ACTIVITY_TITLE_CHARS * 4;

function shortTitle(text: string, fallback: string): string {
  const start = text.trimStart();
  const clipped = start.length > TITLE_SCAN_UNITS;
  // A cut can split an emoji; drop the half left at the end.
  const line = start.slice(0, TITLE_SCAN_UNITS).replace(/\s+/gu, " ").trim().replace(/[\uD800-\uDBFF]$/u, "");
  if (!line) return fallback;
  const points = [...line];
  if (points.length <= BOT_ACTIVITY_TITLE_CHARS && !clipped) return line;
  return `${points.slice(0, BOT_ACTIVITY_TITLE_CHARS - 1).join("").trimEnd()}…`;
}

/** What started the turn, as a group title. */
function replyTitle(start: BotTurn["start"]): { title: string; routine: boolean } {
  switch (start.type) {
    case "user": {
      const photos = start.imageCount === 1 ? "Photo" : `${start.imageCount} photos`;
      return { title: shortTitle(start.text, start.imageCount > 0 ? photos : "Message"), routine: false };
    }
    case "question_answer":
      return { title: shortTitle(start.text, "Answer"), routine: false };
    case "handoff_result":
      return { title: "Hand-off", routine: false };
    case "routine":
      return { title: shortTitle(start.label, "Routine"), routine: true };
    default:
      // A reply with no visible input (the self-intro) still gets a group.
      return { title: "Reply", routine: false };
  }
}

/** Newest reply first; steps in the order they ran; a reply with no steps is left out. */
export function botActivityLog(
  entries: readonly BotTranscriptEntry[],
  { running }: { running: boolean },
): BotActivityReply[] {
  const log: BotActivityReply[] = [];
  // Same turns as the chat; only the reply still open is live.
  walkBotTurns(entries, running, {
    end(turn, live) {
      // Asking the person a question is not an action, as in the chat recap.
      const steps = turn.steps.filter((step) => step.kind !== "waiting");
      if (steps.length === 0) return;
      log.push({
        id: turn.start.id,
        ...replyTitle(turn.start),
        ...(turn.startAt === undefined ? {} : { at: turn.startAt }),
        steps: live ? steps : botSettleSteps(steps, turn.stopped || turn.interrupted),
      });
    },
  });
  return log.reverse();
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
