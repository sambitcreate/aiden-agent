import type { BotPlans } from "../bot-plans/plans.js";
import type { BotAccessRequests } from "./bot-access-requests.js";
// "Needs you" in the Bots sidebar follows a Bot's questions, approvals,
// hand-offs, access requests, plans and host-raised issues as they appear and settle. This wires the
// stores' change hooks to one notification that carries only the Bot id: the
// renderer re-reads that Bot's summary, so no question, approval, hand-off or
// issue text ever travels on this channel.

import type { BotApprovals } from "./bot-approvals.js";
import type { BotHandoffs } from "./bot-handoffs.js";
import type { BotQuestions } from "./bot-questions.js";
import type { BotIssueService } from "../bot-issues/service.js";

interface BotAttentionDeps {
  questions: Pick<BotQuestions, "onChange">;
  approvals: Pick<BotApprovals, "onChange">;
  handoffs: Pick<BotHandoffs, "onChange">;
  accessRequests: Pick<BotAccessRequests, "onChange">;
  issues: Pick<BotIssueService, "onChange">;
  plans: Pick<BotPlans, "onChange">;
  broadcast(channel: "bots:attention", payload: { botId: string }): void;
}

/** Start broadcasting `bots:attention`; the returned function stops it. */
export function wireBotAttention(deps: BotAttentionDeps): () => void {
  const broadcastAttention = (botId: string): void => deps.broadcast("bots:attention", { botId });
  const stops = [
    deps.questions.onChange(broadcastAttention),
    deps.approvals.onChange(broadcastAttention),
    deps.handoffs.onChange(broadcastAttention),
    deps.accessRequests.onChange(broadcastAttention),
    deps.issues.onChange(broadcastAttention),
    deps.plans.onChange(broadcastAttention),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
