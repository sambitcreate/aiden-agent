import type { SpendingOwner } from "../spending-core.js";
import { botExecutionBudgetOwner } from "../bot-peers/budget.js";
import { issueSpendingUnknownAcknowledgement, SpendingDispatchError, type SpendingService } from "../spending-service.js";
import type { BotExecutionClaim, BotRoutineModelService } from "../bot-routine-models.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeSpendingDispatch, sameSpendingDispatch, type SpendingDispatchInput } from "../spending-dispatch-ledger.js";
import { createHash } from "node:crypto";
type RetiredFinancialRecovery = Pick<BotRoutineModelService, "retiredResponseReservation" | "ownedResponseReservation">;
async function assertCostOwner(botId: string, claim: BotExecutionClaim, pending: SpendingDispatchInput, recovery?: RetiredFinancialRecovery): Promise<string | undefined> {
  if (claim.botId !== botId || pending.owner.kind !== "bot") throw new Error("The uncertain request belongs to another owner or root budget. Review that work before resuming.");
  if (pending.owner.id !== botId) {
    const retired = await recovery?.retiredResponseReservation(claim, normalizeSpendingDispatch({ dispatchId: pending.dispatchId, owner: pending.owner, providerId: pending.providerId, modelId: pending.modelId, counts: pending.counts }));
    if (!retired) throw new Error("The uncertain request belongs to another active Bot or root budget. Review that Bot's work before resuming.");
    return retired;
  }
  const roots = new Set([botId, claim.root.botId]);
  if (pending.owner.budgetScopes?.some((scope) => scope.kind !== "bot" || !roots.has(scope.id))) {
    const owned = await recovery?.ownedResponseReservation(claim, normalizeSpendingDispatch({ dispatchId: pending.dispatchId, owner: pending.owner, providerId: pending.providerId, modelId: pending.modelId, counts: pending.counts }));
    if (!owned) throw new Error("The uncertain request belongs to another owner or root budget. Review that work before resuming.");
    return owned;
  }
  return undefined;
}
/** Opaque CAS for the exact immutable receipt and current placed source. */
export async function botExecutionUnknownCostReceipt(spending: Pick<SpendingService, "pendingDispatch" | "dispatchReceipt">, botId: string, claim: BotExecutionClaim, submissionId: string, scopeId: string, recovery?: RetiredFinancialRecovery): Promise<{ dispatchId: string; costReceiptId: string } | undefined> {
  if (claim.botId !== botId || !/^[1-9][0-9]{0,31}$/u.test(submissionId) || !scopeId) throw new Error("This cost decision has no valid current source.");
  const pending = await spending.pendingDispatch(botExecutionSpendingOwner(claim)); if (!pending) return undefined;
  const financialReservation = await assertCostOwner(botId, claim, pending, recovery);
  const receipt = await spending.dispatchReceipt(pending.dispatchId);
  if (!receipt || receipt.state !== "pending" || !sameSpendingDispatch(receipt, normalizeSpendingDispatch(pending))) return undefined;
  const facts = { version: 1, botId, botIncarnation: claim.botIncarnation, claimId: claim.id, requestId: claim.requestId, root: claim.root, ...(financialReservation ? { financialReservation } : {}), submissionId, scopeId, dispatch: normalizeSpendingDispatch(pending), startedAt: receipt.startedAt, monthStartDay: receipt.monthStartDay, billingPeriods: Object.entries(receipt.billingPeriods ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) };
  return { dispatchId: pending.dispatchId, costReceiptId: `cost_${createHash("sha256").update(JSON.stringify(facts)).digest("hex")}` };
}
/** Pi initializes synthetic failures with zeros; that is not a provider cost report. */
export function botExecutionAccountableResponse(message: AssistantMessage): AssistantMessage | undefined {
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
  const usage = message.usage;
  const evidence = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.cost?.total];
  return evidence.some((amount) => typeof amount === "number" && Number.isFinite(amount) && amount > 0) ? message : undefined;
}
export function botExecutionSpendingOwner(claim: BotExecutionClaim): SpendingOwner {
  return botExecutionBudgetOwner(claim);
}
/** Accept the input needed for an explicit recovery card; no provider reservation is bypassed. */
export async function botExecutionInputSpendingRefusal(spending: Pick<SpendingService, "refusal">, botId: string, name?: string): Promise<string | undefined> {
  try { return await spending.refusal({ kind: "bot", id: botId }, name); }
  catch (error) { if (error instanceof SpendingDispatchError && error.code === "uncertain") return undefined; throw error; }
}
/** A saved terminal outcome may settle after exact prior cost acknowledgement/reporting. */
export async function isBotExecutionDispatchSettled(spending: Pick<SpendingService, "dispatchReceipt">, dispatch: SpendingDispatchInput): Promise<boolean> {
  const receipt = await spending.dispatchReceipt(dispatch.dispatchId);
  return Boolean(receipt && sameSpendingDispatch(receipt, normalizeSpendingDispatch(dispatch)) && (receipt.state === "recorded" || receipt.state === "acknowledged_unknown"));
}
/** The person controls this Bot; acknowledge the actual saved obligation, even if its old task was dismissed. */
export async function acknowledgeBotExecutionUnknown(spending: Pick<SpendingService, "pendingDispatch" | "acknowledgeUncertain"> & Partial<Pick<SpendingService, "dispatchReceipt">>, botId: string, claim: BotExecutionClaim, expectedDispatchId?: string, recovery?: RetiredFinancialRecovery): Promise<string | undefined> {
  if (claim.botId !== botId) throw new Error("The execution belongs to another Bot.");
  const pending = expectedDispatchId ? await spending.dispatchReceipt?.(expectedDispatchId) : await spending.pendingDispatch(botExecutionSpendingOwner(claim)); if (!pending) return undefined;
  await assertCostOwner(botId, claim, pending, recovery);
  await spending.acknowledgeUncertain(issueSpendingUnknownAcknowledgement({ dispatchId: pending.dispatchId, owner: pending.owner })); return pending.dispatchId;
}
/** Known receipts remain accountable after model revocation or a person dismissing their old task. */
export async function recordKnownBotExecutionResponse(spending: Pick<SpendingService, "dispatchReceipt" | "afterDispatch">, botId: string, dispatchId: string, message: AssistantMessage, evidence: SpendingDispatchInput, responseDigest: string): Promise<void> {
  if (createHash("sha256").update(JSON.stringify(message)).digest("hex") !== responseDigest) throw new Error("The saved response differs from the authentic provider observation.");
  if (message.stopReason === "deferred" || message.stopReason === "pending") return;
  const input = normalizeSpendingDispatch(evidence);
  if (input.dispatchId !== dispatchId) throw new Error("The authentic response belongs to another provider charge.");
  // A person may already have acknowledged this exact obligation. That does
  // not discard a later authentic amount, nor authorize another dispatch.
  const receipt = await spending.dispatchReceipt(dispatchId);
  if (!receipt) return;
  if (!sameSpendingDispatch(receipt, input)) throw new Error("The authentic response belongs to another provider charge.");
  if (receipt.owner.kind !== "bot" || receipt.owner.id !== botId) throw new Error("This provider receipt belongs to another Bot.");
  const reported = botExecutionAccountableResponse(message), amount = reported?.usage?.cost?.total;
  if (receipt.counts && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) return;
  await spending.afterDispatch(input, reported);
}

/** Authenticated amount-only proof settles its original immutable scopes once. */
export async function recordKnownBotExecutionCost(spending: Pick<SpendingService, "dispatchReceipt" | "afterDispatch">, evidence: SpendingDispatchInput, reportedCostUsd: number): Promise<void> {
  if (typeof reportedCostUsd !== "number" || !Number.isFinite(reportedCostUsd) || reportedCostUsd < 0 || reportedCostUsd > 1e9) throw new Error("Invalid authentic provider reported cost.");
  const dispatch = normalizeSpendingDispatch(evidence), receipt = await spending.dispatchReceipt(dispatch.dispatchId);
  if (!receipt) return;
  if (dispatch.owner.kind !== "bot" || !sameSpendingDispatch(receipt, dispatch)) throw new Error("The authentic provider cost belongs to another dispatch.");
  await spending.afterDispatch(dispatch, { usage: { cost: { total: reportedCostUsd } } });
}
