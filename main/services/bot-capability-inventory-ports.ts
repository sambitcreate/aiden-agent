import { createHash } from "node:crypto";
import {
  BOT_CAPABILITY_LIMITS,
  type BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
import { isNonChatModel } from "../../renderer/shared/model-eligibility.js";
import { isModelHidden } from "../../renderer/shared/model-visibility.js";
import type { AppSettings, McpServer, Provider } from "./types.js";
import { mcpServerOffersTools } from "../../renderer/shared/mcp-exposure.js";
import type { BotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import {
  botCapabilityFactsFingerprint,
  type BotConnectionInventory,
  type BotOrdinaryCapabilityInventory,
  type BotProviderInventory,
  type BotSkillInventory,
} from "./bot-capability-catalog-core.js";
import type {
  BotCapabilityInventoryPorts,
  BotMacFileInventory,
} from "./bot-capability-catalog-main.js";
import type { SubagentMcpScopeV2 } from "./subagents/authority-v2.js";
import { isAcpHarnessProvider } from "../../renderer/shared/acp-harness.js";

export interface BotCapabilityInventoryPortDependencies {
  loadOpaqueSelectionKey(): Promise<Uint8Array>;
  loadNoticeStatus(audienceId: string): Promise<BotNoticeStatus>;
  listProviders(): Promise<readonly Provider[]>;
  providerCredentialSignature(provider: Provider, signal: AbortSignal): Promise<string | undefined>;
  listMcpServers(): Promise<readonly McpServer[]>;
  inspectMcpScopes(signal: AbortSignal): Promise<readonly SubagentMcpScopeV2[]>;
  listSkills(target?: BotCapabilityInventoryTarget): Promise<readonly BotResolvedSkill[]>;
  listApprovedLocations(): Promise<readonly BotApprovedLocationInput[]>;
  incarnations: Pick<BotCapabilityIncarnationStore, "reconcileNamespace">;
  getSettings(): Promise<AppSettings>;
  /** Main-owned Web Search readiness; credentials and route details stay private. */
  webSearchAvailability(): Promise<Readonly<{ ready: boolean }>>;
  subagentsAvailable(): boolean;
  /** Host policy always narrows a persisted Computer Use preference. */
  computerUseSupported?: () => boolean;
  /** Browser settings let agents use Aiden's browser (a Bot's own browser follows them). */
  browserAgentAccess?: () => Promise<boolean>;
  /**
   * Bot computers are set up on a host that has them (Apple silicon), so a Bot
   * given a computer can use it. Each Bot still needs its own computer.
   */
  botComputersReady?: () => Promise<boolean>;
  shellFingerprint?: string;
  fullMacScopeFingerprint?: string;
  botHomeScopeFingerprint?: string;
}

export interface BotResolvedSkill {
  sourceId: string;
  label: string;
  description: string;
  instructions: string;
  available: boolean;
  /** Main-only incarnation partition; never projected into the public catalog. */
  incarnationPartition?: string;
}

export interface BotCapabilityInventoryTarget {
  botId: string;
}

export interface BotApprovedLocationInput {
  sourceId: string;
  label: string;
  description?: string;
  available: boolean;
  scopeFingerprint: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function providerInventory(
  provider: Provider,
  incarnation: { resourceIncarnation: string; credentialIncarnation: string },
): BotProviderInventory | null {
  if (!provider.id || !provider.label || provider.models.length === 0) return null;
  const available = provider.needsKey !== true || provider.hasKey === true;
  return {
    sourceId: provider.id,
    label: provider.label,
    available,
    connectionFingerprint: botCapabilityFactsFingerprint({
      id: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      needsKey: provider.needsKey,
      hasKey: provider.hasKey,
      deployment: provider.deployment ?? null,
      isBuiltin: provider.isBuiltin === true,
      resourceIncarnation: incarnation.resourceIncarnation,
      credentialIncarnation: incarnation.credentialIncarnation,
    }),
    models: provider.models.flatMap((modelId) => {
      const metadata = provider.modelMetadata?.[modelId];
      if (!modelId || isNonChatModel({ model: modelId, metadataType: metadata?.type })) return [];
      return [
        {
          sourceId: modelId,
          label: metadata?.name ?? modelId,
          available,
          supportsImages: (metadata?.overrides?.vision ?? metadata?.vision) === true && metadata?.overrides?.maxImages !== 0,
          modelFingerprint: botCapabilityFactsFingerprint({
            providerId: provider.id,
            modelId,
            metadata: metadata ?? null,
          }),
        },
      ];
    }),
  };
}

/**
 * The canonical provider list also contains setup choices that are not usable
 * yet and can exceed the intentionally smaller Bot wire bounds. Keep the same
 * authority as ordinary chat while projecting only configured chat models in
 * stable provider/model order.
 */
function botCatalogProviderInputs(
  providers: readonly Provider[],
  hiddenModelsByProvider: AppSettings["hiddenModelsByProvider"],
  retained: readonly { sourceProviderId: string; sourceModelId: string }[] = [],
): Provider[] {
  const selected: Provider[] = [];
  let remainingModels: number = BOT_CAPABILITY_LIMITS.modelsTotal;
  const providerById = new Map(providers.map((provider) => [provider.id, provider] as const));
  const retainedModels = new Map<string, string[]>();
  for (const { sourceProviderId, sourceModelId } of retained) {
    const provider = providerById.get(sourceProviderId);
    if (!provider?.models.includes(sourceModelId)) continue;
    const models = retainedModels.get(sourceProviderId) ?? [];
    if (!models.includes(sourceModelId)) models.push(sourceModelId);
    retainedModels.set(sourceProviderId, models);
  }
  const orderedProviders = [
    ...[...retainedModels.keys()].map((sourceProviderId) => providerById.get(sourceProviderId)),
    ...providers,
  ].filter(
    (provider, index, values): provider is Provider =>
      provider !== undefined &&
      values.findIndex((candidate) => candidate?.id === provider.id) === index,
  );

  for (const provider of orderedProviders) {
    if (selected.length >= BOT_CAPABILITY_LIMITS.providers || remainingModels === 0) break;
    if (provider.needsKey === true && provider.hasKey !== true) continue;
    // Agent harnesses need someone watching to answer approvals; Bots never qualify.
    if (isAcpHarnessProvider(provider.id)) continue;

    const seen = new Set<string>();
    const models: string[] = [];
    const orderedModels = [...(retainedModels.get(provider.id) ?? []), ...provider.models];
    for (const modelId of orderedModels) {
      if (
        models.length >= BOT_CAPABILITY_LIMITS.modelsPerProvider ||
        models.length >= remainingModels
      ) {
        break;
      }
      if (
        !modelId ||
        seen.has(modelId) ||
        (isModelHidden(hiddenModelsByProvider, provider.id, modelId) &&
          !(retainedModels.get(provider.id) ?? []).includes(modelId)) ||
        isNonChatModel({ model: modelId, metadataType: provider.modelMetadata?.[modelId]?.type })
      ) {
        continue;
      }
      seen.add(modelId);
      models.push(modelId);
    }
    if (models.length === 0) continue;
    remainingModels -= models.length;
    selected.push({ ...provider, models });
  }
  return selected;
}

function connectionInventory(
  servers: readonly McpServer[],
  scopes: readonly SubagentMcpScopeV2[],
): BotConnectionInventory[] {
  const scopeByServer = new Map(scopes.map((scope) => [scope.serverId, scope] as const));
  return servers.map((server) => {
    // A server switched off for the model is listed like a disabled one: no tools, unavailable.
    const offered = server.enabled && mcpServerOffersTools(server);
    const scope = offered ? scopeByServer.get(server.id) : undefined;
    return {
      sourceId: server.id,
      label: server.name,
      description: server.enabled
        ? !offered
          ? "Turned off for the model in Aiden"
          : scope
            ? "Connected MCP tools"
            : "Unavailable until Aiden can verify this connection"
        : "Turned off in Aiden",
      available: Boolean(offered && scope && scope.tools.length > 0),
      connectionFingerprint:
        scope?.connectionFingerprint ??
        botCapabilityFactsFingerprint({
          id: server.id,
          transport: server.transport,
          command: server.command ?? null,
          args: server.args ?? null,
          env: server.env ?? null,
          url: server.url ?? null,
          headers: server.headers ?? null,
          oauth: server.oauth === true,
          presetId: server.presetId ?? null,
          enabled: server.enabled,
          ...(mcpServerOffersTools(server) ? {} : { hiddenFromModel: true }),
          unavailable: true,
        }),
      tools: (scope?.tools ?? []).map((tool) => ({
        name: tool.toolName,
        inputSchemaFingerprint: tool.schemaHash,
        // The Bot inspector's canonical schema hash binds input and output.
        // Keep that combined contract explicit instead of pretending the
        // output half was independently projected.
        outputSchemaFingerprint: digest({ outputSchema: "not_declared" }),
        effect: tool.effect,
        effectFingerprint:
          tool.effect === "read" ? digest({ effect: "read" }) : tool.effectProfile.fingerprint,
      })),
    };
  });
}

function skillInventory(
  skills: readonly BotResolvedSkill[],
  incarnations: ReadonlyMap<string, { resourceIncarnation: string }>,
): BotSkillInventory[] {
  return skills.map((skill) => ({
    sourceId: skill.sourceId,
    label: skill.label,
    description: skill.description,
    available: skill.available,
    identityFingerprint: botCapabilityFactsFingerprint({
      sourceId: skill.sourceId,
      label: skill.label,
      resourceIncarnation: incarnations.get(skill.sourceId)?.resourceIncarnation,
    }),
    contentFingerprint: botCapabilityFactsFingerprint({
      sourceId: skill.sourceId,
      label: skill.label,
      description: skill.description,
      instructions: skill.instructions,
      resourceIncarnation: incarnations.get(skill.sourceId)?.resourceIncarnation,
    }),
  }));
}

function ordinaryInventory(input: {
  settings: AppSettings;
  webSearchReady: boolean;
  subagentsAvailable: boolean;
  computerUseSupported: boolean;
  browserAgentAccess: boolean;
  botComputersReady: boolean;
}): BotOrdinaryCapabilityInventory[] {
  const values: Array<{
    kind: BotOrdinaryCapabilityInventory["kind"];
    label: string;
    description: string;
    available: boolean;
  }> = [
    {
      kind: "web",
      label: "Web search",
      description: "Search the web through Aiden's configured service.",
      available: input.webSearchReady,
    },
    {
      kind: "browser",
      label: "Browser",
      description: "Browse the web in its own browser, with its own sign-ins, which you can watch in its Browser tab.",
      available: input.browserAgentAccess,
    },
    {
      kind: "computer_use",
      label: "Computer Use",
      description: "Use the Mac visually through Aiden's existing attended controls.",
      available:
        input.computerUseSupported &&
        input.settings.computerUseEnabled === true,
    },
    {
      kind: "computer",
      label: "Bot computer",
      description: "Use its own computer, a macOS virtual machine apart from your Mac that you can watch and take over. Give it one in its profile.",
      available: input.botComputersReady,
    },
    {
      kind: "schedules",
      label: "Schedules",
      description: "Suggest Bot routines that post into this chat after you approve them.",
      // Bot routines use the Bot's own durable session. Each scheduled turn
      // re-admits its current Bot/chat authority before inference and each
      // tool effect; it never inherits an ordinary task's saved workspace or
      // provider snapshot. A disabled scheduler cannot deliver a wake-up.
      available: input.settings.scheduledTasksEnabled !== false,
    },
    {
      kind: "subagents",
      label: "Subagents",
      description: "Delegate bounded parts of a task to Aiden subagents.",
      available: input.subagentsAvailable,
    },
    {
      kind: "tasks",
      label: "Task tracking",
      description: "Keep a saved checklist and show progress for multi-step work.",
      available: true,
    },
  ];
  return values.map((value) => ({
    ...value,
    capabilityFingerprint: botCapabilityFactsFingerprint({
      kind: value.kind,
      available: value.available,
      contract: "aiden-bot-capability-v1",
    }),
  }));
}

/** Build the production-shaped catalog ports without importing Electron globals. */
export function createBotCapabilityInventoryPorts(
  dependencies: BotCapabilityInventoryPortDependencies,
): BotCapabilityInventoryPorts {
  return {
    loadOpaqueSelectionKey: () => dependencies.loadOpaqueSelectionKey(),
    loadNoticeStatus: (audienceId) => dependencies.loadNoticeStatus(audienceId),
    async listProviders(signal, retained) {
      if (signal.aborted) throw signal.reason;
      const [allProviders, settings] = await Promise.all([
        dependencies.listProviders(),
        dependencies.getSettings(),
      ]);
      const configuredProviders = allProviders.filter(
        (provider) => provider.needsKey !== true || provider.hasKey === true,
      );
      const signatures = await Promise.all(
        configuredProviders.map(async (provider) => ({
          provider,
          signature: await dependencies.providerCredentialSignature(provider, signal),
        })),
      );
      const signatureByProvider = new Map(
        signatures.flatMap(({ provider, signature }) =>
          signature === undefined ? [] : [[provider.id, signature] as const],
        ),
      );
      const configured = botCatalogProviderInputs(
        configuredProviders.filter((provider) => signatureByProvider.has(provider.id)),
        settings.hiddenModelsByProvider,
        retained,
      );
      const incarnations = await dependencies.incarnations.reconcileNamespace(
        "provider",
        configured.map((provider) => ({
          sourceId: provider.id,
          credentialSignature: signatureByProvider.get(provider.id)!,
        })),
      );
      const byId = new Map(incarnations.map((value) => [value.sourceId, value] as const));
      const providers = configured.flatMap((provider) => {
        const incarnation = byId.get(provider.id);
        if (!incarnation) return [];
        const projected = providerInventory(provider, incarnation);
        return projected && projected.models.length > 0 ? [projected] : [];
      });
      if (signal.aborted) throw signal.reason;
      return providers;
    },
    async inspectMacFiles(signal): Promise<BotMacFileInventory> {
      if (signal.aborted) throw signal.reason;
      return {
        fullMac: {
          available: true,
          scopeFingerprint:
            dependencies.fullMacScopeFingerprint ??
            digest({ contract: "aiden-full-mac-v1", platform: process.platform }),
        },
        botHome: {
          available: true,
          scopeFingerprint:
            dependencies.botHomeScopeFingerprint ?? digest({ contract: "aiden-bot-home-v1" }),
        },
        approvedLocations: [...(await dependencies.listApprovedLocations())],
      };
    },
    async inspectShell(signal) {
      if (signal.aborted) throw signal.reason;
      return {
        available: true,
        shellFingerprint:
          dependencies.shellFingerprint ??
          digest({ contract: "aiden-coding-tools-shell-v1", platform: process.platform }),
      };
    },
    async inspectConnections(signal) {
      const [servers, scopes] = await Promise.all([
        dependencies.listMcpServers(),
        dependencies.inspectMcpScopes(signal),
      ]);
      if (signal.aborted) throw signal.reason;
      return connectionInventory(servers, scopes);
    },
    async skillsEnabled() {
      return (await dependencies.getSettings()).skillsEnabled !== false;
    },
    async inspectSkills(signal, target) {
      if (signal.aborted) throw signal.reason;
      // A global pause is not removal: do not tombstone durable incarnations or
      // discover instructions until the user enables Skills again.
      if ((await dependencies.getSettings()).skillsEnabled === false) return [];
      const resolved = await dependencies.listSkills(target);
      if ((await dependencies.getSettings()).skillsEnabled === false) return [];
      if (signal.aborted) throw signal.reason;
      const partitions = new Set([
        "global",
        ...(target ? [`bot:${target.botId}`] : []),
        ...resolved.map(({ incarnationPartition }) => incarnationPartition ?? "global"),
      ]);
      const incarnations = (
        await Promise.all(
          [...partitions].map((partition) =>
            dependencies.incarnations.reconcileNamespace(
              "skill",
              resolved
                .filter((skill) => (skill.incarnationPartition ?? "global") === partition)
                .map((skill) => ({
                  sourceId: skill.sourceId,
                  credentialSignature: digest({ contract: "aiden-skill-no-credential-v1" }),
                })),
              { partition },
            ),
          ),
        )
      ).flat();
      const skills = skillInventory(
        resolved,
        new Map(incarnations.map((value) => [value.sourceId, value] as const)),
      );
      if (signal.aborted) throw signal.reason;
      return skills;
    },
    async inspectOtherCapabilities(signal) {
      const [settings, webSearchAvailability, browserAgentAccess, botComputersReady] = await Promise.all([
        dependencies.getSettings(),
        dependencies.webSearchAvailability(),
        dependencies.browserAgentAccess?.() ?? Promise.resolve(false),
        // An unreadable Bot computers state offers nothing rather than failing the catalog.
        dependencies.botComputersReady?.().catch(() => false) ?? Promise.resolve(false),
      ]);
      if (signal.aborted) throw signal.reason;
      return ordinaryInventory({
        settings,
        webSearchReady: webSearchAvailability.ready === true,
        subagentsAvailable: dependencies.subagentsAvailable(),
        computerUseSupported:
          dependencies.computerUseSupported?.() === true,
        browserAgentAccess: browserAgentAccess === true,
        botComputersReady: botComputersReady === true,
      });
    },
  };
}
