// Production wiring of the durable Bot runtime.
//
// One `BotSessionRuntime` per process, created after Bot storage and the
// provider/MCP inventory are ready (`initializeBotSessionRuntime`). Every Bot
// turn re-admits the Bot's authority through `botRuntimeAuthority`, the same
// admission path the legacy generation used, and releases it immediately:
// per-call policy checks admit again, so no long-lived lease spans a restart.
//
// Tools are the legacy Bot set, built by `bot-tool-sources-main.ts` and
// filtered by `bot-tool-assembly.ts` against the Bot's Full/Custom authority.
// Approvals go through `bot-approvals-main.ts` and resolve by `waitId`.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { app, ipcMain, logger } from "../../platform.js";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import type { ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { botCapabilityStore, botManagedWorkspace } from "../bot-capability-services-main.js";
import { createBotConnectionDismissalStore } from "../bot-connection-dismissals.js";
import { removeArchivedBotFavorite } from "../bot-favorites-main.js";
import {
  BOT_DESKTOP_AUDIENCE_ID,
  botRuntimeAuthority,
  resolveBotRuntimeApprovedRoots,
} from "../bot-runtime-authority-main.js";
import type { BotRuntimeAuthorityAdmission } from "../bot-runtime-authority.js";
import { botStore } from "../bot-store.js";
import { withBotManagedWorkspace, withBotPersona, type BotWorkspacePromptAuthority } from "../bot-system-prompt.js";
import { buildSystemPrompt } from "../chat-system-prompt.js";
import { runtimeSupportsImages } from "../generation-runtime.js";
import { resolveBotModelRuntime } from "../model-runtime.js";
import { telegramBotBindingAuthority, telegramBotBindings } from "../telegram/telegram-bot-bindings.js";
import { botApprovals } from "./bot-approvals-main.js";
import type { BotExtensionDeps } from "./bot-extension.js";
import { createBotRuntimeModels, type BotModelRuntime } from "./bot-models.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionState,
} from "./bot-session-service.js";
import { createBotToolAssembly } from "./bot-tool-assembly.js";
import { createBotToolSources } from "./bot-tool-sources-main.js";

export const BOT_CONNECT_CARD_ENTRY_KIND = "aiden.connect-card";
const MODEL_CACHE_MS = 30_000;

const profileDir = () => app.getPath("userData");
const runtimeModels = createBotRuntimeModels();
const dismissals = createBotConnectionDismissalStore({ root: profileDir });
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

async function connectCards(botId: string): Promise<ConnectCardEntry[]> {
  const conversation = await (await botSessionRuntime()).conversation(botId);
  const view = await conversation.context(BACKGROUND_CONTEXT);
  return view.entries
    .filter((entry) => entry.kind === BOT_CONNECT_CARD_ENTRY_KIND)
    .map((entry) => entry.data as unknown as ConnectCardEntry);
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
  appendConnectCard: async (botId, card) => {
    const conversation = await (await botSessionRuntime()).conversation(botId);
    await conversation.submit(
      { type: "write", entry: { kind: BOT_CONNECT_CARD_ENTRY_KIND, data: { ...card } } },
      BACKGROUND_CONTEXT,
    );
  },
  connectCards,
});

const tools = createBotToolAssembly({ admit, sources: toolSources });

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
        withBotManagedWorkspace("", workspace, fileAuthority).trim(),
        tools.guidance(bot.id, offered.toolNames),
      ];
    });
  },
  currentTools: (bot, turn) => tools.currentTools(bot.id, turn),
  checkPolicy: (botId, toolName, call) => tools.checkPolicy(botId, toolName, call),
  requestApproval: (request) => botApprovals.request(request),
  async readmit(botId) {
    if (!(await botStore.get(botId))) return { ok: false, reason: "bot_missing" };
    try {
      await withAdmission(botId, (admission) => admission.revalidateBeforeEffect());
      return { ok: true };
    } catch {
      return { ok: false, reason: "access_changed" };
    }
  },
  imageInput,
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
      runtimeModels.register(runtime as unknown as BotModelRuntime);
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

async function deleteRoutines(botId: string): Promise<void> {
  const { botRoutineService } = await import("../scheduled-bot-routines-main.js");
  await botRoutineService.deleteRoutinesForBot(botId);
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

/** The process-wide Bot runtime. Created on first use; `initializeBotSessionRuntime` also scans. */
export function botSessionRuntime(): Promise<BotSessionRuntime> {
  runtime ??= createBotSessionService({
    profileDir: profileDir(),
    models: runtimeModels.models,
    extension,
    resolveModel,
    knownBotIds: async () => new Set((await botStore.list()).map(({ id }) => id)),
    deleteEffects: [
      (botId) => toolSources.forgetBot(botId),
      deleteRoutines,
      (botId) => dismissals.forgetBot(botId),
      unbindTelegram,
      removeArchivedBotFavorite,
      eraseBotData,
    ],
    onStateChange: broadcastState,
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
  await service?.shutdown();
  await toolSources.shutdown();
}

export { BOT_NOTICE_ENTRY_KIND };
