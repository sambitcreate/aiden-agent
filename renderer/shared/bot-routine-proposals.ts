// Bot-proposed routines: the Bot suggests, the person approves (spec 2026-10-09 §12).

import type { BotRoutineSchedule } from "./bot-routine-schedule.js";
import type { BotRoutineTrigger } from "./bot-routine-trigger.js";
/** The Bot's routine tool: list, propose and revise (an approval card) and pause. */
export const BOT_ROUTINES_TOOL_NAME = "routines";
/** At most this many proposals wait for an answer per Bot. */
export const BOT_ROUTINE_PROPOSAL_PENDING_LIMIT = 2;
export const BOT_ROUTINE_PROPOSAL_REASON_LIMIT = 280;
export const BOT_ROUTINE_PROPOSAL_ENTRY_KIND = "aiden.routine-proposal";
export const BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND = "aiden.routine-proposal-status";
export type BotRoutineProposalStatus = "pending" | "accepted" | "dismissed";
interface BotRoutineProposalEntryBase {
  proposalId: string;           // UUID minted by the tool
  name: string;                 // ≤ BOT_ROUTINE_NAME_LIMIT
  prompt: string;               // ≤ BOT_ROUTINE_PROMPT_LIMIT
  label: string;                // host label, e.g. "Every day at 9:00 AM"
  reason?: string;              // ≤ 280
}
/** A scheduled routine (runs at a time, in `timezone`) or an event routine (runs when `trigger` happens). */
export type BotRoutineProposalEntryData = BotRoutineProposalEntryBase & (
  | { schedule: BotRoutineSchedule; timezone: string; trigger?: never }
  | { trigger: BotRoutineTrigger; schedule?: never; timezone?: never }
);
export interface BotRoutineProposalStatusEntryData {
  proposalId: string;
  status: Exclude<BotRoutineProposalStatus, "pending">;
  routineId?: string;
  /** The Bot revised this card: the newer card replaces it, and this one can no longer be answered. */
  supersededBy?: string;
}

/** The person-readable name of a timezone, e.g. "Pacific Time"; the IANA id when there is none. */
export function botRoutineTimezoneName(timezone: string, at: Date = new Date()): string {
  if (/^(?:Etc\/)?(?:UTC|UCT|GMT|Zulu|Universal)$/iu.test(timezone)) return "UTC";
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    return name || timezone;
  } catch {
    return timezone;
  }
}

/** When a suggested routine runs, as its card says it: the time and its timezone, or what starts it. */
export function botRoutineProposalWhen(proposal: Pick<BotRoutineProposalEntryData, "label" | "timezone" | "trigger">): string {
  if (proposal.trigger || !proposal.timezone) return proposal.label;
  return `${proposal.label} · ${botRoutineTimezoneName(proposal.timezone)}`;
}
export type BotRoutineProposalDecision = "accept" | "dismiss";
/** Optional chips after Not now; skipping them is fine. */
export type BotRoutineProposalDeclineReason = "not_useful" | "wrong_time" | "already_have" | "other";
export const BOT_ROUTINE_PROPOSAL_DECLINE_REASONS: readonly BotRoutineProposalDeclineReason[] = [
  "not_useful", "wrong_time", "already_have", "other",
];
export const BOT_ROUTINE_PROPOSAL_DECLINE_LABELS: Record<BotRoutineProposalDeclineReason, string> = {
  not_useful: "Not useful",
  wrong_time: "Wrong time",
  already_have: "Already have this",
  other: "Something else",
};
export interface BotRoutineProposalRespondInput {
  botId: string; proposalId: string; decision: BotRoutineProposalDecision;
  /** Only with dismiss. */
  reason?: BotRoutineProposalDeclineReason;
}
/** What the Bot's `routines list` reports about past suggestions. */
export interface BotRoutineProposalDecisionSummary {
  name: string; label: string; status: "accepted" | "dismissed";
  reason?: BotRoutineProposalDeclineReason; decidedAt: number;
}
/** Backing off after the person keeps saying Not now (spec §6 P3). */
export const BOT_ROUTINE_PROPOSAL_COOLING = {
  window: 5, dismissals: 3, coolMs: 7 * 86_400_000, sameNameMs: 30 * 86_400_000, recent: 10,
} as const;
export interface BotRoutineProposalRespondResult {
  status: Exclude<BotRoutineProposalStatus, "pending">; routineId?: string;
  /**
   * Only on the desktop answer that just added a link routine: the link the
   * person can call, shown once like the profile's (null while Aiden On The
   * Go is off). Never sent to the Bot or to phones.
   */
  link?: string | null;
}
export const BOT_ROUTINE_PROPOSAL_CHANNELS = { respond: "bots:routineProposals:respond" } as const;
export interface BotRoutineSuggestion {
  id: "daily-check-in"; name: string; prompt: string; schedule: BotRoutineSchedule;
}
export const BOT_DAILY_CHECKIN_SUGGESTION: BotRoutineSuggestion = {
  id: "daily-check-in",
  name: "Daily check-in",
  schedule: { kind: "daily", time: "09:00" },
  prompt: "Check in briefly. Using what you remember about me and anything new you can see, share one or two things worth knowing today.",
};
