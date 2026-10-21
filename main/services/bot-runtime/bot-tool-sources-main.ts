// Production candidate tools for durable Bot turns, built by the same legacy
// factories and gates `llm-client.ts` used for Bot generations:
//
// - `buildAgentTools` for MCP connection tools (exact Bot connection ids,
//   strict, no provider-authenticated servers), skills (the Bot-filtered
//   snapshot), web search, Computer Use and the subagent tool;
// - the Bot file router, the pinned shell, the Bot routine tool and
//   `suggest_connection`;
// - `share_image` and companion vision `inspect_image` through the durable
//   bindings in `bot-tool-candidates.ts`;
// - the Bot's own browser (`bot-browser-tools.ts`): the `browser` gateway and
//   the browser tools without page scripts or recording;
// - the Bot's own computer (`bot-computers/computer-tool.ts`): `computer` and
//   `computer_shell`, when the Bot has the capability and a computer;
// - the cards a person answers: `ask_user_question`, `hand_off` and `sign_in`.
//
// Policy is applied afterwards by `bot-tool-assembly.ts`. This module only
// builds; it never decides what a Bot may use.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { compactionEngineFrom } from "../../../renderer/shared/compaction.js";
import type { ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import { resolveBotRuntimeSkills } from "../bot-capability-services-main.js";
import type { BotConnectionDismissalStore } from "../bot-connection-dismissals.js";
import { buildBotFileTools, type BotFileToolLocation } from "../bot-file-tool-router.js";
import { resolveBotRuntimeApprovedRoots, resolveBotRuntimeCatalogSnapshot } from "../bot-runtime-authority-main.js";
import { createSuggestConnectionTool, isBotConnectionReady } from "../bot-runtime-tools/suggest-connection.js";
import { buildPinnedCodingTools } from "../coding-tools.js";
import { createComputerUseController } from "../computer-use/runtime.js";
import { computerUseSupported } from "../computer-use/platform.js";
import { computerUseStatus } from "../computer-use/status.js";
import type { ComputerUseController } from "../computer-use/controller.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import { logger } from "../../platform.js";
import { mcpPresetKeyBinding } from "../mcp-credential-cleanup-core.js";
import { hasOAuthTokens } from "../mcp-oauth.js";
import { presetSecretId } from "../mcp-presets.js";
import { mcpAgentToolIdentity } from "../mcp-tool-identity.js";
import { secrets } from "../secrets.js";
import { resolveBotModelRuntime } from "../model-runtime.js";
import { skillRegistry } from "../skill-registry-main.js";
import { inheritedSubagentReadToolCeiling } from "../subagents/capability-profile.js";
import { subagentsAllowedForGeneration } from "../subagents/eligibility.js";
import { subagentHealthMetrics } from "../subagents/subagent-health-metrics.js";
import { SubagentSupervisor } from "../subagents/subagent-supervisor.js";
import { createSubagentTool } from "../subagents/subagent-tool.js";
import { buildAgentTools } from "../tools.js";
import { botMcpLiveToolMatchesGrant } from "../bot-tool-authority.js";
import { collectMcpAgentTools } from "../mcp.js";
import { mcpAgentToolDescriptor } from "../mcp-agent-tool-descriptor.js";
import type { BotTurnContext } from "./bot-extension.js";
import type { BotAdmission, BotCandidateSet, BotToolCandidate, BotToolSources } from "./bot-tool-assembly.js";
import {
  routineNotesCandidate,
  routinesCandidate,
  routineTaskIdOfRun,
  shareImageCandidate,
  visionCandidate,
} from "./bot-tool-candidates.js";
import type { BotToolCall } from "./tool-adapter.js";
import { botComputerUseApproval } from "./bot-computer-use-approval.js";
import { botQuestionCandidate } from "./bot-question-tool.js";
import { botQuestions } from "./bot-questions-main.js";
import { botHandoffCandidate } from "./bot-handoff-tool.js";
import { botHandoffs } from "./bot-handoffs-main.js";
import { signInCandidate } from "./bot-sign-in-tool.js";
import { createBotToolFacts, type BotToolFactsWithSkills } from "./bot-tool-facts.js";
import { SUBAGENT_TOOL } from "./bot-tool-policy.js";
import { isBrowserToolName } from "../browser-tools.js";
import { botBrowser } from "./bot-browser-main.js";
import { BOT_BROWSER_GATEWAY_TOOL } from "./bot-tool-disclosure.js";
import { botComputerAction } from "./bot-computer-approval.js";
import { createBotComputerShellTool } from "../bot-computers/computer-shell-tool.js";
import { createBotComputerTool, createBotComputerToolState, type BotComputerToolState } from "../bot-computers/computer-tool.js";
import { BOT_COMPUTER_SHELL_TOOL_NAME, BOT_COMPUTER_TOOL_NAME } from "../bot-computers/types.js";

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
  /** The Bot's name, for what its browser tells the person. */
  botName?(botId: string): Promise<string | undefined>;
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

/** Whether a suggested plugin is set up, switched on, and signed in (the connect card's "Connected" state). */
export function isConnected(pluginId: string): Promise<boolean> {
  return isBotConnectionReady(pluginId, {
    listServers: () => configStore.listMcpServers(),
    hasPresetKey: async (server) =>
      Boolean(
        await secrets.getOrBindLegacyProviderKey(
          presetSecretId(server.id),
          mcpPresetKeyBinding(server),
        ),
      ),
    hasOAuthTokens: (server, preset) =>
      hasOAuthTokens(
        server.id,
        server.url ?? preset.url,
        server.authServerMetadataUrl,
        server.oauthClientName,
      ),
  });
}

// Routine services load lazily: they import the scheduler, which must not
// load while the Bot runtime module graph is still initializing.
const routineServices = () => import("../scheduled-bot-routines-main.js");
const proposalServices = () => import("../bot-routine-proposals-main.js");

const botRoutineToolDependencies: Parameters<typeof routinesCandidate>[1] = {
  list: async (botId) => (await routineServices()).botRoutineService.list(botId),
  pause: async (botId, routineId) => (await routineServices()).botRoutineService.pause(botId, routineId),
  propose: async (botId, input, append) => {
    const outcome = await (await proposalServices()).botRoutineProposals.propose(botId, input, append);
    return outcome.ok ? { ok: true, proposalId: outcome.proposal.proposalId } : outcome;
  },
};

const lazyRoutineNotes = {
  set: async (botId: string, taskId: string, key: unknown, value: unknown) =>
    (await routineServices()).botRoutineNotes.set(botId, taskId, key, value),
  delete: async (botId: string, taskId: string, key: unknown) =>
    (await routineServices()).botRoutineNotes.delete(botId, taskId, key),
};

/** The routine task id of the run making `call`, from the Bot's live session. */
async function routineTaskIdOfCall(botId: string, call: BotToolCall): Promise<string | undefined> {
  const { botSessionRuntime } = await import("./bot-session-main.js");
  const runtime = await botSessionRuntime();
  const conversation = await runtime.conversation(botId);
  return routineTaskIdOfRun(await call.entries(), {
    runningSubmissionId: async () => {
      const state = await runtime.state(botId);
      return state.kind === "running" ? state.submissionId : undefined;
    },
    submissionIdOf: async (requestId) => {
      const submission = await conversation.commit(
        (tx) => tx.submissionByRequest(conversation.id, requestId),
        BACKGROUND_CONTEXT,
      );
      return submission === undefined ? undefined : String(submission.id);
    },
  });
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

// Bot computers load lazily, and only where the platform has them.
const botComputerServices = () => import("../bot-computers/bot-computers-main.js");
let botComputerToolState: BotComputerToolState | undefined;

/** Whether the Bot has its own computer. Never on Linux or Intel Macs; an unreadable state counts as none. */
async function botHasComputer(botId: string): Promise<boolean> {
  const { botComputers, botComputersEnabled } = await botComputerServices();
  if (!botComputersEnabled()) return false;
  return (await botComputers().host.computer(botId).catch(() => undefined)) !== undefined;
}

export interface BotToolSourcesMain extends BotToolSources {
  /** Close every Bot's Computer Use controller and browser state (app quit). */
  shutdown(): Promise<void>;
  /** Close one Bot's Computer Use controller and browser tabs (Bot deleted). */
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
   * The Bot's Computer Use controller: platform support, the global beta, an
   * existing grant (Always allow, or the Bot chat was allowed from a desktop
   * turn) and a ready driver. The durable runtime cannot raise the
   * once-per-chat access card, so an ungranted Bot never gets the tool. A
   * controller lives across the Bot's turns until it is no longer allowed,
   * the Bot is deleted, or the app quits.
   */
  async function computerUseGranted(botId: string): Promise<boolean> {
    const chat = await chatStore.get(await deps.canonicalChatId(botId));
    const settings = await configStore.getSettings();
    return (
      computerUseSupported() &&
      settings.computerUseEnabled === true &&
      (settings.computerUseAlwaysAllow === true || chat?.computerUseAllowed === true)
    );
  }

  async function computerUseFor(botId: string, supportsImages: boolean): Promise<ComputerUseController | undefined> {
    if (!(await computerUseGranted(botId))) {
      await closeController(botId);
      return undefined;
    }
    const status = await computerUseStatus.status({});
    if (!status.ready) {
      logger.warn("bots", `Computer Use is allowed for Bot ${botId} but is not ready. ${status.detail}`);
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

  // The MCP tools each Bot's last candidate build produced; policy facts join
  // grants to these by identity rather than recomputing tool names.
  const builtMcpTools = new Map<string, readonly AgentTool[]>();

  const sources: BotToolSourcesMain = {
    async facts(botId, admission): Promise<ProductionFacts> {
      const authority = admission.authority;
      const catalog = once(() => resolveBotRuntimeCatalogSnapshot(authority));
      const computerGranted = authority.otherCapabilities.some((grant) => grant.kind === "computer");
      return createBotToolFacts({
        admission,
        supportsImages: await deps.imageInput(botId),
        fileLocations: (await botFileLocations(admission)).length,
        hasComputer: computerGranted && (await botHasComputer(botId)),
        catalog: async () => (await catalog()).resources,
        mcpTools: async () => builtMcpTools.get(botId) ?? [],
        liveMcpTools: async () => {
          const servers = (await configStore.listMcpServers()).filter((server) =>
            authority.connections.some(({ sourceId }) => sourceId === server.id),
          );
          // The same live inventory (and reused tool objects) the turn's tools are built from.
          const tools = await collectMcpAgentTools(servers, { strict: true });
          return new Map(
            tools.flatMap((tool) => {
              const descriptor = mcpAgentToolDescriptor(tool);
              return descriptor && mcpAgentToolIdentity(tool) ? [[tool.name, descriptor] as const] : [];
            }),
          );
        },
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
      builtMcpTools.set(botId, built.filter((tool) => mcpAgentToolIdentity(tool) !== undefined));
      const mcpNames = await facts.mcpTools();
      const tools: BotToolCandidate[] = built.flatMap((tool): BotToolCandidate[] => {
        if (tool.name === SUBAGENT_TOOL) return [subagentCandidate(botId, admission, tool)];
        const grant = mcpNames.get(tool.name);
        if (!grant) return [{ tool }];
        // The built tool itself must be the granted tool, not only a same-named one.
        return botMcpLiveToolMatchesGrant(grant, mcpAgentToolDescriptor(tool)) ? [{ tool, mcp: true }] : [];
      });
      // The Bot's own computer. Routines may use it unattended (§8.7); the
      // screen is vision only, so a model without image input gets the shell alone.
      if (has("computer") && facts.hasComputer) {
        const { botComputers } = await botComputerServices();
        const computers = botComputers();
        const state = (botComputerToolState ??= createBotComputerToolState(computers.control));
        const botName = async (id: string) => (await deps.botName?.(id).catch(() => undefined)) ?? "The Bot";
        // No one answers a card on routine and Telegram runs, so there is no hand_off there.
        const computerTurn = { routine: routineRun, unattended: routineRun || telegram };
        if (facts.supportsImages) {
          // The guest driver lane, only for a computer whose base passed its probe.
          const elementControl = (await computers.host.guestDriver(botId).catch(() => undefined)) !== undefined;
          tools.push({
            tool: createBotComputerTool(
              botId,
              { host: computers.host, sessions: computers.sessions, control: computers.control, state, botName },
              { ...computerTurn, elementControl },
            ),
            replay: "unsafe",
          });
        }
        tools.push({
          tool: createBotComputerShellTool(botId, { host: computers.host, control: computers.control, botName }, computerTurn),
          replay: "unsafe",
        });
      }
      // The Bot's own browser. Never on routine or Telegram turns: nobody is
      // there to approve a click or use a held tab (blueprint G12).
      if (has("browser") && !routineRun && !telegram) {
        tools.push(
          ...(await botBrowser.candidates(botId, {
            workspaceId: workspace.id,
            chatId: await deps.canonicalChatId(botId),
            generationId: `bot:${botId}:${turn.requestId ?? "turn"}`,
            supportsImages: facts.supportsImages,
            botName: (await deps.botName?.(botId).catch(() => undefined)) ?? "this Bot",
          })),
        );
      }

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
      // Both are always installed; ingress (`botIngressAllowsTool`) keeps
      // `routines` off routine and Telegram runs and `routine_notes` on routine runs only.
      tools.push(routinesCandidate(botId, botRoutineToolDependencies));
      tools.push(routineNotesCandidate(botId, { notes: lazyRoutineNotes, taskIdOf: (call) => routineTaskIdOfCall(botId, call) }));
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
      // Routine and Telegram turns are filtered out by the offer-time verdict (bot-tool-policy.ts).
      tools.push(botQuestionCandidate(botId, botQuestions));
      tools.push(botHandoffCandidate(botId, botHandoffs));
      // Needs the Browser or a computer in the Bot's access; the verdict keeps it off otherwise.
      const signInOnComputer = has("computer") && facts.hasComputer;
      tools.push(
        signInCandidate(botId, botHandoffs, {
          ...(deps.botName ? { botName: deps.botName } : {}),
          targets: { browser: has("browser"), computer: signInOnComputer },
          hasBrowser: async () => has("browser"),
          hasComputer: async () => signInOnComputer,
        }),
      );
      return {
        tools,
        ...(skillSnapshot === undefined ? {} : { skillSnapshot }),
      };
    },

    // A tool whose approval depends on live state, and what the call does for
    // the Bot rules classifier. Other tools defer to the policy (`undefined`).
    async approvalFor(botId, toolName, call) {
      switch (toolName) {
        case COMPUTER_USE_TOOL_NAME: {
          const controller = controllers.get(botId);
          if (!controller) throw new Error("Computer Use is not enabled for this response.");
          return botComputerUseApproval(controller, call, {
            granted: () => computerUseGranted(botId),
            revoke: () => closeController(botId),
          });
        }
        // Allowed inside the Bot's own computer; the rules read the stated intent.
        case BOT_COMPUTER_TOOL_NAME:
          return botComputerAction(call, botComputerToolState?.driverFacts(botId));
        // A guest shell command: allowed, and not something the rules can read.
        case BOT_COMPUTER_SHELL_TOOL_NAME:
          return undefined;
        default:
          // The browser gateway and tools: the live tab, page and targeted field.
          if (toolName === BOT_BROWSER_GATEWAY_TOOL || isBrowserToolName(toolName)) {
            return botBrowser.approvalFor(botId, toolName, call);
          }
          return undefined;
      }
    },

    async shutdown() {
      botBrowser.shutdown();
      await Promise.all([...controllers.keys()].map(closeController));
      await botComputerToolState?.shutdown();
    },

    async forgetBot(botId) {
      await closeController(botId);
      // The host deletes the Bot's computer on its own Delete Bot step.
      botComputerToolState?.forget(botId);
      // Bot delete clears the browser profile, closing any tab left, on its own step.
      await botBrowser.forget(botId).catch((error: unknown) => logger.warn("bots", `Could not close Bot ${botId}'s browser tabs.`, error));
    },
  };
  return sources;
}
