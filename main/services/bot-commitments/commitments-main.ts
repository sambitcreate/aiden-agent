// Production wiring of Bot follow-ups: the per-Bot store, the proposer that
// turns promises into one-time routine proposals, and the memory review's
// note_follow_up tool.

import { app, logger } from "../../platform.js";
import { BOT_ROUTINE_PROPOSAL_PENDING_LIMIT } from "../../../renderer/shared/bot-routine-proposals.js";
import type { MemoryReviewExtras } from "../bot-memory/review.js";
import { createBotCommitmentProposer } from "./proposer.js";
import { createBotCommitmentStore, localDate } from "./store.js";
import { NOTE_FOLLOW_UP_INSTRUCTIONS, createNoteFollowUpTool } from "./tool.js";

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const botCommitments = createBotCommitmentStore({ profileDir: () => app.getPath("userData"), timeZone });

export const botCommitmentProposer = createBotCommitmentProposer({
  commitments: botCommitments,
  proposals: {
    propose: async (botId, input) => (await import("../bot-routine-proposals-main.js")).botRoutineProposals.propose(botId, input),
    pendingCount: async (botId) => (await import("../bot-routine-proposals-main.js")).botRoutineProposals.pendingCount(botId),
  },
  pendingLimit: BOT_ROUTINE_PROPOSAL_PENDING_LIMIT,
  timeZone,
  now: Date.now,
});

function pump(botId: string): void {
  void botCommitmentProposer.pump(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} follow-up proposal failed.`, error));
}

/** The memory review's follow-up tool for one Bot, with today's date so due dates are real. */
export function commitmentReviewExtras(botId: string): MemoryReviewExtras {
  const today = new Date();
  const weekday = today.toLocaleDateString("en-US", { weekday: "long", timeZone: timeZone() });
  return {
    tools: [createNoteFollowUpTool({ botId, store: botCommitments, onAdded: pump })],
    instructions: [`Today is ${weekday}, ${localDate(today.getTime(), timeZone())}.`, ...NOTE_FOLLOW_UP_INSTRUCTIONS],
  };
}

/** A routine proposal was answered: settle its follow-up and propose the next one. */
export function commitmentProposalSettled(botId: string, proposalId: string, status: "accepted" | "dismissed"): void {
  void botCommitmentProposer.onProposalSettled(botId, proposalId, status).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} follow-up bookkeeping failed.`, error));
}
