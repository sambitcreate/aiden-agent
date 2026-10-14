// "Needs you" in the Bots sidebar follows a Bot's questions and approvals as
// they appear and settle. This wires the stores' change hooks to one
// notification that carries only the Bot id: the renderer re-reads that Bot's
// summary, so no question or approval text ever travels on this channel.

import type { BotApprovals } from "./bot-approvals.js";
import type { BotQuestions } from "./bot-questions.js";

export interface BotAttentionDeps {
  questions: Pick<BotQuestions, "onChange">;
  approvals: Pick<BotApprovals, "onChange">;
  broadcast(channel: "bots:attention", payload: { botId: string }): void;
}

/** Start broadcasting `bots:attention`; the returned function stops it. */
export function wireBotAttention(deps: BotAttentionDeps): () => void {
  const broadcastAttention = (botId: string): void => deps.broadcast("bots:attention", { botId });
  const stopQuestions = deps.questions.onChange(broadcastAttention);
  const stopApprovals = deps.approvals.onChange(broadcastAttention);
  return () => {
    stopQuestions();
    stopApprovals();
  };
}
