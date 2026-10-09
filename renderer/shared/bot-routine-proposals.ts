// Bot-proposed routines: the Bot suggests, the person approves (spec 2026-10-09 §12).

import type { BotRoutineSchedule } from "./bot-routine-schedule.js";
export const BOT_ROUTINE_PROPOSAL_ENTRY_KIND = "aiden.routine-proposal";
export const BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND = "aiden.routine-proposal-status";
export type BotRoutineProposalStatus = "pending" | "accepted" | "dismissed";
export interface BotRoutineProposalEntryData {
  proposalId: string;           // UUID minted by the tool
  name: string;                 // ≤ BOT_ROUTINE_NAME_LIMIT
  prompt: string;               // ≤ BOT_ROUTINE_PROMPT_LIMIT
  schedule: BotRoutineSchedule;
  timezone: string;
  label: string;                // host label, e.g. "Every day at 9:00 AM"
  reason?: string;              // ≤ 280
}
export interface BotRoutineProposalStatusEntryData {
  proposalId: string;
  status: Exclude<BotRoutineProposalStatus, "pending">;
  routineId?: string;
}
export type BotRoutineProposalDecision = "accept" | "dismiss";
export interface BotRoutineProposalRespondInput {
  botId: string; proposalId: string; decision: BotRoutineProposalDecision;
}
export interface BotRoutineProposalRespondResult {
  status: Exclude<BotRoutineProposalStatus, "pending">; routineId?: string;
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
