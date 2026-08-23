import type { BotDefinition } from "../../renderer/shared/bots.js";
import {
  BotCapabilityValidationError,
  type BotAccessView,
  type BotChatAccessView,
} from "../../renderer/shared/bot-capabilities.js";
import {
  BotCapabilityBindingDriftError,
  bindBotCustomSelection,
  type BoundBotConnection,
  type BoundBotCustomSelection,
  type BoundBotFileScope,
  type BoundBotOrdinaryCapability,
  type BoundBotProviderModel,
  type BoundBotSkill,
} from "./bot-capability-bindings.js";
import type { BotCapabilityCatalogMainService } from "./bot-capability-catalog-main.js";
import { retainedBotProviderForChat } from "./bot-capability-retained-provider.js";
import type {
  BotCapabilityCatalogSnapshot,
  BotCatalogConnectionResource,
  BotCatalogFileScopeResource,
  BotCatalogOrdinaryCapabilityResource,
  BotCatalogProviderResource,
  BotCatalogSkillResource,
  BotOrdinaryCapabilityKind,
} from "./bot-capability-catalog-core.js";
import type { BotCapabilityAuthorityLease } from "./bot-capability-lease.js";
import {
  botRuntimeInventoryLeases,
  type BotRuntimeInventoryLease,
  type BotRuntimeInventoryLeaseRegistry,
} from "./bot-runtime-inventory-lease.js";
import type { BotCapabilityAdmission, BotCapabilityStore } from "./bot-capability-store.js";
import type {
  BotManagedWorkspaceCore,
  BotManagedWorkspaceIncarnation,
  BotManagedWorkspaceResolution,
} from "./bot-managed-workspace-core.js";
import type { ChatStore } from "./chat-store-core.js";
import type { Chat } from "./types.js";
import type { BotStore } from "./bot-store-core.js";

/** Fixed, renderer-safe classifications. Causes and private inventory never cross this boundary. */
export const BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES = Object.freeze({
  bot_unavailable: "This Bot is not available to act.",
  chat_unavailable: "This Bot chat is not available to act.",
  access_unavailable: "This Bot's access is not available. Review its access settings.",
  provider_mismatch: "This Bot chat's AI connection no longer matches its access settings.",
  capability_changed: "This Bot's available capabilities changed. Start again after reviewing access.",
  managed_home_changed: "This Bot's managed folder changed. Restart Aiden to verify it safely.",
} as const);

export type BotRuntimeAuthorityFailure = keyof typeof BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES;

export class BotRuntimeAuthorityError extends Error {
  readonly name = "BotRuntimeAuthorityError";

  constructor(readonly classification: BotRuntimeAuthorityFailure) {
    super(BOT_RUNTIME_AUTHORITY_FAILURE_MESSAGES[classification]);
  }
}

export interface BotRuntimeProviderAuthority {
  readonly sourceProviderId: string;
  readonly sourceModelId: string;
  readonly connectionFingerprint: string;
  readonly providerExactFingerprint: string;
  readonly modelFingerprint: string;
  readonly modelExactFingerprint: string;
}

export function assertBotRuntimeProviderSelection(
  authority: Pick<BotRuntimeProviderAuthority, "sourceProviderId" | "sourceModelId">,
  selection: { providerId: string; model: string },
): void {
  if (
    authority.sourceProviderId !== selection.providerId ||
    authority.sourceModelId !== selection.model
  ) {
    throw new BotRuntimeAuthorityError("provider_mismatch");
  }
}

export interface BotRuntimeFileScopeAuthority {
  readonly sourceId: string;
  readonly scopeFingerprint: string;
  readonly exactFingerprint: string;
}

export interface BotRuntimeFileAuthority {
  readonly mode: "full_mac" | "scoped" | "off";
  readonly botHome: boolean;
  readonly fullMac?: BotRuntimeFileScopeAuthority;
  readonly approvedLocations: readonly BotRuntimeFileScopeAuthority[];
}

export interface BotRuntimeMcpToolAuthority {
  /** Exact main-owned tool identity; display names are never treated as grant ids. */
  readonly toolId: string;
  readonly name: string;
  readonly effect: "read" | "mutating";
  readonly inputSchemaFingerprint: string;
  readonly outputSchemaFingerprint: string;
  readonly effectFingerprint: string;
  readonly exactFingerprint: string;
}

export interface BotRuntimeConnectionAuthority {
  readonly sourceId: string;
  readonly connectionFingerprint: string;
  readonly toolsetFingerprint: string;
  readonly exactFingerprint: string;
  readonly tools: readonly BotRuntimeMcpToolAuthority[];
}

export interface BotRuntimeSkillAuthority {
  readonly sourceId: string;
  readonly identityFingerprint: string;
  readonly contentFingerprint: string;
  readonly exactFingerprint: string;
}

export interface BotRuntimeOtherAuthority {
  readonly kind: BotOrdinaryCapabilityKind;
  readonly capabilityFingerprint: string;
  readonly exactFingerprint: string;
}

export interface BotRuntimeManagedHomeAuthority {
  readonly botId: string;
  readonly workspaceId: string;
  readonly createdAt: number;
  readonly incarnation: Readonly<BotManagedWorkspaceIncarnation>;
}

/**
 * Exact main-only authority. It deliberately has no public/IPC projection and
 * never contains catalog labels, notices, credentials, or raw stored bindings.
 */
export interface BotRuntimeEffectiveAuthority {
  readonly audienceId: string;
  readonly botId: string;
  readonly chatId: string;
  readonly accessMode: "full" | "custom";
  readonly botPolicy: Readonly<{ revision: string; epoch: string }>;
  readonly chatPolicy: Readonly<{
    mode: "inherit" | "custom";
    revision: string;
    epoch: string;
  }>;
  readonly catalogRevision: string;
  readonly provider: Readonly<BotRuntimeProviderAuthority>;
  readonly files: Readonly<BotRuntimeFileAuthority>;
  readonly shell: Readonly<{
    enabled: boolean;
    shellFingerprint?: string;
    exactFingerprint?: string;
  }>;
  readonly connections: readonly Readonly<BotRuntimeConnectionAuthority>[];
  readonly skills: readonly Readonly<BotRuntimeSkillAuthority>[];
  readonly otherCapabilities: readonly Readonly<BotRuntimeOtherAuthority>[];
  readonly managedHome: Readonly<BotRuntimeManagedHomeAuthority>;
  /** Main-only cwd/default artifact destination. Never send this object over IPC. */
  readonly workingDirectory: string;
}

export interface BotRuntimeAuthorityAdmission {
  readonly authority: Readonly<BotRuntimeEffectiveAuthority>;
  readonly signal: AbortSignal;
  /** Async fence that runtime/tool callers must await immediately before every effect. */
  revalidateBeforeEffect(): Promise<void>;
  release(): void;
}

type BotStorePort = Pick<BotStore, "get">;
type ChatStorePort = Pick<ChatStore, "get">;
type CapabilityStorePort = Pick<
  BotCapabilityStore,
  | "admit"
  | "getBotBinding"
  | "getBotPolicy"
  | "getChatPolicy"
  | "assertAuthorityBindingsCurrent"
>;
type CatalogPort = Pick<BotCapabilityCatalogMainService, "snapshotForRuntime">;
type ManagedWorkspacePort = Pick<BotManagedWorkspaceCore, "resolve" | "revalidate">;

export interface BotRuntimeAuthorityDependencies {
  botStore: BotStorePort;
  chatStore: ChatStorePort;
  capabilityStore: CapabilityStorePort;
  catalog: CatalogPort;
  managedWorkspace: ManagedWorkspacePort;
  inventoryLeases?: Pick<BotRuntimeInventoryLeaseRegistry, "acquire">;
}

function fail(classification: BotRuntimeAuthorityFailure): never {
  throw new BotRuntimeAuthorityError(classification);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function providerAuthority(provider: BoundBotProviderModel): BotRuntimeProviderAuthority {
  return {
    sourceProviderId: provider.sourceProviderId,
    sourceModelId: provider.sourceModelId,
    connectionFingerprint: provider.connectionFingerprint,
    providerExactFingerprint: provider.providerExactFingerprint,
    modelFingerprint: provider.modelFingerprint,
    modelExactFingerprint: provider.modelExactFingerprint,
  };
}

function fullProviderAuthority(
  chat: Chat,
  resources: readonly BotCatalogProviderResource[],
): BotRuntimeProviderAuthority {
  if (!chat.providerId || !chat.model) fail("provider_mismatch");
  const provider = resources.find(
    (candidate) => candidate.option.available && candidate.sourceId === chat.providerId,
  );
  const model = provider?.models.find(
    (candidate) => candidate.option.available && candidate.sourceId === chat.model,
  );
  if (!provider || !model) fail("provider_mismatch");
  return {
    sourceProviderId: provider.sourceId,
    sourceModelId: model.sourceId,
    connectionFingerprint: provider.connectionFingerprint,
    providerExactFingerprint: provider.exactFingerprint,
    modelFingerprint: model.modelFingerprint,
    modelExactFingerprint: model.exactFingerprint,
  };
}

function scopeAuthority(
  scope: BotCatalogFileScopeResource | BoundBotFileScope,
): BotRuntimeFileScopeAuthority {
  return {
    sourceId: scope.sourceId,
    scopeFingerprint: scope.scopeFingerprint,
    exactFingerprint: scope.exactFingerprint,
  };
}

function fileAuthority(
  scopes: readonly (BotCatalogFileScopeResource | BoundBotFileScope)[],
): BotRuntimeFileAuthority {
  const available = scopes.filter((scope) => scope.option.available);
  const fullMac = available.find((scope) => scope.option.kind === "full_mac");
  // Full Mac includes the Bot's managed home, but the home remains the normal
  // working/default location. The Full Mac selector is an authority ceiling,
  // not a request to replace the Bot's cwd with the filesystem root.
  const botHome =
    Boolean(fullMac) || available.some((scope) => scope.option.kind === "bot_home");
  const approvedLocations = available
    .filter((scope) => scope.option.kind === "approved_location")
    .map(scopeAuthority);
  return {
    mode: fullMac ? "full_mac" : botHome || approvedLocations.length > 0 ? "scoped" : "off",
    botHome,
    ...(fullMac ? { fullMac: scopeAuthority(fullMac) } : {}),
    approvedLocations,
  };
}

function toolAuthority(
  tool: BotCatalogConnectionResource["tools"][number] | BoundBotConnection["tools"][number],
): BotRuntimeMcpToolAuthority {
  return {
    toolId: tool.exactFingerprint,
    name: tool.name,
    effect: tool.effect,
    inputSchemaFingerprint: tool.inputSchemaFingerprint,
    outputSchemaFingerprint: tool.outputSchemaFingerprint,
    effectFingerprint: tool.effectFingerprint,
    exactFingerprint: tool.exactFingerprint,
  };
}

function connectionAuthority(
  connection: BotCatalogConnectionResource | BoundBotConnection,
): BotRuntimeConnectionAuthority {
  return {
    sourceId: connection.sourceId,
    connectionFingerprint: connection.connectionFingerprint,
    toolsetFingerprint: connection.toolsetFingerprint,
    exactFingerprint: connection.exactFingerprint,
    tools: connection.tools.map(toolAuthority),
  };
}

function skillAuthority(skill: BotCatalogSkillResource | BoundBotSkill): BotRuntimeSkillAuthority {
  return {
    sourceId: skill.sourceId,
    identityFingerprint: skill.identityFingerprint,
    contentFingerprint: skill.contentFingerprint,
    exactFingerprint: skill.exactFingerprint,
  };
}

function otherAuthority(
  capability: BotCatalogOrdinaryCapabilityResource | BoundBotOrdinaryCapability,
): BotRuntimeOtherAuthority {
  return {
    kind: capability.kind,
    capabilityFingerprint: capability.capabilityFingerprint,
    exactFingerprint: capability.exactFingerprint,
  };
}

function customBinding(
  admission: BotCapabilityAdmission,
  snapshot: BotCapabilityCatalogSnapshot,
): BoundBotCustomSelection {
  if (!admission.effectiveCustom) fail("access_unavailable");
  try {
    return bindBotCustomSelection({
      selection: admission.effectiveCustom,
      catalogRevision: snapshot.catalog.revision,
      snapshot,
    });
  } catch {
    return fail("capability_changed");
  }
}

function assertProviderMatchesChat(chat: Chat, provider: BotRuntimeProviderAuthority): void {
  if (
    chat.providerId !== provider.sourceProviderId ||
    chat.model !== provider.sourceModelId
  ) {
    fail("provider_mismatch");
  }
}

function managedHomeAuthority(
  workspace: BotManagedWorkspaceResolution,
): BotRuntimeManagedHomeAuthority {
  return {
    botId: workspace.botId,
    workspaceId: workspace.workspaceId,
    createdAt: workspace.createdAt,
    incarnation: { ...workspace.incarnation },
  };
}

function buildAuthority(input: {
  audienceId: string;
  bot: BotDefinition;
  chat: Chat;
  workspace: BotManagedWorkspaceResolution;
  admission: BotCapabilityAdmission;
  snapshot: BotCapabilityCatalogSnapshot;
}): BotRuntimeEffectiveAuthority {
  const { admission, snapshot, chat } = input;
  if (!admission.chat) fail("access_unavailable");
  const binding = admission.effectiveCustom ? customBinding(admission, snapshot) : undefined;
  const provider = binding
    ? providerAuthority(binding.provider)
    : fullProviderAuthority(chat, snapshot.resources.providers);
  assertProviderMatchesChat(chat, provider);

  const full = binding === undefined;
  const files = fileAuthority(
    full
      ? snapshot.resources.fileScopes.filter(({ option }) => option.available)
      : binding.fileScopes,
  );
  const shell = full
    ? snapshot.resources.shell.available
      ? {
          enabled: true,
          shellFingerprint: snapshot.resources.shell.shellFingerprint,
          exactFingerprint: snapshot.resources.shell.exactFingerprint,
        }
      : { enabled: false as const }
    : binding.shell
      ? {
          enabled: true,
          shellFingerprint: binding.shell.shellFingerprint,
          exactFingerprint: binding.shell.exactFingerprint,
        }
      : { enabled: false as const };
  return freezeDeep({
    audienceId: input.audienceId,
    botId: input.bot.id,
    chatId: chat.id,
    accessMode: full ? "full" : "custom",
    botPolicy: {
      revision: admission.policy.revision,
      epoch: `epoch:${admission.policy.policyEpoch}`,
    },
    chatPolicy: {
      mode: admission.chat.mode,
      revision: admission.chat.revision,
      epoch: `epoch:${admission.chat.policyEpoch}`,
    },
    catalogRevision: snapshot.catalog.revision,
    provider,
    files,
    shell,
    connections: (full
      ? snapshot.resources.connections.filter(({ option }) => option.available)
      : binding.connections
    ).map(connectionAuthority),
    skills: (full
      ? snapshot.resources.skills.filter(({ option }) => option.available)
      : binding.skills
    ).map(skillAuthority),
    otherCapabilities: (full
      ? snapshot.resources.otherCapabilities.filter(({ option }) => option.available)
      : binding.otherCapabilities
    ).map(otherAuthority),
    managedHome: managedHomeAuthority(input.workspace),
    workingDirectory: input.workspace.homePath,
  });
}

function sameIdentity(
  bot: BotDefinition | null,
  chat: Chat | null,
  expected: BotRuntimeEffectiveAuthority,
): boolean {
  return Boolean(
    bot &&
      !bot.archivedAt &&
      bot.id === expected.botId &&
      chat &&
      chat.id === expected.chatId &&
      chat.botId === expected.botId &&
      chat.providerId === expected.provider.sourceProviderId &&
      chat.model === expected.provider.sourceModelId,
  );
}

function samePolicy(
  botPolicy: BotAccessView,
  chatPolicy: BotChatAccessView,
  expected: BotRuntimeEffectiveAuthority,
): boolean {
  return (
    botPolicy.botId === expected.botId &&
    botPolicy.revision === expected.botPolicy.revision &&
    botPolicy.policyEpoch === expected.botPolicy.epoch &&
    chatPolicy.botId === expected.botId &&
    chatPolicy.chatId === expected.chatId &&
    chatPolicy.revision === expected.chatPolicy.revision
  );
}

async function resolveIdentities(
  deps: BotRuntimeAuthorityDependencies,
  botId: string,
  chatId: string,
): Promise<{ bot: BotDefinition; chat: Chat }> {
  const [bot, chat] = await Promise.all([deps.botStore.get(botId), deps.chatStore.get(chatId)]);
  if (!bot || bot.archivedAt) fail("bot_unavailable");
  if (!chat || chat.botId !== botId) fail("chat_unavailable");
  return { bot, chat };
}

async function retainedBinding(
  deps: BotRuntimeAuthorityDependencies,
  botId: string,
): Promise<readonly BoundBotCustomSelection[] | undefined> {
  const binding = await deps.capabilityStore.getBotBinding(botId);
  return binding ? [binding] : undefined;
}

/** Main-owned turn/effect admission resolver. This service must never be exposed over IPC. */
export class BotRuntimeAuthorityResolver {
  constructor(private readonly deps: BotRuntimeAuthorityDependencies) {}

  async admit(input: {
    audienceId: string;
    botId: string;
    chatId: string;
  }): Promise<BotRuntimeAuthorityAdmission> {
    let lease: BotCapabilityAuthorityLease | undefined;
    let inventoryLease: BotRuntimeInventoryLease | undefined;
    try {
      inventoryLease = (this.deps.inventoryLeases ?? botRuntimeInventoryLeases).acquire();
      const { bot, chat } = await resolveIdentities(this.deps, input.botId, input.chatId);
      let workspace: BotManagedWorkspaceResolution;
      try {
        workspace = await this.deps.managedWorkspace.resolve(input.botId);
      } catch {
        fail("managed_home_changed");
      }
      // Legacy Bot chats intentionally retain their visible historical
      // workspace identity. Authority is bound by Bot/chat/policy identity;
      // execution is always projected into the independently verified home.
      let snapshot: BotCapabilityCatalogSnapshot;
      try {
        snapshot = await this.deps.catalog.snapshotForRuntime({
          botId: input.botId,
          retainedBindings: await retainedBinding(this.deps, input.botId),
          retainedProviders: retainedBotProviderForChat(chat),
        });
      } catch {
        fail("capability_changed");
      }
      inventoryLease.assertCurrent();
      let capabilityAdmission: BotCapabilityAdmission;
      try {
        capabilityAdmission = await this.deps.capabilityStore.admit({
          audienceId: input.audienceId,
          botId: input.botId,
          chatId: input.chatId,
          snapshot,
        });
      } catch (error) {
        if (
          error instanceof BotCapabilityBindingDriftError ||
          error instanceof BotCapabilityValidationError
        ) {
          fail("capability_changed");
        }
        throw error;
      }
      lease = capabilityAdmission.lease;
      const authority = buildAuthority({
        audienceId: input.audienceId,
        bot,
        chat,
        workspace,
        admission: capabilityAdmission,
        snapshot,
      });
      let released = false;
      const signal = AbortSignal.any([lease.signal, inventoryLease.signal]);
      const release = () => {
        if (released) return;
        released = true;
        lease!.release();
        inventoryLease!.release();
      };
      return Object.freeze({
        authority,
        signal,
        revalidateBeforeEffect: async () => {
          try {
            if (released) fail("capability_changed");
            try {
              lease!.assertCurrent();
              inventoryLease!.assertCurrent();
            } catch {
              fail("capability_changed");
            }
            const current = await resolveIdentities(this.deps, input.botId, input.chatId);
            if (!sameIdentity(current.bot, current.chat, authority)) fail("capability_changed");
            const [botPolicy, chatPolicy] = await Promise.all([
              this.deps.capabilityStore.getBotPolicy(input.botId),
              this.deps.capabilityStore.getChatPolicy(input.chatId),
            ]);
            if (!samePolicy(botPolicy, chatPolicy, authority)) fail("capability_changed");
            try {
              await this.deps.managedWorkspace.revalidate(workspace);
            } catch {
              fail("managed_home_changed");
            }
            const currentSnapshot = await this.deps.catalog.snapshotForRuntime({
              botId: input.botId,
              retainedBindings: await retainedBinding(this.deps, input.botId),
              retainedProviders: retainedBotProviderForChat(current.chat),
            });
            if (currentSnapshot.catalog.revision !== authority.catalogRevision) {
              fail("capability_changed");
            }
            try {
              await this.deps.capabilityStore.assertAuthorityBindingsCurrent({
                botId: input.botId,
                chatId: input.chatId,
                snapshot: currentSnapshot,
              });
            } catch {
              fail("capability_changed");
            }
            try {
              lease!.assertCurrent();
              inventoryLease!.assertCurrent();
            } catch {
              fail("capability_changed");
            }
          } catch (error) {
            release();
            if (error instanceof BotRuntimeAuthorityError) throw error;
            fail("capability_changed");
          }
        },
        release,
      });
    } catch (error) {
      lease?.release();
      inventoryLease?.release();
      if (error instanceof BotRuntimeAuthorityError) throw error;
      fail("access_unavailable");
    }
  }
}

export function createBotRuntimeAuthorityResolver(
  dependencies: BotRuntimeAuthorityDependencies,
): BotRuntimeAuthorityResolver {
  return new BotRuntimeAuthorityResolver(dependencies);
}
