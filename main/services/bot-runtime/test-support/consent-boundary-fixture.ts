/** Real SQLite + authenticated claims + durable spending, with synthetic provider effects. */
import path from "node:path";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { DataStore } from "../../data-store.js";
import { emptySpendingDocument } from "../../spending-core.js";
import { SpendingDispatchError, SpendingService } from "../../spending-service.js";
import { openProtectedRoutineClaims } from "../../bot-routine-model-claim-test-support.js";
import { createBotSessionService } from "../bot-session-service.js";
import { recordingDeps } from "./fixtures.js";
import { acknowledgeBotExecutionUnknown, botExecutionAccountableResponse, botExecutionSpendingOwner, botExecutionUnknownCostReceipt, recordKnownBotExecutionResponse, recordKnownBotExecutionCost } from "../bot-execution-spending.js";
import { botExecutionScope, type BotExecutionPort } from "../bot-execution.js";

export async function openConsentBoundaryFixture(root: string, options: { firstUnknown?: boolean; legacyEvidence?: boolean; crash?: "after-control" | "after-approval" | "before-ack" | "after-ack" | "after-generation" | "before-response-proof" | "after-response-proof" | "after-response-memo"; multiCall?: { failSlot?: number; changedFirstBody?: boolean }; retry?: boolean } = {}) {
  const protectedClaims = await openProtectedRoutineClaims(path.join(root, "protected"), "bot:one", "routine:one");
  const document = new DataStore("spending.json", emptySpendingDocument(), () => root, { fileMode: 0o600, compact: true });
  const spending = new SpendingService({ persistence: { load: () => document.load(), save: (next) => document.save(next) }, settings: async () => ({ botMonthUsd: 1, routineRunUsd: 1 }), broadcast() {} });
  const models = createModels(), provider = fauxProvider({ provider: "fixture", models: [{ id: "A", ...(options.multiCall ? { contextWindow: 512, maxTokens: 128 } : {}) }, { id: "B" }] }); models.setProvider(provider.provider);
  const effects = new DataStore<string[]>("provider-effects.json", [], () => root, { fileMode: 0o600, compact: true });
  let firstUnknown = options.firstUnknown === true, providerCalls = 0, currentSlot: number | undefined, slotFailed = false;
  const pauseForKill = async () => { process.stdout.write("OWNERSHIP_SAVED\n"); await new Promise<never>(() => {}); };
  const execution: BotExecutionPort = {
    claim: (botId, input) => protectedClaims.service.claim(botId, input),
    getClaim: (botId, id, requestId) => protectedClaims.service.getClaim(botId, id, requestId),
    selectFallback: (botId, id, reason) => protectedClaims.service.selectFallback(botId, id, reason),
    recordSubmission: (botId, id, submissionId) => protectedClaims.service.recordSubmission(botId, id, submissionId),
    hasUnknown: async (_botId, claim) => Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(claim))),
    unknownDispatch: async (_botId, claim) => (await spending.pendingDispatch(botExecutionSpendingOwner(claim)))?.dispatchId,
    unknownCostReceipt: (botId, claim, submissionId, scopeId) => botExecutionUnknownCostReceipt(spending, botId, claim, submissionId, scopeId),
    async approveCost(facts) { const source = await protectedClaims.service.getClaim(facts.botId, facts.sourceClaimId, facts.sourceRequestId), receipt = await botExecutionUnknownCostReceipt(spending, facts.botId, source, facts.submissionId, facts.scopeId); if (receipt?.dispatchId !== facts.dispatchId || receipt.costReceiptId !== facts.costReceiptId) throw new Error("The synthetic pending receipt changed before approval."); const id = await protectedClaims.service.approveCost(facts); if (options.crash === "after-approval") await pauseForKill(); return id; },
    verifyCostApproval: (id, facts) => protectedClaims.service.verifyCostApproval(id, facts),
    acknowledgeUnknown: async (botId, claim, expectedDispatchId) => {
      if (options.crash === "before-ack") await pauseForKill();
      const actual = await acknowledgeBotExecutionUnknown(spending, botId, claim, expectedDispatchId);
      if (options.crash === "after-ack") await pauseForKill();
      return actual !== undefined;
    },
    verifyResponse: async (facts) => Boolean(await protectedClaims.service.responseEvidence(facts)),
    async reconcileResponseCosts(botId, taskId, scopeId) { for (const evidence of await protectedClaims.service.responseCosts(botId, taskId, scopeId)) await recordKnownBotExecutionCost(spending, evidence.dispatch, evidence.reportedCostUsd); },
    async recordKnownResponse(facts, response) { const evidence = await protectedClaims.service.responseEvidence(facts); if (evidence) await recordKnownBotExecutionResponse(spending, facts.botId, facts.dispatchId, response, evidence, facts.responseDigest); },
    async resolve(_botId, claim) {
      if (options.crash === "after-control" && await spending.pendingDispatch(botExecutionSpendingOwner(claim))) await pauseForKill();
      if (options.crash === "after-generation" && Object.values((await document.load()).dispatches ?? {}).some((receipt) => receipt.state === "acknowledged_unknown")) await pauseForKill();
      const model = models.getModel("fixture", claim.primary.binding.sourceModelId)!;
      const dispatch = (id: string) => ({ dispatchId: id, owner: botExecutionSpendingOwner(claim), providerId: "fixture", modelId: model.id, counts: true });
      const transport = new Proxy(models, { get(target, key) {
        if (key === "streamSimple") return (() => { providerCalls++; const response = fauxAssistantMessage("accepted attempt completed"); response.usage = { ...response.usage, cost: { ...response.usage.cost, total: options.multiCall ? 0.1 : 0.2 } }; const events = createAssistantMessageEventStream(); queueMicrotask(async () => { await effects.update((history) => { history.push(currentSlot === undefined ? "final answer" : `compaction slot ${currentSlot}`); }); events.push({ type: "done", reason: "stop", message: response }); events.end(response); }); return events; }) as Models["streamSimple"];
        const value = Reflect.get(target, key, target) as unknown; return typeof value === "function" ? value.bind(target) : value;
      } });
      return { model, models: transport, imageInput: false, revalidate: async () => {}, release() {}, beforeDispatch: async (id) => { await spending.beforeDispatch(dispatch(id)); if (firstUnknown || options.multiCall?.failSlot === currentSlot && currentSlot !== undefined && !slotFailed) { firstUnknown = false; slotFailed = true; throw new SpendingDispatchError("uncertain", "The provider request's cost is unknown. Resume may incur charges again."); } }, reserveResponse: (slot) => protectedClaims.service.reserveResponseEvidence(slot, dispatch(slot.dispatchId)), async sealResponse(facts, reportedCostUsd) { if (options.crash === "before-response-proof") await pauseForKill(); await protectedClaims.service.recordResponseEvidence(facts, dispatch(facts.dispatchId), options.legacyEvidence ? undefined : reportedCostUsd); if (options.crash === "after-response-proof") await pauseForKill(); }, async afterDispatch(id, response) { if (options.crash === "after-response-memo") await pauseForKill(); await spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(response)); } };
    },
  };
  const extension = recordingDeps();
  if (options.multiCall) extension.beforeCompact = async () => {
    const owner = botExecutionScope()!; let summary = "";
    try { for (let slot = 0; slot < 3; slot++) { currentSlot = slot; const response = await owner.runtime.models.completeSimple(owner.runtime.model, { messages: [{ role: "user", content: slot === 0 && options.multiCall?.changedFirstBody ? "changed memory request" : `original compaction request ${slot}`, timestamp: Date.now() }] }); summary = response.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""); } }
    finally { currentSlot = undefined; }
    return { summary };
  };
  const service = await createBotSessionService({ profileDir: root, models, execution, extension, resolveModel: async () => ({ provider: "fixture", modelId: "A" }), knownBotIds: async () => new Set(["bot:one"]), settings: { compaction: options.multiCall ? { enabled: true, reserveTokens: 128, keepRecentTokens: 30, backgroundTokens: 0 } : { enabled: false }, retry: options.retry ? { enabled: true, maxRetries: 1, baseDelayMs: 1 } : { enabled: false } } });
  return { service, spending, document, effects, execution, protectedClaims, providerCalls: () => providerCalls };
}
