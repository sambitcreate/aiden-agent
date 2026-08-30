import { createHash } from "node:crypto";
import {
  BOT_CAPABILITY_LIMITS,
  type BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
import { isNonChatModel } from "../../renderer/shared/model-eligibility.js";
import { isModelHidden } from "../../renderer/shared/model-visibility.js";
import type { AppSettings, McpServer, Provider } from "./types.js";
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
          supportsImages: metadata?.vision === true,
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
    const scope = server.enabled ? scopeByServer.get(server.id) : undefined;
    return {
      sourceId: server.id,
      label: server.name,
      description: server.enabled
        ? scope
          ? "Connected MCP tools"
          : "Unavailable until Aiden can verify this connection"
        : "Turned off in Aiden",
      available: Boolean(server.enabled && scope && scope.tools.length > 0),
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
      description: "Browser control is not currently available to ordinary Bot chats.",
      available: false,
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
      kind: "schedules",
      label: "Schedules",
      description: "Coming after scheduled runs can re-check this Bot's access at run time.",
      // Ordinary scheduled tasks persist a workspace/provider/MCP snapshot and
      // execute later without a live Bot audience or Bot capability admission.
      // Advertising that path would turn Full access into a delayed authority
      // bypass. Keep it unavailable until the scheduler stores Bot identity and
      // re-admits the run against current Bot/chat policy and managed home.
      available: false,
    },
    {
      kind: "subagents",
      label: "Subagents",
      description: "Delegate bounded parts of a task to Aiden subagents.",
      available: input.subagentsAvailable,
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
    async inspectSkills(signal, target) {
      const resolved = await dependencies.listSkills(target);
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
      const [settings, webSearchAvailability] = await Promise.all([
        dependencies.getSettings(),
        dependencies.webSearchAvailability(),
      ]);
      if (signal.aborted) throw signal.reason;
      return ordinaryInventory({
        settings,
        webSearchReady: webSearchAvailability.ready === true,
        subagentsAvailable: dependencies.subagentsAvailable(),
        computerUseSupported:
          dependencies.computerUseSupported?.() === true,
      });
    },
  };
}
