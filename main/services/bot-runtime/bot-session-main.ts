// Production wiring of the durable Bot runtime.
//
// One `BotSessionRuntime` per process, created after Bot storage and the
// provider/MCP inventory are ready (`initializeBotSessionRuntime`). Every Bot
// turn re-admits the Bot's authority through `botRuntimeAuthority`, the same
// admission path the legacy generation used, and releases it immediately:
// per-call policy checks admit again, so no long-lived lease spans a restart.
//
// Tool parity is partial in this slice: Bot file tools, the shell, routines
// and `suggest_connection` are offered. MCP connections, skills, web search,
// subagents, computer use and companion vision are not yet ported to the
// durable runtime (see `.memory/bot-durable-runtime.md`).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { app, ipcMain, logger } from "../../platform.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import {
  connectionSuggestionFor,
  type ConnectCardEntry,
} from "../../../renderer/shared/bot-connections.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { botManagedWorkspace } from "../bot-capability-services-main.js";
import { createBotConnectionDismissalStore } from "../bot-connection-dismissals.js";
import { BOT_FILE_TOOL_NAMES, buildBotFileTools, type BotFileToolLocation } from "../bot-file-tool-router.js";
import { removeArchivedBotFavorite } from "../bot-favorites-main.js";
import {
  BOT_DESKTOP_AUDIENCE_ID,
  botRuntimeAuthority,
  resolveBotRuntimeApprovedRoots,
} from "../bot-runtime-authority-main.js";
import type { BotRuntimeAuthorityAdmission } from "../bot-runtime-authority.js";
import { botStore } from "../bot-store.js";
import { withBotManagedWorkspace, withBotPersona, type BotWorkspacePromptAuthority } from "../bot-system-prompt.js";
import { createSuggestConnectionTool } from "../bot-runtime-tools/suggest-connection.js";
import { buildSystemPrompt } from "../chat-system-prompt.js";
import { buildPinnedCodingTools } from "../coding-tools.js";
import { configStore } from "../config-store.js";
import { presetServerId } from "../mcp-presets.js";
import { resolveBotModelRuntime } from "../model-runtime.js";
import { scheduleTaskToolsForContext } from "../schedule-tool.js";
import { telegramBotBindingAuthority, telegramBotBindings } from "../telegram/telegram-bot-bindings.js";
import type { BotExtensionDeps, BotPolicyDecision, BotToolEntry } from "./bot-extension.js";
import { createBotRuntimeModels, type BotModelRuntime } from "./bot-models.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  createBotSessionService,
  type BotSessionRuntime,
  type BotSessionState,
} from "./bot-session-service.js";

export const BOT_CONNECT_CARD_ENTRY_KIND = "aiden.connect-card";
const READ_ONLY_FILE_TOOLS = new Set<string>(["read_file", "list_dir", "glob", "grep"]);
const MODEL_CACHE_MS = 30_000;

const profileDir = () => app.getPath("userData");
const runtimeModels = createBotRuntimeModels();
const dismissals = createBotConnectionDismissalStore({ root: profileDir });
const resolvedModels = new Map<string, { ref: ModelRef; at: number }>();

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

/** Admit the Bot's current authority for one step and release it right away. */
async function withAdmission<T>(botId: string, action: (admission: BotRuntimeAuthorityAdmission) => Promise<T>): Promise<T> {
  const chatId = await canonicalChatId(botId);
  const admission = await botRuntimeAuthority.admit({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, chatId });
  try {
    return await action(admission);
  } finally {
    admission.release();
  }
}

async function loadBot(botId: string): Promise<BotDefinition> {
  const bot = await botStore.get(botId);
  if (!bot || bot.archivedAt !== undefined) throw new Error("This Bot no longer exists.");
  return bot;
}

async function fileLocations(admission: BotRuntimeAuthorityAdmission): Promise<BotFileToolLocation[]> {
  const authority = admission.authority;
  const locations: BotFileToolLocation[] = [];
  if (authority.files.botHome) {
    locations.push({
      id: "builtin.bot_home.v1",
      label: "Bot folder",
      root: authority.workingDirectory,
      expectedIdentity: authority.managedHome.incarnation,
    });
  }
  if (authority.files.fullMac) {
    locations.push({ id: authority.files.fullMac.sourceId, label: "Full Mac", root: "/" });
  }
  for (const { device, inode, ...location } of await resolveBotRuntimeApprovedRoots(authority)) {
    locations.push({ ...location, expectedIdentity: { device, inode } });
  }
  return locations;
}

async function isConnected(pluginId: string): Promise<boolean> {
  const suggestion = connectionSuggestionFor(pluginId);
  if (!suggestion) return false;
  const serverId = presetServerId(suggestion.setupEntry.presetId);
  return (await configStore.listMcpServers()).some((server) => server.id === serverId && server.enabled);
}

async function connectCards(botId: string): Promise<ConnectCardEntry[]> {
  const conversation = await (await botSessionRuntime()).conversation(botId);
  const view = await conversation.context(BACKGROUND_CONTEXT);
  return view.entries
    .filter((entry) => entry.kind === BOT_CONNECT_CARD_ENTRY_KIND)
    .map((entry) => entry.data as unknown as ConnectCardEntry);
}

function botTools(botId: string, admission: BotRuntimeAuthorityAdmission, locations: BotFileToolLocation[], routineRun: boolean): BotToolEntry[] {
  const authority = admission.authority;
  const entries: BotToolEntry[] = [];
  if (locations.length > 0) {
    for (const tool of buildBotFileTools({ defaultLocation: locations[0]!, additionalLocations: locations.slice(1) })) {
      entries.push({ tool, replay: READ_ONLY_FILE_TOOLS.has(tool.name) ? "safe" : "unsafe" });
    }
  }
  if (authority.shell.enabled) {
    const shell = buildPinnedCodingTools(authority.workingDirectory).find(({ name }) => name === "run_command");
    if (shell) entries.push({ tool: shell, replay: "unsafe" });
  }
  for (const tool of scheduleTaskToolsForContext({ bot: { botId, routineRun } })) {
    entries.push({ tool, replay: "unsafe" });
  }
  const suggest: AgentTool = createSuggestConnectionTool(botId, {
    isConnected,
    isDismissed: (id, pluginId) => dismissals.isDismissed(id, pluginId),
    appendConnectCard: async (id, card) => {
      const conversation = await (await botSessionRuntime()).conversation(id);
      await conversation.submit(
        { type: "write", entry: { kind: BOT_CONNECT_CARD_ENTRY_KIND, data: { ...card } } },
        BACKGROUND_CONTEXT,
      );
    },
    hasPendingCard: async (id, pluginId) => {
      const matching = (await connectCards(id)).filter((card) => card.pluginId === pluginId);
      const latest = matching[matching.length - 1];
      return latest?.status === "pending";
    },
  });
  entries.push({ tool: suggest, replay: "unsafe" });
  return entries;
}

const extension: BotExtensionDeps = {
  loadBot,
  async systemSections(bot) {
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
      const base = await buildSystemPrompt(authority.workingDirectory, undefined, "full", false, false);
      return [
        base,
        withBotPersona("", bot).trim(),
        withBotManagedWorkspace("", workspace, fileAuthority).trim(),
      ];
    });
  },
  async currentTools(bot, turn) {
    return withAdmission(bot.id, async (admission) =>
      botTools(bot.id, admission, await fileLocations(admission), turn.requestId?.startsWith("routine:") ?? false),
    );
  },
  async checkPolicy(botId, toolName): Promise<BotPolicyDecision> {
    try {
      return await withAdmission(botId, async (admission) => {
        await admission.revalidateBeforeEffect();
        const authority = admission.authority;
        if (BOT_FILE_TOOL_NAMES.includes(toolName as (typeof BOT_FILE_TOOL_NAMES)[number])) {
          return (await fileLocations(admission)).length > 0
            ? { allowed: true }
            : { allowed: false, reason: "File access is off for this Bot." };
        }
        if (toolName === "run_command" && !authority.shell.enabled) {
          return { allowed: false, reason: "The shell is off for this Bot." };
        }
        return { allowed: true };
      });
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : "This Bot's access changed." };
    }
  },
  // No tool offered in this slice needs a per-call approval; fail closed if one ever asks.
  async requestApproval() {
    return "deny";
  },
  async readmit(botId) {
    if (!(await botStore.get(botId))) return { ok: false, reason: "bot_missing" };
    try {
      await withAdmission(botId, (admission) => admission.revalidateBeforeEffect());
      return { ok: true };
    } catch {
      return { ok: false, reason: "access_changed" };
    }
  },
};

async function resolveModel(botId: string): Promise<ModelRef | null> {
  const cached = resolvedModels.get(botId);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.ref;
  try {
    const ref = await withAdmission(botId, async (admission) => {
      const { sourceProviderId, sourceModelId } = admission.authority.provider;
      const resolved = await resolveBotModelRuntime(sourceProviderId, sourceModelId, undefined, botId);
      runtimeModels.register(resolved as unknown as BotModelRuntime);
      return { provider: resolved.model.provider, modelId: resolved.model.id };
    });
    resolvedModels.set(botId, { ref, at: Date.now() });
    return ref;
  } catch (error) {
    logger.warn("bots", `Bot ${botId} has no usable AI model.`, error);
    resolvedModels.delete(botId);
    return null;
  }
}

async function deleteRoutines(botId: string): Promise<void> {
  const { botRoutineService } = await import("../scheduled-bot-routines-main.js");
  await botRoutineService.deleteRoutinesForBot(botId);
}

/**
 * Retire the Bot record last. Bot storage has no hard delete yet, so the
 * record is archived: its authority is fenced and it leaves every list.
 */
async function retireBotRecord(botId: string): Promise<void> {
  const bot = await botStore.get(botId);
  if (!bot || bot.archivedAt !== undefined) return;
  await botApplicationService.archiveBot({ botId, expectedRevision: bot.revision });
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
    // Deleted Bots are archived records; their sessions are orphans.
    knownBotIds: async () =>
      new Set((await botStore.list(true)).filter((bot) => bot.archivedAt === undefined).map(({ id }) => id)),
    deleteEffects: [
      deleteRoutines,
      (botId) => dismissals.forgetBot(botId),
      unbindTelegram,
      removeArchivedBotFavorite,
      retireBotRecord,
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
}

export { BOT_NOTICE_ENTRY_KIND };
