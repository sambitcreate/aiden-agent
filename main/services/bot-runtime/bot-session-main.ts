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

import * as path from "node:path";
import { app, BrowserWindow, ipcMain, logger, Notification } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { setBotFileToolProtectedRoots } from "../bot-file-tool-router.js";
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";
import { usageLimits } from "../usage-limit-main.js";
import { spending } from "../spending-main.js";
import { responseCostUsd, spendCounts } from "../spending-service.js";
import type { SpendingOwner } from "../spending-core.js";
import { botRoutineTaskIdOf } from "../scheduled-bot-routines.js";
import { isLocalModelProvider } from "../usage-accounting.js";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import type { ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import { defaultBotRules } from "../../../renderer/shared/bot-rules.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { botCapabilityStore, botManagedWorkspace } from "../bot-capability-services-main.js";
import { createBotConnectionDismissalStore } from "../bot-connection-dismissals.js";
import { botPauses, isBotPaused } from "../bot-pause-main.js";
import type { BotPauseRecord } from "../bot-pause-store.js";
import {
  BOT_DESKTOP_AUDIENCE_ID,
  botRuntimeAuthority,
  resolveBotRuntimeApprovedRoots,
} from "../bot-runtime-authority-main.js";
import type { BotRuntimeAuthorityAdmission } from "../bot-runtime-authority.js";
import { botStore } from "../bot-store.js";
import { botRoutineGuidance, withBotManagedWorkspace, withBotPersona, type BotWorkspacePromptAuthority } from "../bot-system-prompt.js";
import { buildSystemPrompt } from "../chat-system-prompt.js";
import { runtimeSupportsImages } from "../generation-runtime.js";
import { resolveBotModelRuntime } from "../model-runtime.js";
import { telegramBotBindingAuthority, telegramBotBindings } from "../telegram/telegram-bot-bindings.js";
import { botApprovals } from "./bot-approvals-main.js";
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
import { stopBotLegacyChatWork } from "./bot-legacy-chat-pause.js";
import { runBotPauseSteps } from "./bot-pause-steps.js";
import { recordRuleHandoffEntry, ruleHandoffRequest } from "./bot-handoffs.js";
import { createBotHandoffNotifier, watchBotHandoffs } from "./bot-handoff-notifications.js";
import { wireBotLiveTurnIntents } from "./bot-turn-intents.js";
import { botRunStarts, botTurnIntents } from "./bot-turn-intents-main.js";
import type { BotExtensionDeps } from "./bot-extension.js";
import { createBotRuntimeModels, type BotModelRuntime } from "./bot-models.js";
import type { Models } from "@earendil-works/pi-ai";
import {
  BOT_NOTICE_ENTRY_KIND,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionState,
} from "./bot-session-service.js";
import { createBotToolAssembly } from "./bot-tool-assembly.js";
import { createBotToolSources, isConnected, ruleHandoffTarget } from "./bot-tool-sources-main.js";
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
import { botIngressAllowsTool } from "./bot-tool-policy.js";

export { BOT_CONNECT_CARD_ENTRY_KIND };
const MODEL_CACHE_MS = 30_000;

const profileDir = () => app.getPath("userData");
// Every Bot's session database and memory files live under `<profile>/bots/`;
// only Aiden writes them, never a Bot's file tools (whatever location they use).
setBotFileToolProtectedRoots(() => [path.join(profileDir(), "bots")]);
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
  return botRuntimeAuthority.admit({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, chatId });
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
  const cached = resolvedModels.get(botId);
  if (cached) return cached.imageInput;
  try {
    await resolveModel(botId);
  } catch {
    return false;
  }
  return resolvedModels.get(botId)?.imageInput ?? false;
}

const toolSources = createBotToolSources({
  canonicalChatId,
  imageInput,
  admit,
  dismissals,
  botName: async (botId) => (await botStore.get(botId))?.name,
});

const tools = createBotToolAssembly({
  admit,
  sources: toolSources,
  rules: (botId) => botRules.rules(botId),
  botName: async (botId) => (await botStore.get(botId))?.name,
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
  if ((await botCapabilityStore.getBotModelAuthority(botId)) === undefined) return { ok: false, reason: "no_model" };
  if (!(await botStore.get(botId))) return { ok: false, reason: "not_admitted" };
  let admission: BotRuntimeAuthorityAdmission | undefined;
  try {
    admission = await admit(botId);
    await admission.revalidateBeforeEffect();
    const { sourceProviderId, sourceModelId } = admission.authority.provider;
    const runtime = await resolveBotModelRuntime(sourceProviderId, sourceModelId, undefined, botId);
    runtimeModels.register(botId, runtime as unknown as BotModelRuntime);
    // Memory tidy-up is a background chore: at a usage limit it fails and runs another time.
    const models = runtimeModels.backgroundModelsFor(botId);
    const model = models.getModel(runtime.model.provider, runtime.model.id);
    if (model === undefined) {
      admission.release();
      return { ok: false, reason: "no_model" };
    }
    const held = admission;
    return {
      ok: true,
      model: { models, model },
      lease: { signal: held.signal, revalidate: () => held.revalidateBeforeEffect(), release: () => held.release() },
    };
  } catch (error) {
    admission?.release();
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
    const cost = responseCostUsd(message);
    const runtime = spendRuntimes.get(botId);
    if (cost <= 0 || runtime === undefined) return;
    await spendCounts(runtime)
      .then((counts) => (counts ? spending.record(botSpendingOwner(botId, requestIds), cost) : undefined))
      .catch((error: unknown) => logger.warn("bots", `Bot ${botId} spending could not be counted.`, error));
  },
};

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
      return [
        base,
        withBotPersona("", bot).trim(),
        [withBotManagedWorkspace("", workspace, fileAuthority).trim(), renderBotRulesSection(bot.name, await promptRules(bot.id))]
          .filter((part) => part.length > 0)
          .join("\n\n"),
        [
          botRoutineGuidance(toolNames),
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
  afterReply: (botId) => memoryReview.afterReply(botId),
  beforeCompact: compactionSteering,
  requestApproval: (request) => botApprovals.request(request),
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
}

async function unbindTelegram(botId: string): Promise<void> {
  if (await telegramBotBindings.get(botId)) await telegramBotBindingAuthority.disableBot(botId);
}

function broadcastState(botId: string, state: BotSessionState): void {
  ipcMain.broadcast("bots:changed", { botId, session: state });
}

/** Connect cards show what is true now: connected, or answered with Not now. Shared with Remote. */
export async function connectCardStatus(botId: string, card: ConnectCardEntry) {
  if (await isConnected(card.pluginId)) return "connected" as const;
  if (await dismissals.isDismissed(botId, card.pluginId)) return "dismissed" as const;
  return card.status;
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

// An approval appearing or settling changes the line to and from "Waiting for you".
botApprovals.onChange((botId) => {
  void liveProjection?.refreshActivity(botId).catch((error: unknown) =>
    logger.warn("bots", `Bot ${botId} activity view report.`, error),
  );
});

// "Needs you" in the Bots sidebar follows questions, approvals, hand-offs and
// host-raised issues as they appear and settle; the renderer re-reads that
// Bot's summary, whose open-issue check is the same file the card comes from.
wireBotAttention({
  questions: botQuestions,
  approvals: botApprovals,
  handoffs: botHandoffs,
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
    approvalPending: (botId) => botApprovals.pending(botId).length > 0,
    issuePending: async (botId) => (await botIssues.list(botId, { open: true })).length > 0,
    connectCardStatus,
    runStarts: botRunStarts,
    onRunSettled: broadcastState,
    onError: (botId, error) => logger.warn("bots", `Bot ${botId} live view report.`, error),
  });
  return liveProjection;
}

/** Remember a Not now for this Bot and update its open chats. */
export async function dismissBotConnection(botId: string, pluginId: string): Promise<void> {
  await dismissals.dismiss(botId, pluginId);
  await botLiveProjection().refresh(botId);
}

/** The process-wide Bot runtime. Created on first use; `initializeBotSessionRuntime` also scans. */
export function botSessionRuntime(): Promise<BotSessionRuntime> {
  runtime ??= createBotSessionService({
    profileDir: profileDir(),
    models: runtimeModels.modelsFor,
    extension,
    resolveModel,
    knownBotIds: async () => new Set((await botStore.list()).map(({ id }) => id)),
    // Each harness open is a new session: the prompt re-reads memory.
    onSessionOpen: (botId) => memory.beginSession(botId),
    compactionInstructions: BOT_COMPACTION_FOCUS,
    pauses: botPauses,
    spendingRefusal: async (botId) => spending.refusal({ kind: "bot", id: botId }, (await botStore.get(botId))?.name),
    // No memory review runs or writes its marker while the Bot is paused.
    onPaused: (botId) => memoryReview.cancel(botId),
    afterPaused: afterBotPaused,
    onUnpaused: afterBotUnpaused,
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
      (botId) => botIssues.forgetBot(botId),
      (botId) => botPauses.forgetBot(botId),
      // Its rules file goes, and no later edit can bring its directory back.
      (botId) => botRules.forgetBot(botId),
      // Its computer stops and its VM is deleted before its home (the shared folder) goes.
      async (botId) => (await import("../bot-computers/bot-computers-main.js")).deleteBotComputer(botId),
      (botId) => dismissals.forgetBot(botId),
      unbindTelegram,
      eraseBotData,
    ],
    // Announced only here, after the session resumed, never by a route ahead of `resume`.
    onResumed: (botId) => botTurnIntents.announce(botId, "resuming"),
    onStateChange: (botId, state) => {
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

/** Startup: after Bot storage is ready, sweep orphaned sessions and record interrupted Bots. */
export function initializeBotSessionRuntime(): Promise<void> {
  initialized ??= botSessionRuntime()
    .then(async (service) => {
      const { removedOrphans, interrupted } = await service.initialize();
      if (removedOrphans.length > 0) logger.info("bots", `Removed ${removedOrphans.length} orphaned Bot sessions.`);
      if (interrupted.length > 0) logger.info("bots", `${interrupted.length} Bot turns are waiting for Resume.`);
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
  if (runtime === undefined) return;
  const service = await runtime.catch(() => undefined);
  runtime = undefined;
  initialized = undefined;
  await liveProjection?.close();
  memoryReview.shutdown();
  runWatchdog.dispose();
  await import("../bot-health/health-main.js").then(({ stopBotHealth }) => stopBotHealth()).catch(() => undefined);
  await service?.shutdown();
  await toolSources.shutdown();
}

export { BOT_NOTICE_ENTRY_KIND };
