// Production candidate tools for durable Bot turns, built by the same legacy
// factories and gates `llm-client.ts` used for Bot generations:
//
// - `buildAgentTools` for MCP connection tools (exact Bot connection ids,
//   strict, no provider-authenticated servers), skills (the Bot-filtered
//   snapshot), web search, Computer Use and the subagent tool;
// - the Bot file router, the pinned shell, the Bot routine tool and
//   `suggest_connection`;
// - `share_image` and companion vision `inspect_image` through the durable
//   bindings in `bot-tool-candidates.ts`.
//
// Policy is applied afterwards by `bot-tool-assembly.ts`. This module only
// builds; it never decides what a Bot may use.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { compactionEngineFrom } from "../../../renderer/shared/compaction.js";
import { connectionSuggestionFor, type ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import { resolveBotRuntimeSkills } from "../bot-capability-services-main.js";
import type { BotConnectionDismissalStore } from "../bot-connection-dismissals.js";
import { buildBotFileTools, type BotFileToolLocation } from "../bot-file-tool-router.js";
import { resolveBotRuntimeApprovedRoots, resolveBotRuntimeCatalogSnapshot } from "../bot-runtime-authority-main.js";
import { createSuggestConnectionTool } from "../bot-runtime-tools/suggest-connection.js";
import { buildPinnedCodingTools } from "../coding-tools.js";
import { createComputerUseController } from "../computer-use/runtime.js";
import { computerUseSupported } from "../computer-use/platform.js";
import { computerUseStatus } from "../computer-use/status.js";
import type { ComputerUseController } from "../computer-use/controller.js";
import type { ComputerUseArgs } from "../computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import { logger } from "../../platform.js";
import { createMcpInstructionCollector } from "../mcp-server-instructions.js";
import { presetServerId } from "../mcp-presets.js";
import { resolveBotModelRuntime } from "../model-runtime.js";
import { scheduleTaskToolsForContext } from "../schedule-tool.js";
import { skillRegistry } from "../skill-registry-main.js";
import { inheritedSubagentReadToolCeiling } from "../subagents/capability-profile.js";
import { subagentsAllowedForGeneration } from "../subagents/eligibility.js";
import { subagentHealthMetrics } from "../subagents/subagent-health-metrics.js";
import { SubagentSupervisor } from "../subagents/subagent-supervisor.js";
import { createSubagentTool } from "../subagents/subagent-tool.js";
import { buildAgentTools } from "../tools.js";
import type { BotTurnContext } from "./bot-extension.js";
import type { BotAdmission, BotCandidateSet, BotToolCandidate, BotToolSources } from "./bot-tool-assembly.js";
import { shareImageCandidate, visionCandidate } from "./bot-tool-candidates.js";
import { createBotToolFacts, type BotToolFactsWithSkills } from "./bot-tool-facts.js";
import { SUBAGENT_TOOL } from "./bot-tool-policy.js";

const BOT_HOME_LOCATION_ID = "builtin.bot_home.v1";

export interface BotToolSourceDeps {
  /** The Bot's canonical chat (owner of subagent runs and Computer Use opt-in). */
  canonicalChatId(botId: string): Promise<string>;
  /** Whether the Bot's resolved model takes images. */
  imageInput(botId: string): Promise<boolean>;
  /** A fresh admission, used by tools that revalidate during their own effect. */
  admit(botId: string): Promise<BotAdmission>;
  dismissals: Pick<BotConnectionDismissalStore, "isDismissed">;
  appendConnectCard(botId: string, card: ConnectCardEntry): Promise<void>;
  connectCards(botId: string): Promise<ConnectCardEntry[]>;
}

type ProductionFacts = BotToolFactsWithSkills;

export async function botFileLocations(admission: BotAdmission): Promise<BotFileToolLocation[]> {
  const authority = admission.authority;
  const locations: BotFileToolLocation[] = [];
  if (authority.files.botHome) {
    locations.push({
      id: BOT_HOME_LOCATION_ID,
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

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

export interface BotToolSourcesMain extends BotToolSources {
  /** Close every Bot's Computer Use controller (app quit). */
  shutdown(): Promise<void>;
  /** Close one Bot's Computer Use controller (Bot deleted). */
  forgetBot(botId: string): Promise<void>;
}

export function createBotToolSources(deps: BotToolSourceDeps): BotToolSourcesMain {
  const controllers = new Map<string, ComputerUseController>();

  async function closeController(botId: string): Promise<void> {
    const controller = controllers.get(botId);
    controllers.delete(botId);
    await controller?.close().catch(() => undefined);
  }

  /**
   * The Bot's Computer Use controller, under the same gates as a legacy turn:
   * platform support, the global beta, the Bot chat's own opt-in and a ready
   * driver. A controller lives across the Bot's turns until it is no longer
   * allowed, the Bot is deleted, or the app quits.
   */
  async function computerUseFor(botId: string, supportsImages: boolean): Promise<ComputerUseController | undefined> {
    const chat = await chatStore.get(await deps.canonicalChatId(botId));
    const enabled =
      computerUseSupported() &&
      (await configStore.getSettings()).computerUseEnabled === true &&
      chat?.computerUseEnabled === true;
    if (!enabled) {
      await closeController(botId);
      return undefined;
    }
    const status = await computerUseStatus.status({});
    if (!status.ready) {
      logger.warn("bots", `Computer Use is enabled for Bot ${botId} but is not ready. ${status.detail}`);
      await closeController(botId);
      return undefined;
    }
    const current = controllers.get(botId);
    if (current && current.lifecycleState !== "closed" && current.lifecycleState !== "poisoned") return current;
    const controller = createComputerUseController(`bot:${botId}`, supportsImages);
    controllers.set(botId, controller);
    return controller;
  }

  function subagentCandidate(botId: string, admission: BotAdmission, schema: AgentTool): BotToolCandidate {
    const authority = admission.authority;
    return {
      tool: schema,
      replay: "unsafe",
      bind: (call) =>
        ({
          ...schema,
          async execute(toolCallId, params, signal, onUpdate) {
            const settings = await configStore.getSettings();
            const runtime = await resolveBotModelRuntime(
              authority.provider.sourceProviderId,
              authority.provider.sourceModelId,
              signal,
              authority.chatId,
            );
            // Children belong to this exact parent call, in the Bot's own chat
            // and folder. Nothing is persisted that could relaunch them: the
            // tool is `unsafe`, so a replayed parent call never reruns.
            const supervisor = new SubagentSupervisor({
              compactionEngine: compactionEngineFrom(settings.compactionEngine),
              compactionModelOverrides: settings.compactionModelOverrides,
              generationId: `bot:${botId}:${call.callId}`,
              chatId: await deps.canonicalChatId(botId),
              workspaceId: authority.managedHome.workspaceId,
              runtime,
              thinkingLevel: "off",
              workspaceRoot: authority.workingDirectory,
              permission: "full",
              inheritedCeiling: authority.files.botHome ? inheritedSubagentReadToolCeiling(undefined) : [],
              healthMetrics: subagentHealthMetrics,
            });
            return createSubagentTool(supervisor).execute(toolCallId, params, signal, onUpdate);
          },
        }) satisfies AgentTool,
    };
  }

  const sources: BotToolSourcesMain = {
    async facts(botId, admission): Promise<ProductionFacts> {
      const authority = admission.authority;
      const catalog = once(() => resolveBotRuntimeCatalogSnapshot(authority));
      return createBotToolFacts({
        admission,
        supportsImages: await deps.imageInput(botId),
        fileLocations: (await botFileLocations(admission)).length,
        catalog: async () => (await catalog()).resources,
        mcpServers: () => configStore.listMcpServers(),
        skills: async () => ({
          snapshot: await skillRegistry.snapshotResolved({
            id: authority.managedHome.workspaceId,
            folderPath: authority.workingDirectory,
            permission: "full",
          }),
          resolved: await resolveBotRuntimeSkills(botId),
        }),
      });
    },

    async candidates(botId, admission, facts, turn: BotTurnContext): Promise<BotCandidateSet> {
      const authority = admission.authority;
      const production = facts as ProductionFacts;
      const routineRun = turn.requestId?.startsWith("routine:") ?? false;
      const telegram = turn.requestId?.startsWith("tg:") ?? false;
      const has = (kind: string) => authority.otherCapabilities.some((grant) => grant.kind === kind);
      const workspace = { id: authority.managedHome.workspaceId, folderPath: authority.workingDirectory };
      const collector = createMcpInstructionCollector();
      const skillSnapshot = await production.skillSnapshot();
      const subagentsAllowed =
        has("subagents") &&
        !routineRun &&
        !telegram &&
        subagentsAllowedForGeneration({
          assistantMode: false,
          providerId: authority.provider.sourceProviderId,
          allowSubagents: true,
          usageSource: "chat",
          workspaceId: workspace.id,
          folderPath: workspace.folderPath,
          permission: "full",
        });
      const computerUse = has("computer_use") ? await computerUseFor(botId, facts.supportsImages) : undefined;
      if (!has("computer_use")) await closeController(botId);
      const connectionIds = authority.connections.map(({ sourceId }) => sourceId);
      const subagentSchema = createSubagentTool({
        execute: async () => {
          throw new Error("Subagents need a Bot conversation.");
        },
      });

      const built = await buildAgentTools({
        onMcpServerInstructions: collector.capture,
        allowMcpProviderAuth: false,
        workspaceId: workspace.id,
        workspaceRoot: workspace.folderPath,
        ...(skillSnapshot === undefined ? { includeSkillTools: false } : { skillSnapshot }),
        permission: "full",
        ...(computerUse === undefined ? {} : { computerUse }),
        allowScheduling: false,
        allowMcpTools: connectionIds.length > 0,
        mcpServerIds: connectionIds,
        allowSubagents: subagentsAllowed,
        ...(subagentsAllowed ? { createSubagentTool: () => subagentSchema } : {}),
        includeCodingTools: false,
      });
      const mcpNames = await facts.mcpTools();
      const tools: BotToolCandidate[] = built.map((tool) =>
        tool.name === SUBAGENT_TOOL ? subagentCandidate(botId, admission, tool) : { tool, ...(mcpNames.has(tool.name) ? { mcp: true } : {}) },
      );

      const locations = await botFileLocations(admission);
      if (locations.length > 0) {
        for (const tool of buildBotFileTools({ defaultLocation: locations[0]!, additionalLocations: locations.slice(1) })) {
          tools.push({ tool });
        }
      }
      if (authority.files.botHome) tools.push(shareImageCandidate(authority));
      if (authority.shell.enabled) {
        const shell = buildPinnedCodingTools(authority.workingDirectory).find(({ name }) => name === "run_command");
        if (shell) tools.push({ tool: shell });
      }
      if (!facts.supportsImages) {
        const vision = visionCandidate(authority, {
          revalidateBeforeEffect: async () => {
            const fresh = await deps.admit(botId);
            try {
              await fresh.revalidateBeforeEffect();
            } finally {
              fresh.release();
            }
          },
          dependencies: {
            resolveRuntime: (providerId, modelId, signal) => resolveBotModelRuntime(providerId, modelId, signal, authority.chatId),
            recordUsage: async (record) => {
              const { usageStore } = await import("../usage-store.js");
              await usageStore.record(record);
            },
          },
        });
        if (vision) tools.push(vision);
      }
      for (const tool of scheduleTaskToolsForContext({ bot: { botId, routineRun } })) {
        tools.push({ tool, replay: "unsafe" });
      }
      tools.push({
        tool: createSuggestConnectionTool(botId, {
          isConnected,
          isDismissed: (id, pluginId) => deps.dismissals.isDismissed(id, pluginId),
          appendConnectCard: (id, card) => deps.appendConnectCard(id, card),
          hasPendingCard: async (id, pluginId) => {
            const matching = (await deps.connectCards(id)).filter((card) => card.pluginId === pluginId);
            return matching[matching.length - 1]?.status === "pending";
          },
        }),
        replay: "unsafe",
      });
      return {
        tools,
        guidance: collector.snapshot(),
        ...(skillSnapshot === undefined ? {} : { skillSnapshot }),
      };
    },

    async approvalFor(botId, toolName, call) {
      if (toolName !== COMPUTER_USE_TOOL_NAME) return undefined;
      const controller = controllers.get(botId);
      if (!controller) throw new Error("Computer Use is not enabled for this response.");
      const args = call.args as ComputerUseArgs;
      const descriptor = await controller.approvalFor(args, call.signal);
      if (!descriptor) return null;
      return {
        summary: descriptor.summary,
        onAllow: () => controller.authorize(call.callId, args, descriptor),
      };
    },

    async shutdown() {
      await Promise.all([...controllers.keys()].map(closeController));
    },

    forgetBot: closeController,
  };
  return sources;
}
