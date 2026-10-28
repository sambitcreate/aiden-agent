// Turns noted promises into one-time routine proposals, behind the two-pending
// limit: the oldest waiting promise is proposed when a slot is free, and the
// next one when that proposal is answered. A promise past its date expires.

import type { BotRoutineCreateInput } from "../scheduled-bot-routines.js";
import { daysBetween, localDate, type BotCommitment, type BotCommitmentStore } from "./store.js";

export const BOT_COMMITMENT_DEFAULT_TIME = "09:00";
export const BOT_COMMITMENT_REASON = "You asked me to follow up on this.";

export function commitmentProposal(commitment: BotCommitment): Omit<BotRoutineCreateInput, "botId" | "timezone"> & { reason: string } {
  const short = [...commitment.text].length > 40 ? `${[...commitment.text].slice(0, 39).join("").trimEnd()}…` : commitment.text;
  return {
    name: `Follow up: ${short}`,
    schedule: { kind: "once", date: commitment.dueDate, time: commitment.dueTime ?? BOT_COMMITMENT_DEFAULT_TIME },
    prompt: `Follow up on: ${commitment.text}. Check whether it is done and tell the person briefly. If there is nothing to say, reply [SILENT].`,
    reason: BOT_COMMITMENT_REASON,
  };
}

export interface BotCommitmentProposerDependencies {
  commitments: BotCommitmentStore;
  proposals: {
    propose(
      botId: string,
      input: { name: string; schedule: unknown; prompt: string; reason?: string; hostFollowUp?: boolean },
    ): Promise<{ ok: true; proposal: { proposalId: string } } | { ok: false; code: string; error: string }>;
    pendingCount(botId: string): Promise<number>;
    /** Settle a still-open follow-up card whose day has passed. */
    dismiss?(botId: string, proposalId: string): Promise<void>;
  };
  pendingLimit: number;
  timeZone(): string;
  now(): number;
}

export function createBotCommitmentProposer(dependencies: BotCommitmentProposerDependencies) {
  const pumping = new Map<string, Promise<void>>();

  async function pumpOnce(botId: string): Promise<void> {
    const today = localDate(dependencies.now(), dependencies.timeZone());
    const records = await dependencies.commitments.list(botId);
    for (const record of records) {
      const overdue = daysBetween(today, record.dueDate) < 0 ||
        (daysBetween(today, record.dueDate) === 0 && record.status === "waiting");
      if (!overdue) continue;
      if (record.status === "waiting") await dependencies.commitments.update(botId, record.id, { status: "expired" });
      // A follow-up card nobody answered by its day: settle it so it neither
      // fires late nor holds a pending slot.
      if (record.status === "proposed" && record.proposalId) {
        await dependencies.proposals.dismiss?.(botId, record.proposalId).catch(() => undefined);
        await dependencies.commitments.update(botId, record.id, { status: "expired" });
      }
    }
    let free = dependencies.pendingLimit - (await dependencies.proposals.pendingCount(botId));
    const waiting = records
      .filter((record) => record.status === "waiting" && daysBetween(today, record.dueDate) >= 1)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const record of waiting) {
      if (free <= 0) break;
      const outcome = await dependencies.proposals.propose(botId, { ...commitmentProposal(record), hostFollowUp: true });
      if (outcome.ok) {
        await dependencies.commitments.update(botId, record.id, { status: "proposed", proposalId: outcome.proposal.proposalId });
        free -= 1;
      } else if (outcome.code === "too_many_pending") {
        break;
      } else {
        // Declined before, cooling off, or an invalid date: the person won't see it.
        await dependencies.commitments.update(botId, record.id, { status: "expired" });
      }
    }
  }

  return {
    /** Propose what fits now; one pump per Bot at a time. */
    pump(botId: string): Promise<void> {
      const previous = pumping.get(botId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => pumpOnce(botId));
      pumping.set(botId, next);
      return next.finally(() => {
        if (pumping.get(botId) === next) pumping.delete(botId);
      });
    },
    async onProposalSettled(botId: string, proposalId: string, status: "accepted" | "dismissed"): Promise<void> {
      const record = (await dependencies.commitments.list(botId)).find((entry) => entry.proposalId === proposalId);
      if (record) await dependencies.commitments.update(botId, record.id, { status });
      await this.pump(botId);
    },
    /** The Bot revised a follow-up's card: the follow-up now waits on the new card. */
    async onProposalRevised(botId: string, replacedId: string, proposalId: string): Promise<void> {
      const record = (await dependencies.commitments.list(botId)).find((entry) => entry.proposalId === replacedId);
      if (record) await dependencies.commitments.update(botId, record.id, { proposalId });
    },
  };
}

export type BotCommitmentProposer = ReturnType<typeof createBotCommitmentProposer>;
