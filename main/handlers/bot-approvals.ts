import type { BotApprovals } from "../services/bot-runtime/bot-approvals.js";
import { parseBotApprovalDecision } from "./bot-params.js";

/** This acknowledges a choice. Persistence happens later in the owning tool task. */
export function registerBotApprovalDecisionHandler<Event = unknown>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  approvals: Pick<BotApprovals, "decide">;
}): void {
  deps.handle("bots:approve", async (_event, input) => {
    const { waitId, decision, scope } = parseBotApprovalDecision(input);
    return { decided: deps.approvals.decide(waitId, decision, scope) };
  });
}
