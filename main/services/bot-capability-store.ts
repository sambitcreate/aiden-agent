import { randomBytes, randomUUID } from "node:crypto";
import {
  parseBotAccessUpdate,
  parseBotChatAccessUpdate,
  botCustomSelectionIsSubset,
  botCustomSelectionsEqual,
  validateSelectionAgainstCatalog,
  type BotAccessView,
  type BotCapabilityCatalog,
  type BotChatAccessView,
  type BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
import { DataStore } from "./data-store.js";
import {
  BotCapabilityCatalogConflictError,
  BotCapabilityRevisionConflictError,
  BotCapabilityStateEditor,
  BotCapabilitySubsetError,
  BotCapabilityUnavailableError,
  botChatTransitionNarrows,
  botPolicyTransitionNarrows,
  emptyBotCapabilityState,
  isSafeBotCapabilityState,
  parseBotCapabilityState,
  projectBotAccessView,
  projectBotChatAccessView,
  projectBotNoticeStatus,
  type BotCapabilityCoreDependencies,
  type BotCapabilityAuthorityStatus,
  type BotArchivedReadAuthoritySnapshot,
  type BotCapabilityIncarnation,
  type BotCapabilityIncarnationInput,
  type BotCapabilityIncarnationNamespace,
  type BotCapabilityIncarnationReconcileOptions,
  type BotCapabilityPolicyAudit,
  type BotCapabilityRevisionKind,
  type BotCapabilityState,
  type StoredBotCapabilityPolicy,
  type StoredBotChatCapabilityPolicy,
  type StoredBotModelAuthority,
} from "./bot-capability-store-core.js";
import {
  boundBotProviderModelFingerprint,
  parseBoundBotProviderModel,
  parseBoundBotCustomSelection,
  type BoundBotCustomSelection,
} from "./bot-capability-bindings.js";
import type { BotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import {
  BotCapabilityLeaseRegistry,
  botCapabilityLeases,
  type BotCapabilityAuthorityLease,
} from "./bot-capability-lease.js";
import {
  withBotCapabilityStateCheckpoint,
  type BotCapabilityStateCheckpoint,
} from "./bot-capability-state-checkpoint.js";

const BOT_CAPABILITY_STATE_FILE = "bot-capabilities.json";
const MAX_BOT_CAPABILITY_STATE_BYTES = 8 * 1024 * 1024;

export interface BotCapabilityPersistence {
  load(): Promise<BotCapabilityState>;
  save(state: BotCapabilityState, isCurrent?: () => boolean): Promise<void>;
  update<Result>(
    mutation: (draft: BotCapabilityState) => Result | Promise<Result>,
    isCurrent?: () => boolean,
  ): Promise<Result>;
  loadedFromCorruptFile(): Promise<boolean>;
  loadedFromUnsafeFile(): Promise<boolean>;
  loadedDiskContents(): Promise<Buffer | null>;
}

export interface BotCapabilityStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  mintRevision?: (kind: BotCapabilityRevisionKind, sequence: number) => string;
  mintIncarnation?: () => string;
  persistence?: BotCapabilityPersistence;
  leases?: BotCapabilityLeaseRegistry;
  checkpoint?: BotCapabilityStateCheckpoint;
}

export interface BotCapabilityAdmission {
  policy: StoredBotCapabilityPolicy;
  chat?: StoredBotChatCapabilityPolicy;
  effectiveCustom?: import("../../renderer/shared/bot-capabilities.js").BotCustomSelection;
  modelAuthority?: StoredBotModelAuthority;
  visionModelAuthority?: StoredBotModelAuthority;
  lease: BotCapabilityAuthorityLease;
}

function makePersistence(options: BotCapabilityStoreOptions): BotCapabilityPersistence {
  return new DataStore<BotCapabilityState>(
    options.filename ?? BOT_CAPABILITY_STATE_FILE,
    emptyBotCapabilityState(),
    options.root,
    {
      maxBytes: MAX_BOT_CAPABILITY_STATE_BYTES,
      fileMode: 0o600,
      normalize: (value) => {
        try {
          return parseBotCapabilityState(value);
        } catch {
          return emptyBotCapabilityState();
        }
      },
      isSafe: isSafeBotCapabilityState,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      rejectExternalChanges: true,
    },
  );
}

/** Main-owned durable Full/Custom policy, notice, and per-chat reduction store. */
export class BotCapabilityStore {
  private readonly persistence: BotCapabilityPersistence;
  private readonly dependencies: BotCapabilityCoreDependencies;
  private readonly leases: BotCapabilityLeaseRegistry;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: BotCapabilityStoreOptions = {}) {
    const persistence = options.persistence ?? makePersistence(options);
    this.persistence = options.checkpoint
      ? withBotCapabilityStateCheckpoint(persistence, options.checkpoint)
      : persistence;
    this.dependencies = {
      now: options.now ?? Date.now,
      mintRevision:
        options.mintRevision ??
        ((kind, sequence) => `revision:${kind}:${sequence}:${randomUUID()}`),
      mintIncarnation: options.mintIncarnation ?? (() => randomBytes(32).toString("base64url")),
    };
    this.leases = options.leases ?? botCapabilityLeases;
  }

  private serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new BotCapabilityUnavailableError("Bot access storage is not initialized.");
    }
  }

  private editor(state: BotCapabilityState): BotCapabilityStateEditor {
    return new BotCapabilityStateEditor(state, this.dependencies);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await this.persistence.load();
    if (await this.persistence.loadedFromCorruptFile()) {
      throw new BotCapabilityUnavailableError(
        "Bot access storage is unreadable and was preserved.",
      );
    }
    if (await this.persistence.loadedFromUnsafeFile()) {
      throw new BotCapabilityUnavailableError(
        "Bot access storage has an unsupported version and was preserved.",
      );
    }
    const state = parseBotCapabilityState(loaded);
    for (const policy of state.policies) {
      this.leases.publishBotEpoch(policy.botId, policy.policyEpoch);
    }
    for (const chat of state.chats) {
      this.leases.publishChatEpoch(chat.botId, chat.chatId, chat.policyEpoch);
    }
    // Publish a safe document even on first run and atomically correct an old
    // safe file's mode to 0600 on restart.
    await this.persistence.save(state);
    this.initialized = true;
  }

  async noticeStatus(audienceId: string): Promise<BotNoticeStatus> {
    this.requireInitialized();
    return this.serialized(async () =>
      projectBotNoticeStatus(await this.persistence.load(), audienceId),
    );
  }

  async acknowledgeNotice(
    audienceId: string,
    acknowledgement: unknown,
    assertCurrent?: () => void,
  ): Promise<BotNoticeStatus> {
    this.requireInitialized();
    return this.serialized(async () => {
      const before = await this.persistence.load();
      const prior = projectBotNoticeStatus(before, audienceId);
      const next = await this.persistence.update((state) => {
        assertCurrent?.();
        return this.editor(state).acknowledgeNotice(audienceId, acknowledgement);
      });
      if (
        !prior.requiresAcknowledgement &&
        !next.requiresAcknowledgement &&
        prior.acceptedDecision !== next.acceptedDecision
      ) {
        this.leases.invalidateAudience(audienceId);
      }
      return next;
    });
  }

  async revokeNoticeAudience(audienceId: string): Promise<boolean> {
    this.requireInitialized();
    return this.serialized(async () => {
      this.leases.invalidateAudience(audienceId);
      const removed = await this.persistence.update((state) =>
        this.editor(state).revokeNoticeAudience(audienceId),
      );
      this.leases.invalidateAudience(audienceId);
      return removed;
    });
  }

  async auditBotInventory(botIds: readonly string[]): Promise<BotCapabilityPolicyAudit> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).auditBotInventory(botIds),
    );
  }

  async migrateLegacyBotsToFull(input: {
    botIds: readonly string[];
    archivedBotIds?: readonly string[];
    chats?: readonly { chatId: string; botId: string }[];
    catalogRevision: string;
    confirmedExplicitFull: true;
  }): Promise<BotAccessView[]> {
    this.requireInitialized();
    return this.serialized(() =>
      this.persistence.update((state) => this.editor(state).migrateLegacyBotsToFull(input)),
    );
  }

  async getBotPolicy(botId: string): Promise<BotAccessView> {
    this.requireInitialized();
    return this.serialized(async () => projectBotAccessView(await this.persistence.load(), botId));
  }

  async getBotAuthorityStatus(botId: string): Promise<BotCapabilityAuthorityStatus> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).getBotAuthorityStatus(botId),
    );
  }

  async assertBotAuthorityMatchesIdentity(input: {
    botId: string;
    archived: boolean;
  }): Promise<void> {
    this.requireInitialized();
    return this.serialized(async () => {
      this.editor(await this.persistence.load()).assertBotAuthorityMatchesIdentity(input);
    });
  }

  async archiveBotAuthority(botId: string): Promise<boolean> {
    this.requireInitialized();
    return this.serialized(async () => {
      this.leases.invalidateBot(botId);
      const result = await this.persistence.update((state) => {
        const changed = this.editor(state).archiveBotAuthority(botId);
        const policy = state.policies.find((entry) => entry.botId === botId);
        if (!policy) throw new BotCapabilityUnavailableError();
        return { changed, policyEpoch: policy.policyEpoch };
      });
      this.leases.publishBotEpoch(botId, result.policyEpoch);
      this.leases.invalidateBot(botId);
      return result.changed;
    });
  }

  async restoreBotAuthority(botId: string): Promise<boolean> {
    this.requireInitialized();
    return this.serialized(async () => {
      const result = await this.persistence.update((state) => {
        const changed = this.editor(state).restoreBotAuthority(botId);
        const policy = state.policies.find((entry) => entry.botId === botId);
        if (!policy) throw new BotCapabilityUnavailableError();
        return { changed, policyEpoch: policy.policyEpoch };
      });
      this.leases.publishBotEpoch(botId, result.policyEpoch);
      return result.changed;
    });
  }

  async reconcileNamespace(
    namespace: BotCapabilityIncarnationNamespace,
    resources: readonly BotCapabilityIncarnationInput[],
    options: BotCapabilityIncarnationReconcileOptions = {},
  ): Promise<readonly BotCapabilityIncarnation[]> {
    this.requireInitialized();
    return this.serialized(() =>
      this.persistence.update((state) =>
        this.editor(state).reconcileIncarnationNamespace(namespace, resources, options),
      ),
    );
  }

  /** Main-only private binding clone for catalog reconciliation and tombstones. */
  async getBotBinding(botId: string): Promise<BoundBotCustomSelection | undefined> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).getBotBinding(botId),
    );
  }

  async getBotModelAuthority(botId: string): Promise<StoredBotModelAuthority | undefined> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).getBotModelAuthority(botId),
    );
  }

  async getBotVisionModelAuthority(botId: string): Promise<StoredBotModelAuthority | undefined> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).getBotVisionModelAuthority(botId),
    );
  }

  async createBotPolicy(input: {
    botId: string;
    catalog: BotCapabilityCatalog;
    access: unknown;
    binding?: unknown;
    modelBinding?: unknown;
    visionModelBinding?: unknown;
    assertCurrent?: () => void;
  }): Promise<BotAccessView> {
    this.requireInitialized();
    const isCurrent = () => {
      input.assertCurrent?.();
      return true;
    };
    return this.serialized(() =>
      this.persistence.update((state) => {
        input.assertCurrent?.();
        return this.editor(state).createBotPolicy(input);
      }, isCurrent),
    );
  }

  async updateBotPolicy(input: {
    botId: string;
    expectedRevision: string;
    catalog: BotCapabilityCatalog;
    access: unknown;
    binding?: unknown;
    modelBinding?: unknown;
    visionModelBinding?: unknown;
    canonicalChatId?: string;
    assertCurrent?: () => void;
  }): Promise<BotAccessView> {
    this.requireInitialized();
    const isCurrent = () => {
      input.assertCurrent?.();
      return true;
    };
    return this.serialized(async () => {
      const state = await this.persistence.load();
      const policy = state.policies.find(({ botId }) => botId === input.botId);
      if (!policy) throw new BotCapabilityUnavailableError();
      if (policy.revision !== input.expectedRevision) {
        throw new BotCapabilityRevisionConflictError(policy.revision);
      }
      const access = parseBotAccessUpdate(input.access);
      if (access.catalogRevision !== input.catalog.revision) {
        throw new BotCapabilityCatalogConflictError(input.catalog.revision);
      }
      if (access.accessMode === "custom") {
        validateSelectionAgainstCatalog(access.custom, input.catalog);
        const binding = parseBoundBotCustomSelection(input.binding);
        if (
          binding.catalogRevision !== access.catalogRevision ||
          !botCustomSelectionsEqual(binding.selection, access.custom)
        ) {
          throw new BotCapabilityUnavailableError(
            "Custom Bot access binding does not match the requested policy.",
          );
        }
      } else if (input.binding !== undefined) {
        throw new BotCapabilityUnavailableError(
          "Full Access cannot persist a Custom private binding.",
        );
      }
      const narrowing = botPolicyTransitionNarrows(policy, access);
      const mayChangeFullModel = access.accessMode === "full" && access.providerId !== undefined;
      const companionChanges = (() => {
        if (access.visionModel === undefined) return false;
        if (access.visionModel === null) return policy.visionModel !== undefined;
        if (!policy.visionModel || input.visionModelBinding === undefined) return true;
        const nextBinding = parseBoundBotProviderModel(input.visionModelBinding);
        return (
          policy.visionModel.selection.providerId !== access.visionModel.providerId ||
          policy.visionModel.selection.modelId !== access.visionModel.modelId ||
          boundBotProviderModelFingerprint(policy.visionModel.binding) !==
            boundBotProviderModelFingerprint(nextBinding)
        );
      })();
      const previousFullWebSearchEnabled =
        policy.accessMode === "full" && policy.webSearchEnabled === true;
      const nextFullWebSearchEnabled =
        access.accessMode === "full" && (access.webSearchEnabled ?? previousFullWebSearchEnabled);
      const webSearchChanged = previousFullWebSearchEnabled !== nextFullWebSearchEnabled;
      if (narrowing || mayChangeFullModel || companionChanges || webSearchChanged) {
        this.leases.invalidateBot(policy.botId);
      }
      const result = await this.persistence.update((draft) => {
        input.assertCurrent?.();
        return this.editor(draft).updateBotPolicy(input);
      }, isCurrent);
      if (result.authorityChanged) {
        this.leases.publishBotEpoch(policy.botId, result.policyEpoch);
        for (const chat of result.narrowedChats) {
          this.leases.publishChatEpoch(policy.botId, chat.chatId, chat.policyEpoch);
        }
      }
      return result.view;
    });
  }

  async getChatPolicy(chatId: string): Promise<BotChatAccessView> {
    this.requireInitialized();
    return this.serialized(async () =>
      projectBotChatAccessView(await this.persistence.load(), chatId),
    );
  }

  async inspectArchivedReadAuthority(
    botId: string,
    chatId: string,
  ): Promise<BotArchivedReadAuthoritySnapshot> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).inspectArchivedReadAuthority(botId, chatId),
    );
  }

  async createChatPolicy(input: {
    chatId: string;
    botId: string;
    expectedBotPolicyRevision: string;
    catalog: BotCapabilityCatalog;
    custom?: unknown;
    assertCurrent?: () => void;
  }): Promise<BotChatAccessView> {
    this.requireInitialized();
    const isCurrent = () => {
      input.assertCurrent?.();
      return true;
    };
    return this.serialized(() =>
      this.persistence.update((state) => {
        input.assertCurrent?.();
        return this.editor(state).createChatPolicy(input);
      }, isCurrent),
    );
  }

  async updateChatPolicy(input: {
    chatId: string;
    expectedRevision: string;
    catalog: BotCapabilityCatalog;
    access: unknown;
    assertCurrent?: () => void;
  }): Promise<BotChatAccessView> {
    this.requireInitialized();
    const isCurrent = () => {
      input.assertCurrent?.();
      return true;
    };
    return this.serialized(async () => {
      const state = await this.persistence.load();
      const chat = state.chats.find(({ chatId }) => chatId === input.chatId);
      if (!chat) throw new BotCapabilityUnavailableError();
      if (chat.revision !== input.expectedRevision) {
        throw new BotCapabilityRevisionConflictError(chat.revision);
      }
      const policy = state.policies.find(({ botId }) => botId === chat.botId);
      if (!policy) throw new BotCapabilityUnavailableError();
      const access = parseBotChatAccessUpdate(input.access);
      if (access.catalogRevision !== input.catalog.revision) {
        throw new BotCapabilityCatalogConflictError(input.catalog.revision);
      }
      if (access.expectedBotPolicyRevision !== policy.revision) {
        throw new BotCapabilityRevisionConflictError(policy.revision);
      }
      if (access.mode === "custom") {
        validateSelectionAgainstCatalog(access.custom, input.catalog);
        if (
          policy.accessMode === "custom" &&
          !botCustomSelectionIsSubset(access.custom, policy.custom)
        ) {
          throw new BotCapabilitySubsetError();
        }
      }
      const narrowing = botChatTransitionNarrows(chat, access);
      if (narrowing) this.leases.invalidateChat(chat.botId, chat.chatId);
      const result = await this.persistence.update((draft) => {
        input.assertCurrent?.();
        return this.editor(draft).updateChatPolicy(input);
      }, isCurrent);
      if (result.narrowed) {
        this.leases.publishChatEpoch(chat.botId, chat.chatId, result.policyEpoch);
      }
      return result.view;
    });
  }

  async copyChatPolicy(input: {
    sourceChatId: string;
    targetChatId: string;
    botId: string;
  }): Promise<BotChatAccessView> {
    this.requireInitialized();
    return this.serialized(() =>
      this.persistence.update((state) => this.editor(state).copyChatPolicy(input)),
    );
  }

  async deleteChatPolicy(input: { chatId: string; botId: string }): Promise<boolean> {
    this.requireInitialized();
    return this.serialized(async () => {
      const state = await this.persistence.load();
      const chat = state.chats.find(({ chatId }) => chatId === input.chatId);
      if (chat && chat.botId !== input.botId) throw new BotCapabilityUnavailableError();
      if (!chat) return false;
      this.leases.invalidateChat(input.botId, input.chatId);
      const deleted = await this.persistence.update((state) =>
        this.editor(state).deleteChatPolicy(input),
      );
      this.leases.invalidateChat(input.botId, input.chatId);
      return deleted;
    });
  }

  async rollbackUncommittedBotPolicy(input: {
    botId: string;
    identityCommitted: false;
  }): Promise<boolean> {
    this.requireInitialized();
    return this.serialized(async () => {
      if (input.identityCommitted !== false) {
        throw new BotCapabilityUnavailableError(
          "A committed Bot identity cannot hard-delete its access policy.",
        );
      }
      const state = await this.persistence.load();
      if (!state.policies.some(({ botId }) => botId === input.botId)) return false;
      this.leases.invalidateBot(input.botId);
      const removed = await this.persistence.update((draft) =>
        this.editor(draft).rollbackUncommittedBotPolicy(input),
      );
      this.leases.invalidateBot(input.botId);
      return removed;
    });
  }

  /**
   * The single admission path for turns/effects. It is serialized with policy
   * writes, so no lease can escape between a narrowing commit and its fence.
   */
  async admit(input: {
    audienceId: string;
    botId: string;
    chatId?: string;
    /** Required whenever the effective authority is Custom. */
    snapshot?: BotCapabilityCatalogSnapshot;
    /** A closed global gate preserves durable grants while excluding them from runtime authority. */
    skillsEnabled?: boolean;
  }): Promise<BotCapabilityAdmission> {
    this.requireInitialized();
    return this.serialized(async () => {
      const state = await this.persistence.load();
      const editor = this.editor(state);
      const authority = editor.assertBotMayAct(input);
      const modelAuthority = editor.getBotModelAuthority(input.botId);
      const visionModelAuthority = editor.getBotVisionModelAuthority(input.botId);
      if (authority.effectiveCustom || modelAuthority || visionModelAuthority) {
        if (!input.snapshot) {
          throw new BotCapabilityUnavailableError(
            "Current Bot capability bindings are required for Bot access.",
          );
        }
        editor.assertAuthorityBindingsCurrent({
          botId: input.botId,
          ...(input.chatId ? { chatId: input.chatId } : {}),
          snapshot: input.snapshot,
          skillsEnabled: input.skillsEnabled,
        });
      }
      const lease = this.leases.acquire({
        audienceId: input.audienceId,
        botId: authority.policy.botId,
        botPolicyEpoch: authority.policy.policyEpoch,
        ...(authority.chat
          ? {
              chatId: authority.chat.chatId,
              chatPolicyEpoch: authority.chat.policyEpoch,
            }
          : {}),
      });
      return {
        ...authority,
        ...(modelAuthority ? { modelAuthority } : {}),
        ...(visionModelAuthority ? { visionModelAuthority } : {}),
        lease,
      };
    });
  }

  /** Archive/global/inventory owners use this immediate process fence. */
  invalidateBotAuthority(botId: string): void {
    this.leases.invalidateBot(botId);
  }

  /** Chat lifecycle owners fence authority before removing the chat identity. */
  invalidateChatAuthority(botId: string, chatId: string): void {
    this.leases.invalidateChat(botId, chatId);
  }

  async assertAuthorityBindingsCurrent(input: {
    botId: string;
    chatId?: string;
    snapshot: BotCapabilityCatalogSnapshot;
    skillsEnabled?: boolean;
  }): Promise<BoundBotCustomSelection | undefined> {
    this.requireInitialized();
    return this.serialized(async () =>
      this.editor(await this.persistence.load()).assertAuthorityBindingsCurrent(input),
    );
  }
}

export function createBotCapabilityStore(
  options: BotCapabilityStoreOptions = {},
): BotCapabilityStore {
  return new BotCapabilityStore(options);
}
