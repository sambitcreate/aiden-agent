import type { BotIssueService } from "../bot-issues/service.js";
import type { SpendingService } from "../spending-service.js";
import type { BotExecutionClaim } from "../bot-routine-models.js";
import { botExecutionSpendingOwner } from "./bot-execution-spending.js";
/** One actionable cost obligation can block later work without creating duplicate cards. */
export function createBotExecutionIssues(issues: Pick<BotIssueService, "raise" | "resolve">, spending: Pick<SpendingService, "pendingDispatch">) {
  return {
    async blocked(botId: string, claim: BotExecutionClaim, message: string, kind: "spending_unknown" | "unavailable") {
      const pending = kind === "spending_unknown" ? await spending.pendingDispatch(botExecutionSpendingOwner(claim)) : undefined;
      await issues.raise({ botId, kind: "preflight_failed", dedupeKey: pending ? `execution-cost:${pending.dispatchId}` : `execution:${claim.id}`, title: "Review this run before resuming", body: message, ...(claim.routineId ? { routineId: claim.routineId } : {}), actions: [{ kind: "open_chat" }] });
    },
    async settled(botId: string, claim: BotExecutionClaim) { await issues.resolve(botId, `execution:${claim.id}`, "fixed"); },
    async dismissed(botId: string, claim: BotExecutionClaim) { await issues.resolve(botId, `execution:${claim.id}`, "dismissed"); },
    async acknowledged(botId: string, dispatchId: string) { await issues.resolve(botId, `execution-cost:${dispatchId}`, "fixed"); },
  };
}
