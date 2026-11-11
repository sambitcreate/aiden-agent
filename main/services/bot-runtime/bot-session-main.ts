import { botMessages, disposeBotMessages } from "../bot-messages/messages-main.js";
import { botMessageTurnOf } from "../../../renderer/shared/bot-messages.js";
import { botPlans, configureBotPlanAuthority } from "../bot-plans/plans-main.js";
import { createBotPlanAuthority } from "../bot-plans/authority.js";
import { createBotPlanLifecycle } from "../bot-plans/lifecycle.js";
// Production wiring of the durable Bot runtime.
//
// One `BotSessionRuntime` per process, created after Bot storage and the
// provider/MCP inventory are ready (`initializeBotSessionRuntime`). Every Bot
// turn re-admits the Bot's authority through `botRuntimeAuthority`, the same
// admission path the legacy generation used, and releases it immediately:
// per-call policy checks admit again, so no long-lived lease spans a restart.
// The one exception is memory review and compaction steering, which hold an
// in-process admission for their run (`admitMemoryWork`).
//
// Tools are the legacy Bot set, built by `bot-tool-sources-main.ts` and
// filtered by `bot-tool-assembly.ts` against the Bot's Full/Custom authority.
// Approvals go through `bot-approvals-main.ts` and resolve by `waitId`.
//
// Rules (plan §6): every call is checked against the Bot's rules, read fresh
// from `<userData>/bots/<dir>/rules.json`, after its approval decision; a rule
// can only add an ask or hand the call to the person (a hand-off card on the
// shared bridge, its answer kept as an `aiden.handoff-result` entry). The
// rules also render into the authority section so the Bot plans around them.
//
// Memory (spec 2026-10-09 §7–§10): every attended turn is offered the
// main-owned `bot_memory` tool (never on routine or self-intro turns), the
// `aiden-memory` section renders the service's frozen snapshot, a reply
// schedules the background review, and compaction flushes memory and steers
// its summary.

import { app, BrowserWindow, ipcMain, logger, Notification, powerMonitor } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { setBotFileToolProtectedRoots, setBotFileToolTemporaryPrivateRoots } from "../bot-file-tool-router.js";
import { botAccessPrivateRoots, resolveBotAccessTarget } from "./bot-access-target.js";
import os from "node:os";
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";
import { usageLimits } from "../usage-limit-main.js";
import { spending } from "../spending-main.js";
import { responseCostUsd, spendCounts } from "../spending-service.js";
import type { SpendingOwner } from "../spending-core.js";
import { botRoutineTaskIdOf } from "../scheduled-bot-routines.js";
import { isLocalModelProvider } from "../usage-accounting.js";
import { aidenConfigDir } from "../aiden-config-dir.js";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import type { ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import { connectionSourceIdFor, resolveConnectCardStatus } from "../bot-runtime-tools/suggest-connection.js";
import { botRoutinesGoAhead, defaultBotRules } from "../../../renderer/shared/bot-rules.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { botCapabilityCatalog, botCapabilityStore, botManagedWorkspace, botServiceRoot } from "../bot-capability-services-main.js";
import { desktopBotProtectedRoots } from "../bot-desktop-protected-settings.js";
import { configStore } from "../config-store.js";
import { createBotConnectionDismissalStore } from "../bot-connection-dismissals.js";
import { botPauses, isBotPaused } from "../bot-pause-main.js";
import type { BotPauseRecord } from "../bot-pause-store.js";
import {
  BOT_DESKTOP_AUDIENCE_ID,
  botRuntimeAuthority,
  resolveBotRuntimeApprovedRoots,
} from "../bot-runtime-authority-main.js";
import type { BotRuntimeAuthorityAdmission } from "../bot-runtime-authority.js";
import { admitWithBotConnectorInventoryScope, botConnectorInventoryServer } from "../bot-connector-inventory-scope.js";
import { botExecutionScope, createBotBackgroundExecutionModels, withoutBotExecutionScope, type BotExecutionPort, type BotExecutionRuntime } from "./bot-execution.js";
import { botRoutineModels } from "../bot-routine-models-main.js";
import { botRoutineModelThinkingLevels, inspectBotRoutineModelGrant, type BotExecutionClaim } from "../bot-routine-models.js";
import { assertBotExecutionConnectorSource } from "./bot-execution-source.js";
import { randomUUID } from "node:crypto";
import { createBotDispatchCoordinator } from "./bot-dispatch-coordinator.js";
import { createBotExecutionIssues } from "./bot-execution-issues.js";
import { assertBoundBotProviderModelCurrent } from "../bot-capability-bindings.js";
import type { BotRoutineThinkingLevel } from "../../../renderer/shared/bot-routine-models.js";
import { acknowledgeBotExecutionUnknown, botExecutionAccountableResponse, botExecutionInputSpendingRefusal, botExecutionSpendingOwner, botExecutionUnknownCostReceipt, isBotExecutionDispatchSettled, recordKnownBotExecutionResponse, recordKnownBotExecutionCost } from "./bot-execution-spending.js";
import { botStore } from "../bot-store.js";
import { botRoutineGuidance, withBotManagedWorkspace, withBotPersona, type BotWorkspacePromptAuthority } from "../bot-system-prompt.js";
import { buildSystemPrompt } from "../chat-system-prompt.js";
import { runtimeSupportsImages } from "../generation-runtime.js";
import { resolveBotModelRuntime, type ResolvedModelRuntime } from "../model-runtime.js";
import { registerSubagentProviderAuthority } from "../subagents/subagent-runtime-authority.js";
import { telegramBotBindingAuthority, telegramBotBindings } from "../telegram/telegram-bot-bindings.js";
import { botApprovals, configureBotApprovalDecisionLookup } from "./bot-approvals-main.js";
import { createBotApprovalTallies } from "./bot-approval-tallies.js";
import { createBotAllowList, reconcileBotAllowListHistory } from "./bot-allow-list.js";
import { toolApprovalRules } from "../tool-approval-rules-main.js";
import { wireBotAttention } from "./bot-attention.js";
import { botQuestions } from "./bot-questions-main.js";
import { botRunStalls, createBotRunWatchdog } from "./bot-run-watchdog.js";
import { checkBotTurnClaims } from "./bot-claim-check.js";
import { commitmentReviewExtras } from "../bot-commitments/commitments-main.js";
import { renderBotLessons } from "../bot-lessons/prompt.js";
import {
  botLearningBudget,
  botLessons,
  howToReviewExtras,
  maybeTidyMemory,
  memorySnapshotText,
  recordMemoryChange,
} from "../bot-learning/learning-main.js";
import { botHandoffs } from "./bot-handoffs-main.js";
import { botAccessRequests } from "./bot-access-requests-main.js";
import { stopBotLegacyChatWork } from "./bot-legacy-chat-pause.js";
import { runBotPauseSteps } from "./bot-pause-steps.js";
import { recordRuleHandoffEntry, ruleHandoffRequest } from "./bot-handoffs.js";
import { createBotHandoffNotifier, watchBotAccessRequests, watchBotHandoffs } from "./bot-handoff-notifications.js";
import { wireBotLiveTurnIntents } from "./bot-turn-intents.js";
import { botRunStarts, botTurnIntents } from "./bot-turn-intents-main.js";
import type { BotExtensionDeps } from "./bot-extension.js";
import { renderBotOpenWork } from "../bot-open-work/prompt.js";
import { createBotRuntimeModels, type BotModelRuntime } from "./bot-models.js";
import type { Models } from "@earendil-works/pi-ai";
import {
  BOT_NOTICE_ENTRY_KIND,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionState,
} from "./bot-session-service.js";
import { createBotToolAssembly } from "./bot-tool-assembly.js";
import { botRunAccess, botFileLocations, createBotToolSources, isConnected, ruleHandoffTarget } from "./bot-tool-sources-main.js";
import { botRunEnded } from "./bot-run-access.js";
import { botMemory as memory } from "../bot-memory/bot-memory-main.js";
import { BOT_COMPACTION_FOCUS, createBotCompactionSteering } from "../bot-memory/compaction.js";
import { renderBotMemorySection } from "../bot-memory/prompt.js";
import { renderBotRulesSection } from "../bot-rules/prompt.js";
import { botRules } from "../bot-rules/store-main.js";
import { botIssues } from "../bot-issues/service-main.js";
import { createBotMemoryReview, type BotMemoryAdmission } from "../bot-memory/review.js";
import { BOT_MEMORY_TOOL_NAME, botMemoryToolEntry, withBotMemoryIngress } from "../bot-memory/tool.js";
import { BOT_RECALL_TOOL_NAME, botRecallToolEntry } from "../bot-memory/recall.js";

import { BOT_CONNECT_CARD_ENTRY_KIND, createBotLiveProjection, type BotLiveProjection } from "./live-projection.js";
import { botIngressAllowsTool, botTurnAttended } from "./bot-tool-policy.js";

export { BOT_CONNECT_CARD_ENTRY_KIND };
const MODEL_CACHE_MS = 30_000;

const profileDir = () => app.getPath("userData");
// Every Bot's session database and memory files live under `<profile>/bots/`;
// only Aiden writes them, never a Bot's file tools (whatever location they use).
// Aiden's settings files and Bot storage (definitions, access state, pauses;
// not the Bots' own homes) are fenced the same way, so a Bot cannot change app
// settings or its own access by editing them.
setBotFileToolProtectedRoots(() => desktopBotProtectedRoots(profileDir(), aidenConfigDir(), botServiceRoot()));
// Temporary Home/whole-Mac access must not expose any app-private store.
setBotFileToolTemporaryPrivateRoots(() => botAccessPrivateRoots(profileDir(), aidenConfigDir()));
// A Bot's replies and routines wait out provider usage limits like a chat's.
const runtimeModels = createBotRuntimeModels({
  usageLimits: (botId, runtime) =>
    runtime.provider && isAcpHarnessProvider(runtime.provider.id)
      ? undefined
      : usageLimits.streamOptions({ kind: "bot", id: botId }, runtime.provider?.label ?? runtime.model.provider),
});
const dismissals = createBotConnectionDismissalStore({ root: profileDir });
// The pause store is shared with the legacy chat path (`bot-pause-main.ts`).
export { isBotPaused };
const resolvedModels = new Map<string, { ref: ModelRef; imageInput: boolean; at: number }>();

let runtime: Promise<BotSessionRuntime> | undefined;

/**
 * The Bot's one ChatStore chat: the list/summary projection and the identity
 * Bot authority is admitted against. Created on first use.
 */
async function canonicalChatId(botId: string): Promise<string> {
  const chat =
    (await botApplicationService.getCanonicalChat(botId)) ??
    (await botApplicationService.createChat({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId }));
  return chat.id;
}

async function admit(botId: string): Promise<BotRuntimeAuthorityAdmission> {
  const chatId = await canonicalChatId(botId);
  const execution = botExecutionScope(botId);
  const routineModelGrant = execution ? await botRoutineModels.grant(botId, execution.claim.id, execution.claim.requestId) : undefined;
  const operation = () => botRuntimeAuthority.admit({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, chatId, ...(routineModelGrant ? { routineModelGrant } : {}) });
  const selected = botConnectorInventoryServer();
  return selected ? admitWithBotConnectorInventoryScope(selected, operation) : operation();
}

/**
 * The health check's admission probe: admit the Bot's current authority (which
 * repairs a model setting that only went stale) and report the model it runs
 * on. The lease is released at once; nothing runs under it.
 */
export async function probeBotAdmission(botId: string): Promise<{ providerId: string; modelId: string }> {
  return withAdmission(botId, async (admission) => ({
    providerId: admission.authority.provider.sourceProviderId,
    modelId: admission.authority.provider.sourceModelId,
  }));
}

/** Host-owned connector read admission; this does not run a turn or grant new access. */
export function admitBotConnectorWork(botId: string): Promise<BotRuntimeAuthorityAdmission> { return admit(botId); }

/**
 * Shell access for one host process started outside a turn (a watch script):
 * admitted and revalidated right before it starts. `signal` aborts when the
 * Bot's access changes; the caller releases the grant when the process ends.
 */
export async function admitBotShellWork(botId: string): Promise<{ signal: AbortSignal; release(): void } | { error: string }> {
  let admission: BotRuntimeAuthorityAdmission;
  try {
    admission = await admit(botId);
  } catch {
    return { error: "Aiden couldn't confirm this Bot's access." };
  }
  try {
    if (!admission.authority.shell.enabled) {
      admission.release();
      return { error: "Shell access is off for this Bot, so its scripts can't run." };
    }
    await admission.revalidateBeforeEffect();
  } catch {
    admission.release();
    return { error: "Aiden couldn't confirm this Bot's access." };
  }
  return { signal: admission.signal, release: () => admission.release() };
}

/** Admit the Bot's current authority for one step and release it right away. */
async function withAdmission<T>(botId: string, action: (admission: BotRuntimeAuthorityAdmission) => Promise<T>): Promise<T> {
  const admission = await admit(botId);
  try {
    return await action(admission);
  } finally {
    admission.release();
  }
}

async function loadBot(botId: string): Promise<BotDefinition> {
  const bot = await botStore.get(botId);
  if (!bot) throw new Error("This Bot no longer exists.");
  return bot;
}

/** Whether the Bot's resolved model takes images; false while it has none. */
async function imageInput(botId: string): Promise<boolean> {
  const current = botExecutionScope(botId); if (current) return current.runtime.imageInput;
  const cached = resolvedModels.get(botId);
  if (cached) return cached.imageInput;
  try {
    await resolveModel(botId);
  } catch {
    return false;
  }
  return resolvedModels.get(botId)?.imageInput ?? false;
}

export const botAllowList = createBotAllowList({
  rules: toolApprovalRules,
  tallies: createBotApprovalTallies({ profileDir }),
  approvals: botApprovals,
  botName: async botId => (await botStore.get(botId))?.name,
  connectionName: async serverId => (await configStore.listMcpServers()).find(server => server.id === serverId)?.name,
  folderEntries: botId => botApplicationService.botFolderEntries(botId),
  revokeFolder: (botId, sourceId) => botApplicationService.revokeBotFolder({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, sourceId }),
  log: (message, error) => logger.warn("bots", message, error),
});
configureBotApprovalDecisionLookup((...args) => botAllowList.decision(...args));
botApplicationService.onAccessChange(botId => botAllowList.changed(botId));

/** Called after the application journal recovered and before runtime initialization.
 * Only known committed history is reconciled; this never publishes new access. */
export async function reconcileBotAllowList(): Promise<void> {
  const [bots, receipts] = await Promise.all([botStore.list(), botApplicationService.botFolderApprovalReceipts()]);
  await reconcileBotAllowListHistory(botAllowList, bots.map(bot => bot.id), receipts,
    (_botId, error) => logger.warn("bots", "A Bot's approval history could not be reconciled.", error));
}

const toolSources = createBotToolSources({
  policyRevision: async (botId) => (await botCapabilityStore.getBotPolicy(botId)).revision,
  folderOffer: (botId, folder) => botAllowList.folderOffer(botId, folder),
  canonicalChatId,
  imageInput,
  admit,
  dismissals,
  botLacksConnection: (botId, sourceId) => botApplicationService.botLacksConnection(botId, sourceId),
  botName: async (botId) => (await botStore.get(botId))?.name,
  planTools: {
    plans: botPlans,
    validate: (botId, input, call) => planAuthority.validate(botId, input, call),
    access: {
      scopeOf: (...args) => planAuthority.access.scopeOf(...args),
      allowOnce: (...args) => planAuthority.access.allowOnce(...args),
      revokePlan: (...args) => planAuthority.access.revokePlan(...args),
    },
    botName: async (botId) => (await botStore.get(botId))?.name,
    botTurns: {
      originOf: (ids) => {
        for (const id of ids) {
          const turn = botMessageTurnOf(id);
          if (turn.kind === "message") return { originBotId: turn.fromBotId };
        }
        return undefined;
      },
      announceWaiting: async (...args) => {
        try { return await botMessages().announceWaiting(...args); }
        catch (error) {
          logger.warn("bots", "The Bot plan's message delivery is unavailable.", error);
          return undefined;
        }
      },
    },
  },
});

// Closures above are invoked only for a live tool call, after this wiring is
// complete. Keep the process-wide plan bridge free of session import cycles.
const planAuthority = createBotPlanAuthority({
  admit,
  facts: (botId, admission) => toolSources.facts(botId, admission),
  rules: (botId) => botRules.rules(botId),
  locations: botFileLocations,
  resolveTarget: (requested) => resolveBotAccessTarget(requested, {
    homeDirectory: os.homedir,
    privateRoots: () => botAccessPrivateRoots(profileDir(), aidenConfigDir()),
    approvedRoots: async () => (await (await import("../aiden-remote-service-main.js")).getAidenRemoteRuntime()).state
      .snapshot().then((state) => state.approvedRoots),
  }),
  runAccess: botRunAccess,
});
configureBotPlanAuthority({ revalidate: planAuthority.revalidate, revokeAccess: planAuthority.revokeAccess });

const tools = createBotToolAssembly({
  allowList: botAllowList,
  admit,
  sources: toolSources,
  rules: (botId) => botRules.rules(botId),
  botName: async (botId) => (await botStore.get(botId))?.name,
  routinesGoAhead: async () => botRoutinesGoAhead(await configStore.getSettings()),
  plans: botPlans,
});

/** The Bot's rules for its prompt; the defaults when the file can't be read (calls still fail closed). */
async function promptRules(botId: string) {
  try {
    return await botRules.rules(botId);
  } catch (error) {
    logger.warn("bots", `Bot ${botId} rules could not be read for its prompt.`, error);
    return defaultBotRules();
  }
}

/**
 * Memory review and compaction work: admit the Bot's authority, keep the
 * admission (unlike `withAdmission`) until the work releases it, and resolve
 * the Bot's model from that admission rather than the model cache, so the
 * work runs on exactly the grant it holds. Its signal aborts the work when
 * access changes; `revalidate` fences every provider request and memory write.
 */
/** Admission for background learning work (memory review, reflection, tidying). */
export async function admitMemoryWork(botId: string): Promise<BotMemoryAdmission> {
  const current = botExecutionScope(botId);
  if (current) {
    await current.runtime.revalidate();
    const selected = current.claim.actual === "fallback" ? current.claim.fallback! : current.claim.primary;
    const model = current.runtime.models.getModel(current.runtime.model.provider, current.runtime.model.id);
    if (!model || !botRoutineModelThinkingLevels(model).includes(selected.thinkingLevel)) return { ok: false, reason: "no_model" };
    return { ok: true, model: { models: current.runtime.models, model }, lease: { signal: current.runtime.signal ?? new AbortController().signal, revalidate: () => current.runtime.revalidate(), release: () => {} } };
  }
  try {
    const claim = await botRoutineModels.claim(botId, { requestId: `memory:${randomUUID()}` });
    const runtime = await execution.resolve(botId, claim, new AbortController().signal);
    try { await runtime.revalidate(); }
    catch (error) { runtime.release(); throw error; }
    return { ok: true, model: { models: createBotBackgroundExecutionModels(claim, runtime), model: runtime.model }, lease: { signal: runtime.signal ?? new AbortController().signal, revalidate: () => runtime.revalidate(), release: () => runtime.release() } };
  } catch (error) {
    logger.warn("bots", `Bot ${botId} memory work was not admitted.`, error);
    return { ok: false, reason: "not_admitted" };
  }
}

const memoryReview = createBotMemoryReview({
  memory,
  conversation: async (botId) => (await botSessionRuntime()).conversation(botId),
  isIdle: async (botId) => (await (await botSessionRuntime()).state(botId)).kind === "idle",
  admit: admitMemoryWork,
  onError: (botId, error) => logger.warn("bots", `Bot ${botId} memory review failed.`, error),
  extras: (botId) => {
    const followUps = commitmentReviewExtras(botId);
    const howTo = howToReviewExtras(botId);
    return { tools: [...followUps.tools, ...howTo.tools], instructions: [...followUps.instructions, ...howTo.instructions] };
  },
  reserve: (botId) => botLearningBudget.reserve(botId, "review", 3_072),
  snapshot: (botId) => memorySnapshotText(botId),
  recordChange: (botId, before, result) =>
    recordMemoryChange(botId, "memory_review", before, `Remembered ${result.added} thing${result.added === 1 ? "" : "s"}`),
  afterReview: (botId) => void maybeTidyMemory(botId).catch(() => undefined),
});

const compactionSteering = createBotCompactionSteering({
  memory,
  admit: admitMemoryWork,
  onError: (botId, error) => logger.warn("bots", `Bot ${botId} compaction memory step failed.`, error),
});

// Spending. Each Bot's responses count toward its month, and a routine run's
// toward that run too. A request after a limit is crossed stops the run; the
// stop's reason is kept for the routine that ran it.
const spendRuntimes = new Map<string, { local: boolean; provider: { id: string }; models: Pick<Models, "checkAuth"> }>();
const spendingStops = new Map<string, string>();
const SPENDING_STOPS_KEPT = 200;

function botSpendingOwner(botId: string, requestIds: readonly (string | undefined)[]): SpendingOwner {
  const run = requestIds.find((id) => botRoutineTaskIdOf(id) !== undefined);
  return { kind: "bot", id: botId, ...(run === undefined ? {} : { run }) };
}

const botSpending: NonNullable<BotExtensionDeps["spending"]> = {
  async refusal(botId, requestIds) {
    const refusal = await spending.refusal(botSpendingOwner(botId, requestIds), (await botStore.get(botId))?.name);
    if (refusal !== undefined) {
      for (const id of requestIds) {
        if (id === undefined) continue;
        spendingStops.delete(id);
        spendingStops.set(id, refusal);
      }
      while (spendingStops.size > SPENDING_STOPS_KEPT) spendingStops.delete(spendingStops.keys().next().value!);
    }
    return refusal;
  },
  async record(botId, requestIds, message) {
    if (botExecutionScope(botId)) return; // Invocation-owned dispatch accounting includes compaction too.
    const cost = responseCostUsd(message);
    const runtime = spendRuntimes.get(botId);
    if (cost <= 0 || runtime === undefined) return;
    await spendCounts(runtime)
      .then((counts) => (counts ? spending.record(botSpendingOwner(botId, requestIds), cost) : undefined))
      .catch((error: unknown) => logger.warn("bots", `Bot ${botId} spending could not be counted.`, error));
  },
};

const dispatchCoordinator = createBotDispatchCoordinator();
const executionIssues = createBotExecutionIssues(botIssues, spending);
async function buildBotExecutionRuntime(botId: string, claim: BotExecutionClaim, runtime: ResolvedModelRuntime, signal: AbortSignal, revalidate: () => Promise<void>, release: () => void, thinkingLevel?: BotRoutineThinkingLevel): Promise<BotExecutionRuntime> {
  const invocation = createBotRuntimeModels({ usageLimits: () => usageLimits.streamOptions({ kind: "bot", id: claim.root.botId }, runtime.provider.label) });
  invocation.register(botId, runtime as unknown as BotModelRuntime);
  const models = invocation.modelsFor(botId), counts = await spendCounts({ local: isLocalModelProvider(runtime.provider), provider: runtime.provider, models: runtime.models });
  const owner = botExecutionSpendingOwner(claim);
  const dispatch = (dispatchId: string) => ({ dispatchId, owner, providerId: runtime.provider.id, modelId: runtime.model.id, counts });
  const held = new Map<string, () => void>();
  const releaseDispatch = (id: string) => { held.get(id)?.(); held.delete(id); };
  return {
    model: runtime.model, models, providerRuntime: runtime, thinkingLevel, imageInput: runtimeSupportsImages(runtime.model), signal, revalidate,
    release: () => { for (const id of held.keys()) releaseDispatch(id); release(); },
    beforeDispatch: async (id) => {
      await reconcileBotPendingKnownCost(claim);
      const scopes = [`bot:${botId}`, ...(owner.budgetScopes ?? []).map((scope) => `${scope.kind}:${scope.id}`)];
      held.set(id, await dispatchCoordinator.acquire(id, scopes, signal));
      try { const prior = await spending.beforeDispatch(dispatch(id)); if (prior.state === "recorded") throw new Error("This request was accounted for but its saved response is unavailable. Review this run before retrying."); }
      catch (error) { releaseDispatch(id); throw error; }
    },
    afterDispatch: async (id, message) => { try { await spending.afterDispatch(dispatch(id), botExecutionAccountableResponse(message)); await executionIssues.settled(botId, claim); } finally { releaseDispatch(id); } },
    sealResponse: (facts,cost) => botRoutineModels.recordResponseEvidence(facts, dispatch(facts.dispatchId), cost),
    reserveResponse: (slot) => botRoutineModels.reserveResponseEvidence(slot, dispatch(slot.dispatchId)),
    isDispatchSettled: (id) => isBotExecutionDispatchSettled(spending, dispatch(id)),
    started: () => botRoutineModels.started(botId, claim.id),
  };
}
async function reconcileBotPendingKnownCost(claim: BotExecutionClaim):Promise<void> {
  const pending=await spending.pendingDispatch(botExecutionSpendingOwner(claim));
  if(!pending)return;
  const proof=await botRoutineModels.responseCostForDispatch(claim,pending);
  if(proof)await recordKnownBotExecutionCost(spending,proof.dispatch,proof.reportedCostUsd);
}
const execution: BotExecutionPort = {
  async reconcileResponseCosts(botId,taskId,scopeId) { for(const proof of await botRoutineModels.responseCosts(botId,taskId,scopeId)) await recordKnownBotExecutionCost(spending,proof.dispatch,proof.reportedCostUsd); },
  verifyResponse: async (facts) => Boolean(await botRoutineModels.responseEvidence(facts)),
  async recordKnownResponse(facts, message) { const dispatch = await botRoutineModels.responseEvidence(facts); if (dispatch) await recordKnownBotExecutionResponse(spending, facts.botId, dispatch.dispatchId, message, dispatch, facts.responseDigest); },
  claim: (botId, input) => botRoutineModels.claim(botId, input),
  getClaim: (botId, id, requestId) => botRoutineModels.getClaim(botId, id, requestId),
  selectFallback: (botId, id, reason) => botRoutineModels.selectFallback(botId, id, reason),
  recordSubmission: (botId, id, submissionId) => botRoutineModels.recordSubmission(botId, id, submissionId),
  async hasUnknown(_botId, claim) { await reconcileBotPendingKnownCost(claim); return Boolean(await spending.pendingDispatch(botExecutionSpendingOwner(claim))); },
  async unknownDispatch(_botId, claim) { await reconcileBotPendingKnownCost(claim); return (await spending.pendingDispatch(botExecutionSpendingOwner(claim)))?.dispatchId; },
  unknownCostReceipt: async (botId, claim, submissionId, scopeId) => {await reconcileBotPendingKnownCost(claim);return botExecutionUnknownCostReceipt(spending, botId, claim, submissionId, scopeId, botRoutineModels);},
  async approveCost(facts) {
    const source = await botRoutineModels.getClaim(facts.botId, facts.sourceClaimId, facts.sourceRequestId);await reconcileBotPendingKnownCost(source);const receipt = await botExecutionUnknownCostReceipt(spending, facts.botId, source, facts.submissionId, facts.scopeId, botRoutineModels);
    if (receipt?.costReceiptId !== facts.costReceiptId || receipt.dispatchId !== facts.dispatchId) throw new Error("The provider cost changed before approval could be saved.");
    return botRoutineModels.approveCost(facts);
  },
  verifyCostApproval: (id, facts) => botRoutineModels.verifyCostApproval(id, facts),
  async acknowledgeUnknown(botId, claim, expectedDispatchId) {
    await reconcileBotPendingKnownCost(claim);
    const pendingId = await acknowledgeBotExecutionUnknown(spending, botId, claim, expectedDispatchId, botRoutineModels);
    if (pendingId) await executionIssues.acknowledged(botId, pendingId);
    return pendingId && (await spending.dispatchReceipt(pendingId))?.state === "recorded" ? "recorded" : pendingId !== undefined;
  },
  dismissed: (botId, claim) => executionIssues.dismissed(botId, claim),
  async resolve(botId, claim, signal): Promise<BotExecutionRuntime> {
    const grant = await botRoutineModels.grant(botId, claim.id, claim.requestId);
    const proof = inspectBotRoutineModelGrant(grant);
    const chatId = await canonicalChatId(botId);
    const peerLease = claim.peer ? await (await import("../bot-peers/host-main.js")).botPeerHost.executionLease(claim.peer) : undefined;
    let admission: BotRuntimeAuthorityAdmission;
    try {
      const sourceSignal=AbortSignal.any([signal,...(peerLease?[peerLease.signal]:[])]);sourceSignal.throwIfAborted();await peerLease?.revalidate();
    if (claim.connectorRestriction?.binding.adapter === "composio-calendar-v1") {
      const restriction = claim.connectorRestriction, binding = claim.connectorRestriction.binding, owner = claim.peer?.watch?.botId ?? botId;
      const fresh = (await (await import("../bot-routine-events/sources-main.js")).botEventRoutines.list(owner)).find(row => row.id === restriction.routineId);
      assertBotExecutionConnectorSource(owner, restriction, fresh, restriction.binding.connection);
      const host = await import("../bot-routine-events/connector-host-main.js");
      await host.validateCalendarConnectorExecution(owner, binding, undefined, sourceSignal);
      if (owner !== botId) await host.validateCalendarConnectorExecution(botId, binding, undefined, sourceSignal);
    }
      await peerLease?.revalidate();sourceSignal.throwIfAborted();
      admission = await botRuntimeAuthority.admit({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, chatId, routineModelGrant: grant });
    }
    catch(error) { peerLease?.release(); throw error; }
    try {
      const boundSignal = AbortSignal.any([signal, admission.signal, ...(peerLease ? [peerLease.signal] : [])]); boundSignal.throwIfAborted();
      const sourceCurrent = async () => {
        if (!claim.connectorRestriction) { if (claim.connectorServerId) throw new Error("The accepted watch source binding is missing."); return; }
        const restriction = claim.connectorRestriction;
        const watchOwner = claim.peer?.watch?.botId ?? botId;
        const fresh = (await (await import("../bot-routine-events/sources-main.js")).botEventRoutines.list(watchOwner)).find((row) => row.id === restriction.routineId);
        const current = admission.authority.connections.find((row) => row.sourceId === restriction.binding.serverId);
        if (watchOwner === botId) {assertBotExecutionConnectorSource(botId, restriction, fresh, current);if(restriction.binding.adapter==="composio-calendar-v1")await (await import("../bot-routine-events/connector-host-main.js")).validateCalendarConnectorExecution(botId,restriction.binding,admission);}
        else {
          // The originating source keeps its account/credential binding; this
          // recipient must independently grant that exact connection and reads.
          const originClaim = await botRoutineModels.claimByRequest(watchOwner,claim.root.requestId);
          if (!originClaim || !originClaim.connectorRestriction) throw new Error("The original watch admission is unavailable.");
          const origin = await botRuntimeAuthority.admit({audienceId:BOT_DESKTOP_AUDIENCE_ID,botId:watchOwner,chatId:await canonicalChatId(watchOwner),routineModelGrant:await botRoutineModels.grant(watchOwner,originClaim.id,originClaim.requestId)});
          try { await origin.revalidateBeforeEffect(); assertBotExecutionConnectorSource(watchOwner,restriction,fresh,origin.authority.connections.find(row=>row.sourceId===restriction.binding.serverId));if(restriction.binding.adapter==="composio-calendar-v1")await (await import("../bot-routine-events/connector-host-main.js")).validateCalendarConnectorExecution(watchOwner,restriction.binding,origin); }
          finally {origin.release();}
          if (!current || current.connectionFingerprint !== restriction.binding.connection.connectionFingerprint || restriction.binding.tools.some(tool=>!current.tools.some(granted=>granted.exactFingerprint===tool.exactFingerprint))) throw new Error("The receiving Bot does not allow the original watch account and read tools.");
          if(restriction.binding.adapter==="composio-calendar-v1")await (await import("../bot-routine-events/connector-host-main.js")).validateCalendarConnectorExecution(botId,restriction.binding,admission);
        }
      };
      await sourceCurrent();
      const selected = claim.actual === "fallback" ? claim.fallback! : claim.primary;
      const runtime = await resolveBotModelRuntime(proof.binding.sourceProviderId, proof.binding.sourceModelId, boundSignal, botId);
      if (!botRoutineModelThinkingLevels(runtime.model).includes(selected.thinkingLevel)) throw new Error("This routine's model no longer supports its selected thinking level.");
      return await buildBotExecutionRuntime(botId, claim, runtime, boundSignal,
        async () => { boundSignal.throwIfAborted(); await peerLease?.revalidate(); await proof.assertCurrent(); await sourceCurrent(); await admission.revalidateBeforeEffect(); boundSignal.throwIfAborted(); },
        () => {admission.release();peerLease?.release();}, selected.thinkingLevel);

    } catch (error) { admission.release(); peerLease?.release(); throw error; }
  },
};

const helperRuntimeBindings = new WeakMap<ResolvedModelRuntime, { owner: NonNullable<ReturnType<typeof botExecutionScope>>; execution: BotExecutionRuntime }>();

/** Parent-owned helper admission. No helper may choose a model from a string. */
export async function resolveBotExecutionHelperRuntime(botId: string, role: "primary" | "vision", providerId: string, modelId: string, signal?: AbortSignal): Promise<ResolvedModelRuntime> {
  const owner = botExecutionScope(botId);
  if (!owner?.bindHelperRuntime || !owner.runtime.providerRuntime) throw new Error("This helper has no active originating task.");
  await owner.runtime.revalidate();
  let helper: BotExecutionRuntime;
  let source: ResolvedModelRuntime;
  if (role === "primary") {
    const selected = owner.claim.actual === "fallback" ? owner.claim.fallback! : owner.claim.primary;
    if (providerId !== selected.binding.sourceProviderId || modelId !== selected.binding.sourceModelId) throw new Error("The helper model differs from its originating task.");
    source = owner.runtime.providerRuntime;
    helper = { ...owner.runtime, models: source.models, release() {} };
  } else {
    const vision = owner.claim.vision;
    if (!vision || providerId !== vision.sourceProviderId || modelId !== vision.sourceModelId) throw new Error("This task did not admit that image model.");
    const admission = await admit(botId);
    try {
      const current = admission.authority.visionProvider;
      if (!current || current.sourceProviderId !== vision.sourceProviderId || current.sourceModelId !== vision.sourceModelId || current.connectionFingerprint !== vision.connectionFingerprint || current.providerExactFingerprint !== vision.providerExactFingerprint || current.modelExactFingerprint !== vision.modelExactFingerprint) throw new Error("This task's image model or credentials changed.");
      const effectSignal = AbortSignal.any([admission.signal, ...(owner.runtime.signal ? [owner.runtime.signal] : []), ...(signal ? [signal] : [])]);
      const revalidate = async () => { effectSignal.throwIfAborted(); await owner.runtime.revalidate(); await admission.revalidateBeforeEffect(); assertBoundBotProviderModelCurrent(vision, await botCapabilityCatalog.snapshotModelsForRuntime({ retainedProviders: [{ sourceProviderId: vision.sourceProviderId, sourceModelId: vision.sourceModelId }], signal: effectSignal })); effectSignal.throwIfAborted(); };
      await revalidate(); source = await resolveBotModelRuntime(providerId, modelId, effectSignal, botId); await revalidate();
      if (!runtimeSupportsImages(source.model)) throw new Error("This task's saved image model no longer supports images.");
      const levels = botRoutineModelThinkingLevels(source.model), thinking = levels.includes("off") ? "off" : levels[0];
      helper = await buildBotExecutionRuntime(botId, owner.claim, source, effectSignal, revalidate, () => admission.release(), thinking);
    } catch (error) { admission.release(); throw error; }
  }
  const bound: ResolvedModelRuntime = { ...source };
  bound.models = new Proxy(source.models, { get(target, property) {
    if (property === "getAuth") return (async (...args: Parameters<Models["getAuth"]>) => {
      await helper.revalidate(); const auth = await target.getAuth(...args); await helper.revalidate(); return auth;
    }) as Models["getAuth"];
    const value = Reflect.get(target, property, target) as unknown; return typeof value === "function" ? value.bind(target) : value;
  } });
  if (source.prepareIsolatedStream) bound.prepareIsolatedStream = async (model, options) => {
    await helper.revalidate(); const prepared = await source.prepareIsolatedStream!(model, options); await helper.revalidate();
    return { ...prepared, signal: AbortSignal.any([prepared.signal, ...(helper.signal ? [helper.signal] : [])]) };
  };
  registerSubagentProviderAuthority(bound, { signal: helper.signal, revalidate: () => helper.revalidate() });
  helperRuntimeBindings.set(bound, { owner, execution: helper }); return bound;
}

/** Apply after isolated transport wrapping, so helper effects cannot bypass source accounting. */
export function bindBotExecutionHelperRuntime(botId: string, kind: string, runtime: ResolvedModelRuntime, sourceRuntime: ResolvedModelRuntime = runtime): ResolvedModelRuntime {
  const binding = helperRuntimeBindings.get(sourceRuntime), owner = botExecutionScope(botId);
  if (!binding || binding.owner !== owner || !owner?.bindHelperRuntime || runtime.model.provider !== binding.execution.model.provider || runtime.model.id !== binding.execution.model.id) throw new Error("This helper runtime does not belong to the active task.");
  // Resolved runtimes own the stream transport. Their Models collection may
  // still own other providers, so dispatch through streams after isolation.
  const transport = createBotRuntimeModels({ usageLimits: () => usageLimits.streamOptions({ kind: "bot", id: owner.claim.root.botId }, runtime.provider.label) });
  transport.register(botId, runtime as unknown as BotModelRuntime);
  const models = owner.bindHelperRuntime(kind, { ...binding.execution, models: transport.modelsFor(botId) });
  return { ...runtime, models, streams: { streamSimple: models.streamSimple.bind(models) } };
}

/** Why a spending limit stopped the run serving `requestId`, for its routine. */
export function botSpendingStop(requestId: string): string | undefined {
  return spendingStops.get(requestId);
}

const extension: BotExtensionDeps = {
  loadBot,
  async systemSections(bot, offered) {
    return withAdmission(bot.id, async (admission) => {
      const authority = admission.authority;
      const workspace = await botManagedWorkspace.resolve(bot.id);
      const roots = await resolveBotRuntimeApprovedRoots(authority);
      const fileAuthority: BotWorkspacePromptAuthority =
        authority.files.mode === "full_mac"
          ? { mode: "full_mac", botHome: authority.files.botHome }
          : authority.files.mode === "off"
            ? { mode: "off", botHome: false }
            : { mode: "scoped", botHome: authority.files.botHome, approvedRoots: roots.map(({ root }) => root) };
      const toolNames = new Set(offered.toolNames);
      const base = await buildSystemPrompt(
        authority.workingDirectory,
        undefined,
        "full",
        toolNames.has("subagent"),
        true,
        tools.skillSnapshot(bot.id),
        toolNames,
      );
      let openWorkSummary = "";
      if (toolNames.has("open_work")) {
        try { openWorkSummary = renderBotOpenWork(await (await import("../bot-open-work/service-main.js")).botOpenWork.toolSnapshot(bot.id)); }
        catch { openWorkSummary = "Open work could not be read. Keep its existing records intact and report that the list is unavailable."; }
      }
      return [
        base,
        withBotPersona("", bot).trim(),
        [withBotManagedWorkspace("", workspace, fileAuthority).trim(), renderBotRulesSection(bot.name, await promptRules(bot.id))]
          .filter((part) => part.length > 0)
          .join("\n\n"),
        [
          botRoutineGuidance(toolNames),
          openWorkSummary,
          tools.guidance(bot.id, offered.toolNames),
          // How-to lessons from the person's corrections: below authority, as data.
          renderBotLessons(await botLessons.list(bot.id, { scope: { kind: "bot" }, status: "active" })),
        ].filter(Boolean).join("\n\n"),
      ];
    });
  },
  memorySection: async (botId, offer) => renderBotMemorySection(await memory.snapshot(botId), offer),
  currentTools: async (bot, turn) => [
    ...(await tools.currentTools(bot.id, turn)),
    botMemoryToolEntry(bot.id, memory),
    botRecallToolEntry(),
  ],
  // `bot_memory` writes only this Bot's own memory and `bot_recall` reads only
  // its own conversation: no file authority, no approval.
  checkPolicy: (botId, toolName, call) =>
    toolName === BOT_MEMORY_TOOL_NAME || toolName === BOT_RECALL_TOOL_NAME
      ? Promise.resolve({ allowed: true })
      : tools.checkPolicy(botId, toolName, call),
  // Per run: the self-intro uses no tools; routine and Telegram turns get no
  // question card; routine and self-intro turns never save memory.
  turnAllows: withBotMemoryIngress(botIngressAllowsTool),
  peerReply: async (botId,message,taskId) => (await import("../bot-peers/host-main.js")).observeBotPeerReply(botId,message,taskId),
  afterReply: (botId) => withoutBotExecutionScope(() => memoryReview.afterReply(botId)),
  beforeCompact: compactionSteering,
  settleApproval: (input, context) => botAllowList.settle(input, context),
  requestApproval: async (request) => {
    const window = await botMessages().announceWaiting(request.botId, request.owner?.inputs.map(i => i.requestId) ?? [], request.summary, request.waitId);
    if (window?.expired) return { id: request.waitId, authorizationFingerprint: request.authorizationFingerprint, answer: "deny", source: "expiry" };
    return botApprovals.request(request);
  },
  // A rule that hands a call to the person opens a card on the same bridge as `hand_off`.
  requestHandoff: (request) => botHandoffs.request(ruleHandoffRequest(request, ruleHandoffTarget(request.toolName))),
  // Into the stopped call's own conversation, never through the harness host,
  // whose per-Bot lock a pause or quit holds while it waits for this call.
  recordHandoff: async (record, conversation) => {
    try {
      await recordRuleHandoffEntry(conversation, record);
    } catch (error) {
      logger.warn("bots", `Bot ${record.botId} hand-off row could not be written.`, error);
    }
  },
  async readmit(botId) {
    if (!(await botStore.get(botId))) return { ok: false, reason: "bot_missing" };
    try {
      await withAdmission(botId, (admission) => admission.revalidateBeforeEffect());
      return { ok: true };
    } catch (error) {
      logger.warn("bots", "Bot turn admission failed.", error);
      return { ok: false, reason: "access_changed" };
    }
  },
  imageInput,
  spending: botSpending,
  // The person's global and Bot hooks, run in the Bot's own folder.
  hooks: {
    cwd: async (botId) => (await botManagedWorkspace.resolve(botId)).homePath,
    attended: botTurnAttended,
    // A Bot run has no transcript notice row, so hook messages go to the app log.
    report: (botId, lines) => logger.info("hooks", `Bot ${botId} hook messages.`, lines),
  },
};

/**
 * The Bot's model. `null` only when the Bot has no AI model configured; any
 * other failure (signed out, provider removed, access changed) throws with
 * its real message, which the Bot shows instead of "Needs an AI model".
 */
async function resolveModel(botId: string): Promise<ModelRef | null> {
  const cached = resolvedModels.get(botId);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.ref;
  if ((await botCapabilityStore.getBotModelAuthority(botId)) === undefined) {
    resolvedModels.delete(botId);
    return null;
  }
  try {
    const resolved = await withAdmission(botId, async (admission) => {
      const { sourceProviderId, sourceModelId } = admission.authority.provider;
      const runtime = await resolveBotModelRuntime(sourceProviderId, sourceModelId, undefined, botId);
      runtimeModels.register(botId, runtime as unknown as BotModelRuntime);
      spendRuntimes.set(botId, { local: isLocalModelProvider(runtime.provider), provider: runtime.provider, models: runtime.models });
      return runtime;
    });
    const ref = { provider: resolved.model.provider, modelId: resolved.model.id };
    resolvedModels.set(botId, { ref, imageInput: runtimeSupportsImages(resolved.model), at: Date.now() });
    return ref;
  } catch (error) {
    logger.warn("bots", `Bot ${botId} could not resolve its AI model.`, error);
    resolvedModels.delete(botId);
    throw error;
  }
}

/** Paired-desktop and Remote turns on the Bot's chat run on `llmClient`, which the harness close never reaches. */
async function stopLegacyChatWork(botId: string): Promise<void> {
  const [{ chatStore }, { llmClient }] = await Promise.all([import("../chat-store.js"), import("../llm-client.js")]);
  await stopBotLegacyChatWork(botId, {
    chatIds: async (id) => (await chatStore.listByBot(id)).map((chat) => chat.id),
    stopChat: (chatId) => llmClient.stopChatWork(chatId),
  });
}

/**
 * Pause steps outside the Bot's harness, run once its running turn is closed.
 * Waits inside the turn (questions, approvals and hand-offs, whether a tool or
 * a rule opened them) need no step: the close signals their calls, which
 * withdraws the cards, and Resume asks again under the same wait ids. Add a
 * step here for anything that keeps going on its own, such as the Bot's
 * computer.
 */
const afterBotPaused = runBotPauseSteps(
  [
    { run: stopLegacyChatWork },
    // The Bot's computer starts stopping now, after its run, and a start still
    // waiting for a slot gives up. A graceful stop can take half a minute, so
    // the pause answers without waiting for it.
    {
      background: true,
      run: async (botId) => (await import("../bot-computers/bot-computers-main.js")).pauseBotComputer(botId),
    },
  ],
  (botId, error) => logger.warn("bots", `Bot ${botId} pause step failed.`, error),
);

/**
 * Unpause: background memory review picks up again, and when routines fired
 * while the Bot was paused, a notice lists them with Run now (decision 4a:
 * nothing catches up on its own). Appended, so it never starts the Bot.
 */
async function afterBotUnpaused(botId: string, record: BotPauseRecord): Promise<void> {
  memoryReview.afterReply(botId);
  const [{ countSkippedWhilePaused }, { scheduleStore }] = await Promise.all([
    import("../scheduled-bot-routines.js"),
    import("../schedule-store.js"),
  ]);
  const routines = await countSkippedWhilePaused(scheduleStore, botId, record.since);
  if (routines.length === 0) return;
  await (await botSessionRuntime()).appendEntry(botId, BOT_NOTICE_ENTRY_KIND, {
    notice: "routines_skipped",
    since: record.since,
    routines,
  });
}

async function deleteRoutines(botId: string): Promise<void> {
  const { botRoutineService } = await import("../scheduled-bot-routines-main.js");
  await botRoutineService.deleteRoutinesForBot(botId);
}

/**
 * The Bot's delivery rows go with it; the phone feed stops listing a Bot whose
 * record is gone anyway, and a deleted id never comes back.
 */
async function forgetDeliveries(botId: string): Promise<void> {
  const { botDeliveryLog } = await import("../bot-delivery/funnel-main.js");
  await botDeliveryLog.forgetBot(botId);
}

/** Photo, managed home, access, chat rows, then the Bot record last. */
async function eraseBotData(botId: string): Promise<void> {
  await botApplicationService.deleteBot({ botId });
  ipcMain.broadcast("bots:changed", { botId, deleted: true });
}

async function unbindTelegram(botId: string): Promise<void> {
  if (await telegramBotBindings.get(botId)) await telegramBotBindingAuthority.disableBot(botId);
}

function broadcastState(botId: string, state: BotSessionState): void {
  ipcMain.broadcast("bots:changed", { botId, session: state });
}

/**
 * Connect cards show what is true now: connected, connected but left out of
 * this Bot's access, or answered with Not now. Shared with Remote.
 */
export async function connectCardStatus(botId: string, card: ConnectCardEntry) {
  return resolveConnectCardStatus(botId, card, {
    isConnected,
    botLacksConnection: (id, sourceId) => botApplicationService.botLacksConnection(id, sourceId),
    isDismissed: (id, pluginId) => dismissals.isDismissed(id, pluginId),
  });
}

let liveProjection: BotLiveProjection | undefined;
const stateListeners = new Set<(botId: string, state: BotSessionState) => void>();

/**
 * Hear every Bot session state change in this process (for example the
 * Telegram outbox re-attaching a reply once its paused turn is resumed).
 */
export function onBotSessionStateChange(listener: (botId: string, state: BotSessionState) => void): () => void {
  stateListeners.add(listener);
  return () => void stateListeners.delete(listener);
}

// A question appearing or settling reaches open desktop chats at once; the
// Remote session projector listens to the same bridge (`remote-service-main`).
botQuestions.onChange((botId) => {
  void liveProjection?.refreshQuestion(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} question view report.`, error),
  );
});

// A hand-off card opening or settling reaches open desktop chats the same way.
botHandoffs.onChange((botId) => {
  void liveProjection?.refreshHandoff(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} hand-off view report.`, error),
  );
});

const stopAccessRequestProjection = botAccessRequests.onChange((botId) => {
  void liveProjection?.refreshAccessRequest(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} access request view report.`, error),
  );
});

const stopPlanProjection = botPlans.onChange((botId) => {
  void liveProjection?.refreshPlan(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} plan view report.`, error),
  );
});

const planLifecycle = createBotPlanLifecycle({
  plans: botPlans,
  onError: (botId, error) => logger.warn("bots", `Bot ${botId} plan lifecycle report.`, error),
});

// A card that opens while no Aiden window is focused also says so in a Mac
// notification ("Ada needs you to: …"); clicking it opens the Bot's chat.
const handoffNotifier = createBotHandoffNotifier({
  isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
  show: ({ title, body, onClick }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on("click", onClick);
    notification.show();
  },
  botName: async (botId) => (await botStore.get(botId))?.name,
  onClick: async (botId) => {
    await requestAppPath(`/bots/${encodeURIComponent(botId)}/chat`);
  },
  isPending: (botId, waitId) => botHandoffs.get(botId, waitId) !== undefined,
  onError: (stage) => logger.warn("bots", `Hand-off notification ${stage} failed.`),
});
watchBotHandoffs(botHandoffs, handoffNotifier);

const accessRequestNotifier = createBotHandoffNotifier({
  isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
  show: ({ title, body, onClick }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on("click", onClick);
    notification.show();
  },
  botName: async (botId) => (await botStore.get(botId))?.name,
  onClick: async (botId) => { await requestAppPath(`/bots/${encodeURIComponent(botId)}/chat`); },
  isPending: (botId, waitId) => botAccessRequests.get(botId, waitId) !== undefined,
  onError: (stage) => logger.warn("bots", `Access request notification ${stage} failed.`),
});
const stopAccessRequestNotifications = watchBotAccessRequests(botAccessRequests, accessRequestNotifier);

// An approval appearing or settling changes the line to and from "Waiting for you".
botApprovals.onChange((botId) => {
  void liveProjection?.refreshActivity(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} activity view report.`, error),
  );
});

// "Needs you" in the Bots sidebar follows questions, approvals, hand-offs and
// host-raised issues as they appear and settle; the renderer re-reads that
// Bot's summary, whose open-issue check is the same file the card comes from.
const stopBotAttention = wireBotAttention({
  questions: botQuestions,
  approvals: botApprovals,
  handoffs: botHandoffs,
  accessRequests: botAccessRequests,
  plans: botPlans,
  issues: botIssues,
  broadcast: (channel, payload) => ipcMain.broadcast(channel, payload),
});

// A Stop from any surface (the Mac or a phone), a Stop that failed, and a
// Resume the session carried out reach open desktop chats as "Stopping",
// back to the work, and "Picking up where it left off". Remote projectors
// listen to the same emitter (`aiden-remote-service-main.ts`).
wireBotLiveTurnIntents({ intents: botTurnIntents, projection: botLiveProjection });

// Stuck-run watchdog (spec §5 S4). Progress is any live event for the running
// turn (a new entry, streamed text, an activity change); the run's start counts
// as the first. Whether a run is a routine comes from its durable request id.
interface WatchedRun {
  submissionId: string;
  at: number;
  quiet: boolean | null;
  /** The person's messages waiting behind this turn; a stop would withdraw them. */
  queued: number;
  unsubscribe?: () => void;
}
const watchedRuns = new Map<string, WatchedRun>();
const RUN_STALL_ISSUE_KEY = "run_stalled";

function watchRun(botId: string, state: BotSessionState): void {
  const current = watchedRuns.get(botId);
  if (state.kind !== "running") {
    if (!current) return;
    current.unsubscribe?.();
    watchedRuns.delete(botId);
    void botIssues.resolve(botId, RUN_STALL_ISSUE_KEY, "fixed").catch(() => undefined);
    return;
  }
  if (current?.submissionId === state.submissionId) return;
  current?.unsubscribe?.();
  // A new turn without going idle: an earlier turn's stall card is moot.
  if (current) void botIssues.resolve(botId, RUN_STALL_ISSUE_KEY, "fixed").catch(() => undefined);
  const run: WatchedRun = { submissionId: state.submissionId, at: Date.now(), quiet: null, queued: 0 };
  watchedRuns.set(botId, run);
  void botSessionRuntime()
    .then((service) => service.quietInputs(botId, [run.submissionId]))
    .then((quiet) => {
      run.quiet = quiet.get(run.submissionId) ?? null;
    })
    .catch(() => undefined);
  void botLiveProjection()
    .subscribe(botId, {
      send: (event) => {
        run.at = Date.now();
        if (event.type === "queued") run.queued = event.queued.length;
        if (event.type === "snapshot") run.queued = event.snapshot.queued.length;
      },
    })
    .then((subscription) => {
      run.queued = subscription.snapshot.queued.length;
      if (watchedRuns.get(botId) === run) run.unsubscribe = () => subscription.unsubscribe();
      else subscription.unsubscribe();
    })
    .catch((error: unknown) => logger.warn("bots", `Bot ${botId} run watch did not start.`, error));
}
stateListeners.add(watchRun);

const runWatchdog = createBotRunWatchdog({
  running: () => [...watchedRuns.keys()],
  lastProgressAt: (botId) => watchedRuns.get(botId)?.at,
  // Unknown until the request id is read; an unknown run is never stopped.
  runKind: (botId) => {
    const run = watchedRuns.get(botId);
    // A routine with the person's messages waiting is asked about, never stopped.
    if (run?.quiet === true) return run.queued > 0 ? "attended" : "routine";
    return run?.quiet === false ? "attended" : null;
  },
  isWaitingOnPerson: (botId) =>
    botHandoffs.pending(botId).length > 0 ||
    botAccessRequests.pending(botId).length > 0 ||
    botApprovals.pending(botId).length > 0 ||
    botQuestions.pending(botId).length > 0,
  // Held back only: a test request already sent can still hang, and the watchdog catches it.
  isWaitingOnUsageLimit: (botId) => usageLimits.gate.isHeld({ kind: "bot", id: botId }),
  stopForStall: async (botId) => {
    botRunStalls.mark(botId);
    try {
      await (await botSessionRuntime()).stop(botId);
    } catch (error) {
      botRunStalls.consume(botId);
      throw error;
    }
  },
  raiseStall: async (botId) => {
    await botIssues.raise({
      botId,
      kind: "run_stalled",
      dedupeKey: RUN_STALL_ISSUE_KEY,
      title: "Still working?",
      body: "This reply hasn't moved in 10 minutes.",
      actions: [{ kind: "stop_run" }, { kind: "keep_waiting" }],
    });
  },
  now: Date.now,
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return { cancel: () => clearInterval(timer) };
  },
  onError: (botId, error) => logger.warn("bots", `Bot ${botId} stuck-run check failed.`, error),
});

/**
 * The claim check on a Bot's newest turn, read from its projected transcript.
 * Connector tools are told by the Bot's real MCP tool names.
 */
export async function botTurnClaims(botId: string): Promise<{ stepIds: string[]; toolNames: string[] } | undefined> {
  const subscription = await botLiveProjection().subscribe(botId, { send: () => undefined });
  try {
    const connectors = toolSources.mcpToolNames(botId);
    const result = checkBotTurnClaims(subscription.snapshot.entries, { isConnectorTool: (name) => connectors.has(name) });
    return result ? { stepIds: result.claimCheck.stepIds, toolNames: result.toolNames } : undefined;
  } finally {
    subscription.unsubscribe();
  }
}

/** Keep waiting on a stuck-run card: another full window before asking again. */
export function snoozeBotRunWatchdog(botId: string): void {
  // The card's own action settles it; this only waits another window.
  runWatchdog.snooze(botId);
}

/** The process-wide live projection that renderer windows subscribe to. */
export function botLiveProjection(): BotLiveProjection {
  liveProjection ??= createBotLiveProjection({
    conversation: async (botId) => (await botSessionRuntime()).conversation(botId),
    state: async (botId) => (await botSessionRuntime()).state(botId),
    quietInputs: async (botId, ids) => (await botSessionRuntime()).quietInputs(botId, ids),
    question: (botId) => botQuestions.pending(botId)[0] ?? null,
    handoff: (botId) => botHandoffs.pending(botId)[0] ?? null,
    accessRequest: (botId) => botAccessRequests.pending(botId)[0] ?? null,
    plan: (botId) => botPlans.current(botId),
    approvalPending: (botId) => botApprovals.pending(botId).length > 0,
    issuePending: async (botId) => (await botIssues.list(botId, { open: true })).length > 0,
    connectCardStatus,
    runStarts: botRunStarts,
    onRunSettled: (botId, state) => {
      planLifecycle.settled(botId, state);
      broadcastState(botId, state);
    },
    onError: (botId, error) => logger.warn("bots", `Bot ${botId} live view report.`, error),
  });
  return liveProjection;
}

/**
 * "Add to this Bot": the person's tap adds one connection that is already set
 * up in Aiden to this Bot's Custom access, then open chats re-read the card.
 */
export async function grantBotConnection(botId: string, pluginId: string): Promise<void> {
  const sourceId = connectionSourceIdFor(pluginId);
  if (sourceId === undefined || !(await isConnected(pluginId))) {
    throw new Error("Connect this app in Aiden first.");
  }
  await botApplicationService.grantBotConnection({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, sourceId });
  ipcMain.broadcast("bots:changed", { botId });
  await botLiveProjection().refresh(botId);
}

/** Remember a Not now for this Bot and update its open chats. */
export async function dismissBotConnection(botId: string, pluginId: string): Promise<void> {
  await dismissals.dismiss(botId, pluginId);
  await botLiveProjection().refresh(botId);
}

/** The process-wide Bot runtime. Created on first use; `initializeBotSessionRuntime` also scans. */
export function botSessionRuntime(): Promise<BotSessionRuntime> {
  runtime ??= createBotSessionService({
    execution,
    executionBlocked: (botId, claim, message, kind) => executionIssues.blocked(botId, claim, message, kind),
    profileDir: profileDir(),
    models: runtimeModels.modelsFor,
    extension,
    resolveModel,
    knownBotIds: async () => new Set((await botStore.list()).map(({ id }) => id)),
    // Each harness open is a new session: the prompt re-reads memory.
    onSessionOpen: (botId) => memory.beginSession(botId),
    compactionInstructions: BOT_COMPACTION_FOCUS,
    pauses: botPauses,
    spendingRefusal: async (botId) => botExecutionInputSpendingRefusal(spending, botId, (await botStore.get(botId))?.name),
    // No memory review runs or writes its marker while the Bot is paused.
    onPaused: async (botId) => {
      (await import("../bot-peers/host-main.js")).botPeerHost.abortBotLeases(botId);
      memoryReview.cancel(botId);
      (await import("../bot-routine-events/sources-main.js")).botConnectorWatches.pauseBot(botId);
    },
    afterPaused: afterBotPaused,
    onUnpaused: afterBotUnpaused,
    hasPeerSource: async (botId,requestIds)=>(await import("../bot-peers/host-main.js")).botPeerHost.hasSource(botId,requestIds),
    onSourceStop: async (botId, requestIds) => { const peers = await import("../bot-peers/host-main.js"); const owned = await peers.botPeerHost.stopSource(botId,requestIds); peers.wakeBotPeers(); return owned; },
    beforeDelete: async (botId) => { await (await import("../bot-peers/host-main.js")).botPeerHost.forgetBot(botId); await botRoutineModels.forgetBot(botId); await (await import("../bot-open-work/service-main.js")).botOpenWork.forgetBot(botId); },
    deleteEffects: [
      // Open chats of the deleted Bot stop receiving its live view.
      async (botId) => liveProjection?.close(botId),
      // No review or memory write may follow; `host.destroy` already removed the files.
      async (botId) => {
        memoryReview.cancel(botId);
        memory.forgetBot(botId);
      },
      (botId) => toolSources.forgetBot(botId),
      async (botId) => (await import("../bot-routine-events/sources-main.js")).forgetBotEventRoutines(botId),
      async (botId) => {
        runtimeModels.forget(botId);
        resolvedModels.delete(botId);
        spendRuntimes.delete(botId);
        await spending.forgetBot(botId);
      },
      deleteRoutines,
      forgetDeliveries,
      (botId) => botMessages().forgetBot(botId),
      (botId) => { planLifecycle.forget(botId); return botPlans.forgetBot(botId); },
      (botId) => botIssues.forgetBot(botId),
      (botId) => botPauses.forgetBot(botId),
      // Its rules file goes, and no later edit can bring its directory back.
      (botId) => botAllowList.forgetBot(botId),
      (botId) => botRules.forgetBot(botId),
      // Its computer stops and its VM is deleted before its home (the shared folder) goes.
      async (botId) => (await import("../bot-computers/bot-computers-main.js")).deleteBotComputer(botId),
      (botId) => dismissals.forgetBot(botId),
      unbindTelegram,
      eraseBotData,
    ],
    // Announced only here, after the session resumed, never by a route ahead of `resume`.
    onResumed: (botId) => botTurnIntents.announce(botId, "resuming"),
    onStopped: (botId) => planLifecycle.stopped(botId),
    onStateChange: (botId, state) => {
      void import("../bot-peers/host-main.js").then(({wakeBotPeers})=>wakeBotPeers());
      if (botRunEnded(state)) botRunAccess.clearBot(botId);
      planLifecycle.stateChanged(botId, state);
      broadcastState(botId, state);
      botLiveProjection().notifyState(botId, state);
      for (const listener of stateListeners) {
        try {
          listener(botId, state);
        } catch (error) {
          logger.warn("bots", `Bot ${botId} state listener failed.`, error);
        }
      }
    },
    onReport: (botId, error) => logger.warn("bots", `Bot ${botId} runtime report.`, error),
  }).catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}

let initialized: Promise<void> | undefined;
/** Time asleep is not a stall; subscribed once Bots are open (the app is ready by then). */
const resumeRunWatchdog = (): void => runWatchdog.resume();
let watchingResume = false;

/** Startup: after Bot storage is ready, sweep orphaned sessions and record interrupted Bots. */
export function initializeBotSessionRuntime(): Promise<void> {
  initialized ??= botSessionRuntime()
    .then(async (service) => {
      const { removedOrphans, interrupted } = await service.initialize();
      (await import("../bot-peers/host-main.js")).startBotPeers();
      await botMessages().start();
      if (removedOrphans.length > 0) logger.info("bots", `Removed ${removedOrphans.length} orphaned Bot sessions.`);
      if (interrupted.length > 0) logger.info("bots", `${interrupted.length} Bot turns are waiting for Resume.`);
      if (!watchingResume) {
        powerMonitor.on("resume", resumeRunWatchdog);
        watchingResume = true;
      }
      // Pre-fire checks arm only once Bots are open, never during onboarding.
      void import("../bot-health/health-main.js")
        .then(({ startBotHealth }) => startBotHealth())
        .catch((error: unknown) => logger.warn("bots", "Bot health checks did not start.", error));
    })
    .catch((error) => {
      initialized = undefined;
      throw error;
    });
  return initialized;
}

export async function shutdownBotSessionRuntime(): Promise<void> {
  (await import("../bot-peers/host-main.js")).stopBotPeers();
  stopPlanProjection();
  planLifecycle.clear();
  stopAccessRequestProjection();
  stopAccessRequestNotifications();
  stopBotAttention();
  botRunAccess.clearAll();
  if (runtime === undefined) return;
  await disposeBotMessages();
  const service = await runtime.catch(() => undefined);
  runtime = undefined;
  initialized = undefined;
  await liveProjection?.close();
  memoryReview.shutdown();
  runWatchdog.dispose();
  if (watchingResume) {
    powerMonitor.removeListener("resume", resumeRunWatchdog);
    watchingResume = false;
  }
  await import("../bot-health/health-main.js").then(({ stopBotHealth }) => stopBotHealth()).catch(() => undefined);
  await service?.shutdown();
  await toolSources.shutdown();
}

export { BOT_NOTICE_ENTRY_KIND };
