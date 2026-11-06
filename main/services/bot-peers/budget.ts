import type { SpendingOwner } from "../spending-core.js";
import type { BotPeerExecutionBinding, BotPeerRootBudget } from "./authority.js";
interface BudgetClaim { botId: string; requestId: string; routineId?: string; root: BotPeerRootBudget; peer?: Pick<BotPeerExecutionBinding, "kind"> }
/** A person-task request id is attribution, never an invented routine budget. */
export function botExecutionRootBudget(claim: BudgetClaim): BotPeerRootBudget {
  return { botId: claim.root.botId, requestId: claim.root.requestId, ...(claim.root.routineRunId ? { routineRunId: claim.root.routineRunId } : !claim.peer && claim.routineId ? { routineRunId: claim.root.requestId } : {}) };
}
export function botExecutionBudgetOwner(claim: BudgetClaim): SpendingOwner {
  const root = botExecutionRootBudget(claim);
  const run = claim.routineId ? claim.peer?.kind === "return" ? root.routineRunId : claim.requestId : undefined;
  const owner = { kind: "bot" as const, id: claim.botId, ...(run ? { run } : {}) };
  const rootScope = { kind: "bot" as const, id: root.botId, ...(root.routineRunId ? { run: root.routineRunId } : {}) };
  return JSON.stringify(owner) === JSON.stringify(rootScope) ? owner : { ...owner, budgetScopes: [rootScope] };
}
