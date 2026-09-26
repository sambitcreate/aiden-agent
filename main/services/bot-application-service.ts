import { randomUUID } from "node:crypto";
import { BotRuntimeInventoryLeaseInvalidError } from "./bot-runtime-inventory-lease.js";
import type {
  BotAccessUpdate,
  BotChatAccessUpdate,
  BotNoticeAcknowledgement,
} from "../../renderer/shared/bot-capabilities.js";
import type {
  BotCreateInput,
  BotDefinition,
  BotUpdateInput,
} from "../../renderer/shared/bots.js";
import { finalizeBotCapabilityCatalog } from "./bot-capability-catalog-core.js";
import type { BotCapabilityCatalogMainService } from "./bot-capability-catalog-main.js";
import {
  retainedBotProviderForChat,
  type BotRetainedProvider,
} from "./bot-capability-retained-provider.js";
import type { BotCapabilityStore } from "./bot-capability-store.js";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";
import type {
  BotLifecycleJournalCore,
  BotLifecycleOperation,
  BotLifecycleStage,
} from "./bot-lifecycle-journal-core.js";
import { mintBotLifecycleOperationId } from "./bot-lifecycle-journal.js";
import type {
  BotManagedWorkspaceCore,
  BotManagedWorkspaceReservation,
  BotManagedWorkspaceResolution,
} from "./bot-managed-workspace-core.js";
import type { BotMutationGate } from "./bot-mutation-gate.js";
import { BotIdentityRevisionConflictError, type BotStore } from "./bot-store-core.js";
import type { ChatStore } from "./chat-store-core.js";
import type { Chat } from "./types.js";
import { selectCanonicalBotChat } from "./bot-canonical-chat.js";

const STAGES = {
  create_bot: ["prepared", "workspace_provisioned", "policy_committed", "identity_committed"],
  create_chat: ["prepared", "policy_committed", "chat_committed"],
  copy_chat: ["prepared", "policy_committed", "chat_committed"],
  delete_chat: ["prepared", "authority_fenced", "chat_deleted", "policy_removed"],
  archive_bot: ["prepared", "authority_archived", "identity_archived"],
  restore_bot: ["prepared", "identity_restored", "authority_restored"],
  update_model: ["prepared", "policy_committed", "chat_committed"],
} as const satisfies Partial<Record<BotLifecycleOperation["kind"], readonly BotLifecycleStage[]>>;

const INVENTORY_SAVE_ATTEMPTS = 3;

type BotStorePort = Pick<
  BotStore,
  "list" | "get" | "createWithId" | "update" | "archive" | "restore"
>;

type ChatStorePort = Pick<
  ChatStore,
  | "list"
  | "get"
  | "create"
  | "copyVisibleHistory"
  | "remove"
  | "listByBot"
  | "setBotModelSelection"
>;

type CapabilityStorePort = Pick<
  BotCapabilityStore,
  | "initialize"
  | "noticeStatus"
  | "acknowledgeNotice"
  | "revokeNoticeAudience"
  | "auditBotInventory"
  | "migrateLegacyBotsToFull"
  | "getBotPolicy"
  | "getBotAuthorityStatus"
  | "assertBotAuthorityMatchesIdentity"
  | "archiveBotAuthority"
  | "restoreBotAuthority"
  | "getBotBinding"
  | "getBotModelAuthority"
  | "assertAuthorityBindingsCurrent"
  | "admit"
  | "createBotPolicy"
  | "updateBotPolicy"
  | "getChatPolicy"
  | "createChatPolicy"
  | "updateChatPolicy"
  | "copyChatPolicy"
  | "deleteChatPolicy"
  | "rollbackUncommittedBotPolicy"
  | "invalidateBotAuthority"
  | "invalidateChatAuthority"
> & Partial<Pick<BotCapabilityStore, "getBotVisionModelAuthority">>;

type ManagedWorkspacePort = Pick<
  BotManagedWorkspaceCore,
  | "reserve"
  | "provision"
  | "reconcileProvision"
  | "resolve"
  | "listBindings"
  | "audit"
  | "rollbackProvision"
>;

type LifecycleJournalPort = Pick<
  BotLifecycleJournalCore,
  "begin" | "checkpoint" | "complete" | "rollback" | "listPending"
>;

type CatalogPort = Pick<
  BotCapabilityCatalogMainService,
  "snapshot" | "snapshotForRuntime" | "bindCustom"
> & Partial<Pick<BotCapabilityCatalogMainService, "bindProviderModel">>;

export interface BotApplicationDependencies {
  botStore: BotStorePort;
  chatStore: ChatStorePort;
  capabilityStore: CapabilityStorePort;
  catalog: CatalogPort;
  managedWorkspace: ManagedWorkspacePort;
  lifecycleJournal: LifecycleJournalPort;
  migrationSeal: {
    isSealed(): Promise<boolean>;
    seal(): Promise<void>;
  };
  mutationGate: Pick<BotMutationGate, "run">;
  inventoryLeases?: {
    acquire(): { assertCurrent(): void; release(): void };
  };
  /**
   * Production deletion owns active-run cancellation and private runtime-effect
   * cleanup. Tests may omit it and exercise the underlying ChatStore directly.
   */
  deleteChatWithEffects?: (
    chatId: string,
    assertCurrent: (chat: Chat | null) => void | Promise<void>,
    onDeletionRollForward?: () => void,
  ) => Promise<void>;
  onArchiveBot?: (botId: string) => Promise<void>;
  assertChatDeletionAllowed?: (botId: string, chatId: string) => Promise<void>;
  mintBotId?(): string;
  mintChatId?(): string;
  mintOperationId?(): string;
}

export interface CreateBotApplicationInput {
  audienceId: string;
  bot: BotCreateInput;
  /** Omitted means the foreground Full Access default. */
  access?: BotAccessUpdate;
}

export interface CreateBotChatApplicationInput {
  audienceId: string;
  botId: string;
  providerId?: string;
  model?: string;
  /** Main-only fixed identity used by durable external-surface bindings. */
  chatId?: string;
  /** Main-owned owner/transport lease check, repeated at ChatStore's atomic commit. */
  assertCurrent?: () => void;
}

export interface CopyBotChatApplicationInput {
  botId: string;
  sourceChatId: string;
  throughAssistantMessageId?: string;
  /** Main-owned owner/transport lease check, repeated at ChatStore's atomic commit. */
  assertCurrent?: () => void;
}

export class BotApplicationUnavailableError extends Error {
  readonly name = "BotApplicationUnavailableError";

  constructor(readonly reason: "missing" | "archived") {
    super("This Bot is no longer available.");
  }
}

export class BotHistoricalChatReadOnlyError extends Error {
  readonly name = "BotHistoricalChatReadOnlyError";

  constructor() {
    super("Historical Bot chats are read-only.");
  }
}

export class BotPersistentChatDeletionError extends Error {
  readonly name = "BotPersistentChatDeletionError";

  constructor() {
    super("A Bot's persistent chat cannot be deleted independently. Archive the Bot instead.");
  }
}

function withCurrentCatalogRevision<T extends { catalogRevision: string }>(
  access: T,
  catalogRevision: string,
): T {
  return access.catalogRevision === catalogRevision
    ? access
    : { ...access, catalogRevision };
}

function createReservation(operation: BotLifecycleOperation): BotManagedWorkspaceReservation {
  if (
    operation.kind !== "create_bot" ||
    !("workspaceId" in operation.subject) ||
    !("workspaceCreatedAt" in operation.subject)
  ) {
    throw new Error("Bot create recovery is missing its managed-home reservation.");
  }
  return {
    botId: operation.botId,
    workspaceId: operation.subject.workspaceId,
    createdAt: operation.subject.workspaceCreatedAt,
  };
}

function lifecycleChatId(operation: BotLifecycleOperation): string {
  if (!("chatId" in operation.subject)) {
    throw new Error("Bot chat recovery is missing its chat identity.");
  }
  return operation.subject.chatId;
}

function lifecycleCreateChatWorkspaceId(operation: BotLifecycleOperation): string {
  if (
    operation.kind !== "create_chat" ||
    !("workspaceId" in operation.subject) ||
    typeof operation.subject.workspaceId !== "string"
  ) {
    throw new Error("Bot chat recovery is missing its workspace identity.");
  }
  return operation.subject.workspaceId;
}

function copiedChatIds(operation: BotLifecycleOperation): {
  sourceChatId: string;
  targetChatId: string;
} {
  if (!("sourceChatId" in operation.subject) || !("targetChatId" in operation.subject)) {
    throw new Error("Bot copy recovery is missing its chat identities.");
  }
  return {
    sourceChatId: operation.subject.sourceChatId,
    targetChatId: operation.subject.targetChatId,
  };
}

export function createBotApplicationService(deps: BotApplicationDependencies) {
  const mintBotId = deps.mintBotId ?? (() => `bot:${randomUUID()}`);
  const mintChatId = deps.mintChatId ?? (() => randomUUID());
  const mintOperationId = deps.mintOperationId ?? mintBotLifecycleOperationId;
  let initializePromise: Promise<void> | undefined;
  let recoveryFailure: unknown;

  const removeChat = (
    chatId: string,
    assertCurrent: (chat: Chat | null) => void | Promise<void>,
    onDeletionRollForward?: () => void,
  ): Promise<void> => deps.deleteChatWithEffects
    ? deps.deleteChatWithEffects(chatId, assertCurrent, onDeletionRollForward)
    : deps.chatStore.remove(chatId, assertCurrent);

  const advance = async (
    operation: BotLifecycleOperation,
    target: BotLifecycleStage,
  ): Promise<BotLifecycleOperation> => {
    const stages = STAGES[operation.kind];
    let current: BotLifecycleOperation = operation;
    let index = stages.indexOf(current.stage as never);
    const targetIndex = stages.indexOf(target as never);
    if (index < 0 || targetIndex < 0) {
      throw new Error("Bot lifecycle journal contains an invalid checkpoint.");
    }
    if (index > targetIndex) return current;
    while (index < targetIndex) {
      const next = stages[index + 1]!;
      current = await deps.lifecycleJournal.checkpoint(current.operationId, current.stage, next);
      index += 1;
    }
    return current;
  };

  const snapshotForAudience = (
    audienceId: string,
    botId?: string,
    retainedProviders?: readonly BotRetainedProvider[],
  ) => deps.catalog.snapshot({ audienceId, botId, retainedProviders });

  const retainedVisionProvider = async (botId: string): Promise<BotRetainedProvider[]> => {
    const vision = await deps.capabilityStore.getBotVisionModelAuthority?.(botId);
    return vision
      ? [{
          sourceProviderId: vision.binding.sourceProviderId,
          sourceModelId: vision.binding.sourceModelId,
        }]
      : [];
  };

  const bindVisionModel = async (input: Parameters<BotCapabilityCatalogMainService["bindProviderModel"]>[0]) => {
    if (!deps.catalog.bindProviderModel) {
      throw new Error("The companion vision model binder is unavailable.");
    }
    return deps.catalog.bindProviderModel(input);
  };

  const withInventoryLease = async <Result>(
    action: (assertCurrent: () => void) => Promise<Result>,
  ): Promise<Result> => {
    const lease = deps.inventoryLeases?.acquire();
    try {
      return await action(() => lease?.assertCurrent());
    } finally {
      lease?.release();
    }
  };

  /**
   * Configuration saves may race a legitimate provider, credential, MCP, or
   * skill inventory mutation. Never publish against the stale snapshot: retry
   * the complete read/bind/write transaction under a fresh lease instead.
   */
  const withFreshInventoryLease = async <Result>(
    action: (assertCurrent: () => void) => Promise<Result>,
  ): Promise<Result> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await withInventoryLease(action);
      } catch (error) {
        if (
          !(error instanceof BotRuntimeInventoryLeaseInvalidError) ||
          attempt >= INVENTORY_SAVE_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  };

  const beginPending = async (
    input: Parameters<LifecycleJournalPort["begin"]>[0],
  ): Promise<BotLifecycleOperation> => {
    const lookup = await deps.lifecycleJournal.begin(input);
    if (lookup.status !== "pending") {
      throw new Error("A newly minted Bot lifecycle operation was already completed.");
    }
    return lookup.operation;
  };

  const accessForCreate = async (
    audienceId: string,
    requested: BotAccessUpdate | undefined,
  ) => {
    const snapshot = await snapshotForAudience(audienceId);
    // Audience-safe IDs are revalidated against this exact fresh snapshot.
    // A stale wizard revision can therefore be rebased without accepting a
    // removed or changed provider, model, connection, skill, or file scope.
    let access: BotAccessUpdate = requested
      ? withCurrentCatalogRevision(requested, snapshot.catalog.revision)
      : {
          accessMode: "full",
          catalogRevision: snapshot.catalog.revision,
          confirmedForeground: true,
        };
    if (
      access.accessMode === "full" &&
      access.providerId === undefined &&
      access.modelId === undefined
    ) {
      const provider = snapshot.catalog.providers.find((candidate) =>
        candidate.available && candidate.models.some((model) => model.available),
      );
      const model = provider?.models.find((candidate) => candidate.available);
      if (!provider || !model) {
        throw new BotCapabilityUnavailableError(
          "A new Bot requires an available provider and model.",
        );
      }
      access = {
        ...access,
        providerId: provider.id,
        modelId: model.id,
      };
    }
    const binding = access.accessMode === "custom"
      ? await deps.catalog.bindCustom({
          audienceId,
          selection: access.custom,
          catalogRevision: access.catalogRevision,
          snapshot,
        })
      : undefined;
    const modelBinding = access.accessMode === "full" && access.providerId && access.modelId
      ? (await deps.catalog.bindCustom({
          audienceId,
          selection: {
            providerId: access.providerId,
            modelId: access.modelId,
            fileScopeIds: [],
            shellEnabled: false,
            connectionIds: [],
            skillIds: [],
            otherCapabilityIds: [],
          },
          catalogRevision: access.catalogRevision,
          snapshot,
        })).provider
      : undefined;
    const visionModelBinding = access.visionModel
      ? await bindVisionModel({
          audienceId,
          providerId: access.visionModel.providerId,
          modelId: access.visionModel.modelId,
          catalogRevision: access.catalogRevision,
          requireImages: true,
          snapshot,
        })
      : undefined;
    return { snapshot, access, binding, modelBinding, visionModelBinding };
  };

  const createPolicy = async (
    botId: string,
    audienceId: string,
    requested?: BotAccessUpdate,
  ) => {
    return withInventoryLease(async (assertCurrent) => {
      const { snapshot, access, binding, modelBinding, visionModelBinding } = await accessForCreate(
        audienceId,
        requested,
      );
      assertCurrent();
      return deps.capabilityStore.createBotPolicy({
        botId,
        catalog: snapshot.catalog,
        access,
        ...(binding ? { binding } : {}),
        ...(modelBinding ? { modelBinding } : {}),
        ...(visionModelBinding ? { visionModelBinding } : {}),
        assertCurrent,
      });
    });
  };

  // Once an identity is visible, missing access state is corruption and must
  // fail closed. Only the sealed startup legacy migration below may mint an
  // explicit Full policy for a pre-policy Bot.
  const requirePolicyForVisibleBot = (botId: string) =>
    deps.capabilityStore.getBotPolicy(botId);

  const finishCreateBot = async (operation: BotLifecycleOperation): Promise<void> => {
    const bot = await deps.botStore.get(operation.botId);
    if (!bot) {
      if (operation.stage === "identity_committed") {
        throw new Error("A committed Bot identity is missing; recovery stopped safely.");
      }
      const reservation = createReservation(operation);
      await deps.capabilityStore.rollbackUncommittedBotPolicy({
        botId: operation.botId,
        identityCommitted: false,
      });
      await deps.managedWorkspace.rollbackProvision({
        ...reservation,
        identityCommitted: false,
      });
      await deps.lifecycleJournal.rollback(operation.operationId, operation.stage);
      return;
    }

    const reservation = createReservation(operation);
    let current = operation;
    await deps.managedWorkspace.reconcileProvision(reservation);
    current = await advance(current, "workspace_provisioned");
    await requirePolicyForVisibleBot(operation.botId);
    current = await advance(current, "policy_committed");
    current = await advance(current, "identity_committed");
    await deps.lifecycleJournal.complete(current.operationId, "identity_committed");
  };

  const rollbackChatPolicy = async (
    operation: BotLifecycleOperation,
    chatId: string,
  ): Promise<void> => {
    await deps.capabilityStore.deleteChatPolicy({ chatId, botId: operation.botId });
    await deps.lifecycleJournal.rollback(operation.operationId, operation.stage);
  };

  const currentChatPolicy = async (chatId: string) => {
    try {
      return await deps.capabilityStore.getChatPolicy(chatId);
    } catch (error) {
      if (error instanceof BotCapabilityUnavailableError) return null;
      throw error;
    }
  };

  const finishCreateChat = async (operation: BotLifecycleOperation): Promise<void> => {
    const chatId = lifecycleChatId(operation);
    const chat = await deps.chatStore.get(chatId);
    if (!chat) {
      if (operation.stage === "chat_committed") {
        throw new Error("A committed Bot chat is missing; recovery stopped safely.");
      }
      await rollbackChatPolicy(operation, chatId);
      return;
    }
    const workspaceId = lifecycleCreateChatWorkspaceId(operation);
    if (chat.botId !== operation.botId || chat.workspaceId !== workspaceId) {
      throw new Error("Recovered Bot chat does not match its journaled workspace.");
    }
    const policy = await requirePolicyForVisibleBot(operation.botId);
    let current = operation;
    const chatPolicy = await currentChatPolicy(chatId);
    if (chatPolicy && (chatPolicy.botId !== operation.botId || chatPolicy.chatId !== chatId)) {
      throw new Error("Recovered Bot chat policy has the wrong identity.");
    }
    if (!chatPolicy) {
      await deps.capabilityStore.createChatPolicy({
        chatId,
        botId: operation.botId,
        expectedBotPolicyRevision: policy.revision,
        catalog: (await deps.catalog.snapshotForRuntime({ botId: operation.botId })).catalog,
      });
    }
    current = await advance(current, "policy_committed");
    current = await advance(current, "chat_committed");
    await deps.lifecycleJournal.complete(current.operationId, "chat_committed");
  };

  const finishCopyChat = async (operation: BotLifecycleOperation): Promise<void> => {
    const { sourceChatId, targetChatId } = copiedChatIds(operation);
    const target = await deps.chatStore.get(targetChatId);
    if (!target) {
      if (operation.stage === "chat_committed") {
        throw new Error("A committed Bot chat copy is missing; recovery stopped safely.");
      }
      await rollbackChatPolicy(operation, targetChatId);
      return;
    }
    const home = await deps.managedWorkspace.resolve(operation.botId);
    if (target.botId !== operation.botId || target.workspaceId !== home.workspaceId) {
      throw new Error("Recovered Bot chat copy does not match its private Bot home.");
    }
    let current = operation;
    const targetPolicy = await currentChatPolicy(targetChatId);
    if (targetPolicy && (
      targetPolicy.botId !== operation.botId || targetPolicy.chatId !== targetChatId
    )) {
      throw new Error("Recovered Bot chat-copy policy has the wrong identity.");
    }
    if (!targetPolicy) {
      await deps.capabilityStore.copyChatPolicy({
        sourceChatId,
        targetChatId,
        botId: operation.botId,
      });
    }
    current = await advance(current, "policy_committed");
    current = await advance(current, "chat_committed");
    await deps.lifecycleJournal.complete(current.operationId, "chat_committed");
  };

  const finishDeleteChat = async (operation: BotLifecycleOperation): Promise<void> => {
    const bot = await deps.botStore.get(operation.botId);
    if (!bot) throw new Error("The Bot owning this deleted chat is missing.");
    const chatId = lifecycleChatId(operation);
    let current = operation;
    const chat = await deps.chatStore.get(chatId);
    if (chat && chat.botId !== operation.botId) {
      throw new Error("Recovered Bot chat deletion has the wrong owner.");
    }
    const policy = await currentChatPolicy(chatId);
    if (policy && policy.botId !== operation.botId) {
      throw new Error("Recovered Bot chat deletion policy has the wrong owner.");
    }
    if (current.stage === "policy_removed" && policy) {
      throw new Error("A removed Bot chat policy reappeared during recovery.");
    }
    if (
      (current.stage === "chat_deleted" || current.stage === "policy_removed") &&
      chat
    ) {
      throw new Error("A deleted Bot chat reappeared during recovery.");
    }

    deps.capabilityStore.invalidateChatAuthority(operation.botId, chatId);
    current = await advance(current, "authority_fenced");
    if (chat) {
      await removeChat(chatId, (currentChat) => {
        if (!currentChat || currentChat.botId !== operation.botId) {
          throw new Error("The Bot chat changed owner before deletion.");
        }
      });
    }
    current = await advance(current, "chat_deleted");
    if (current.stage !== "policy_removed") {
      await deps.capabilityStore.deleteChatPolicy({ chatId, botId: operation.botId });
    }
    current = await advance(current, "policy_removed");
    await deps.lifecycleJournal.complete(current.operationId, "policy_removed");
  };

  const finishArchive = async (operation: BotLifecycleOperation): Promise<void> => {
    let current = operation;
    deps.capabilityStore.invalidateBotAuthority(operation.botId);
    const bot = await deps.botStore.get(operation.botId);
    if (!bot) throw new Error("The Bot being archived is missing.");
    const authorityStatus = await deps.capabilityStore.getBotAuthorityStatus(operation.botId);
    if (authorityStatus === "active" && bot.archivedAt !== undefined) {
      throw new Error("Bot identity was archived before its protected authority was narrowed.");
    }
    await deps.capabilityStore.archiveBotAuthority(operation.botId);
    current = await advance(current, "authority_archived");
    if (bot.archivedAt === undefined) {
      const expectedRevision = "expectedRevision" in operation.subject
        ? operation.subject.expectedRevision
        : "";
      if (bot.revision !== expectedRevision) {
        throw new BotIdentityRevisionConflictError(bot.revision);
      }
      await deps.botStore.archive(operation.botId, expectedRevision);
    }
    deps.capabilityStore.invalidateBotAuthority(operation.botId);
    await deps.onArchiveBot?.(operation.botId);
    current = await advance(current, "identity_archived");
    await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
      botId: operation.botId,
      archived: true,
    });
    await deps.lifecycleJournal.complete(current.operationId, "identity_archived");
  };

  const finishRestore = async (operation: BotLifecycleOperation): Promise<void> => {
    let current = operation;
    let bot = await deps.botStore.get(operation.botId);
    if (!bot) throw new Error("The Bot being restored is missing.");
    await deps.managedWorkspace.resolve(operation.botId);
    await requirePolicyForVisibleBot(operation.botId);
    const authorityStatus = await deps.capabilityStore.getBotAuthorityStatus(operation.botId);
    if (authorityStatus === "active" && bot.archivedAt !== undefined) {
      throw new Error("Bot protected authority was restored before its identity.");
    }
    if (bot.archivedAt !== undefined) {
      const expectedRevision = "expectedRevision" in operation.subject
        ? operation.subject.expectedRevision
        : "";
      if (bot.revision !== expectedRevision) {
        throw new BotIdentityRevisionConflictError(bot.revision);
      }
      bot = await deps.botStore.restore(operation.botId, expectedRevision);
    }
    current = await advance(current, "identity_restored");
    await deps.capabilityStore.restoreBotAuthority(operation.botId);
    current = await advance(current, "authority_restored");
    await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
      botId: operation.botId,
      archived: false,
    });
    void bot;
    await deps.lifecycleJournal.complete(current.operationId, "authority_restored");
  };

  const finishUpdateModel = async (operation: BotLifecycleOperation): Promise<void> => {
    const chatId = lifecycleChatId(operation);
    const authority = await deps.capabilityStore.getBotModelAuthority(operation.botId);
    if (!authority) {
      throw new Error("A committed Bot model update has no durable model authority.");
    }
    const chat = await deps.chatStore.get(chatId);
    if (!chat || chat.botId !== operation.botId) {
      throw new Error("The Bot model-update chat identity could not be recovered.");
    }
    const canonical = selectCanonicalBotChat(await deps.chatStore.listByBot(operation.botId));
    if (canonical?.id !== chatId) {
      throw new Error("A Bot model update cannot retarget a historical chat.");
    }
    const chatPolicy = await deps.capabilityStore.getChatPolicy(chatId);
    if (chatPolicy.botId !== operation.botId) {
      throw new Error("The Bot model-update policy has the wrong owner.");
    }
    if (
      chatPolicy.mode === "custom" &&
      (chatPolicy.custom.providerId !== authority.selection.providerId ||
        chatPolicy.custom.modelId !== authority.selection.modelId)
    ) {
      throw new Error("The Bot chat reduction was not rebased to its saved model.");
    }
    let current = operation;
    current = await advance(current, "policy_committed");
    await deps.chatStore.setBotModelSelection(
      chatId,
      authority.binding.sourceProviderId,
      authority.binding.sourceModelId,
      (currentChat) => {
        if (currentChat.botId !== operation.botId) {
          throw new Error("The Bot model-update chat changed owner.");
        }
      },
    );
    current = await advance(current, "chat_committed");
    await deps.lifecycleJournal.complete(current.operationId, "chat_committed");
  };

  const reconcileOperation = (operation: BotLifecycleOperation): Promise<void> => {
    switch (operation.kind) {
      case "create_bot": return finishCreateBot(operation);
      case "create_chat": return finishCreateChat(operation);
      case "copy_chat": return finishCopyChat(operation);
      case "delete_chat": return finishDeleteChat(operation);
      case "archive_bot": return finishArchive(operation);
      case "restore_bot": return finishRestore(operation);
      case "update_model": return finishUpdateModel(operation);
      default:
        throw new Error(`Unsupported pending Bot lifecycle: ${operation.kind}.`);
    }
  };

  const reconcileVisibleCommit = async (
    expected: BotLifecycleOperation,
    verify: () => Promise<void>,
  ): Promise<void> => {
    try {
      const pending = (await deps.lifecycleJournal.listPending())
        .find(({ operationId }) => operationId === expected.operationId);
      if (pending) {
        if (pending.kind !== expected.kind || pending.botId !== expected.botId) {
          throw new Error("Bot lifecycle recovery found a mismatched operation.");
        }
        await reconcileOperation(pending);
      }
      await verify();
    } catch (error) {
      deps.capabilityStore.invalidateBotAuthority(expected.botId);
      recoveryFailure = error;
      throw new Error(
        "A Bot change committed but its recovery record could not be finalized. Restart Aiden to repair it safely.",
      );
    }
  };

  const initialize = async (): Promise<void> => {
    await deps.capabilityStore.initialize();
    for (const operation of await deps.lifecycleJournal.listPending()) {
      await deps.mutationGate.run(operation.botId, () => reconcileOperation(operation));
    }

    const bots = await deps.botStore.list(true);
    const botIds = bots.map(({ id }) => id);
    const botChats = (await deps.chatStore.list()).filter(
      (chat): chat is typeof chat & { botId: string } => chat.botId !== undefined,
    );
    const runtimeCatalog = await deps.catalog.snapshotForRuntime();
    const externallySealed = await deps.migrationSeal.isSealed();
    const audit = await deps.capabilityStore.auditBotInventory(botIds);
    if (audit.orphanedBotIds.length > 0) {
      throw new Error("Bot access storage contains policy without a Bot identity.");
    }
    if (externallySealed && audit.missingBotIds.length > 0) {
      throw new Error("Bot access storage is missing after its migration was sealed.");
    }
    if (externallySealed) {
      for (const chat of botChats) {
        const existing = await currentChatPolicy(chat.id);
        if (!existing || existing.botId !== chat.botId) {
          throw new Error("Bot chat access storage is missing after migration was sealed.");
        }
      }
    }
    await deps.capabilityStore.migrateLegacyBotsToFull({
      botIds,
      archivedBotIds: bots.filter(({ archivedAt }) => archivedAt !== undefined).map(({ id }) => id),
      chats: botChats.map(({ id: chatId, botId }) => ({ chatId, botId })),
      catalogRevision: runtimeCatalog.catalog.revision,
      confirmedExplicitFull: true,
    });

    // Provider/model belongs to the Bot. Older Full policies predate that
    // invariant, so adopt their canonical chat selection (or the first
    // available configured model when no chat exists) before runtime opens.
    // Chat metadata is repaired below as a one-way execution mirror.
    for (const bot of bots) {
      const chats = botChats.filter(({ botId }) => botId === bot.id);
      const canonical = selectCanonicalBotChat(chats);
      let authority = await deps.capabilityStore.getBotModelAuthority(bot.id);
      if (!authority) {
        const retained = canonical ? retainedBotProviderForChat(canonical) : undefined;
        const snapshot = await deps.catalog.snapshotForRuntime({
          botId: bot.id,
          ...(retained && retained.length > 0 ? { retainedProviders: retained } : {}),
        });
        const sourceProvider = canonical?.providerId;
        const sourceModel = canonical?.model;
        const provider = sourceProvider
          ? snapshot.resources.providers.find(({ sourceId }) => sourceId === sourceProvider)
          : snapshot.resources.providers.find(({ option, models }) =>
              option.available && models.some((model) => model.option.available),
            );
        const model = sourceModel
          ? provider?.models.find(({ sourceId }) => sourceId === sourceModel)
          : provider?.models.find(({ option }) => option.available);
        if (!provider || !model) {
          throw new BotCapabilityUnavailableError(
            "A Bot's saved provider and model could not be recovered.",
          );
        }
        const policy = await deps.capabilityStore.getBotPolicy(bot.id);
        if (policy.accessMode !== "full") {
          throw new BotCapabilityUnavailableError(
            "A Custom Bot is missing its saved provider and model authority.",
          );
        }
        const selection = {
          providerId: provider.option.id,
          modelId: model.option.id,
          fileScopeIds: [],
          shellEnabled: false,
          connectionIds: [],
          skillIds: [],
          otherCapabilityIds: [],
        };
        const binding = await deps.catalog.bindCustom({
          audienceId: "desktop:local",
          botId: bot.id,
          selection,
          catalogRevision: snapshot.catalog.revision,
          snapshot,
        });
        await deps.capabilityStore.updateBotPolicy({
          botId: bot.id,
          expectedRevision: policy.revision,
          catalog: snapshot.catalog,
          access: {
            accessMode: "full",
            catalogRevision: snapshot.catalog.revision,
            confirmedForeground: true,
            providerId: selection.providerId,
            modelId: selection.modelId,
          },
          modelBinding: binding.provider,
          ...(canonical ? { canonicalChatId: canonical.id } : {}),
        });
        authority = await deps.capabilityStore.getBotModelAuthority(bot.id);
      }
      if (!authority) {
        throw new BotCapabilityUnavailableError(
          "A Bot's saved provider and model authority is unavailable.",
        );
      }
      if (canonical) {
        const chatPolicy = await deps.capabilityStore.getChatPolicy(canonical.id);
        if (
          chatPolicy.mode === "custom" &&
          (chatPolicy.custom.providerId !== authority.selection.providerId ||
            chatPolicy.custom.modelId !== authority.selection.modelId)
        ) {
          await deps.capabilityStore.updateChatPolicy({
            chatId: canonical.id,
            expectedRevision: chatPolicy.revision,
            catalog: runtimeCatalog.catalog,
            access: {
              mode: "custom",
              catalogRevision: runtimeCatalog.catalog.revision,
              expectedBotPolicyRevision: (await deps.capabilityStore.getBotPolicy(bot.id)).revision,
              custom: {
                ...chatPolicy.custom,
                providerId: authority.selection.providerId,
                modelId: authority.selection.modelId,
              },
            },
          });
        }
        await deps.chatStore.setBotModelSelection(
          canonical.id,
          authority.binding.sourceProviderId,
          authority.binding.sourceModelId,
          (chat) => {
            if (chat.botId !== bot.id) {
              throw new Error("The Bot model mirror changed owner during recovery.");
            }
          },
        );
      }
    }
    for (const bot of bots) {
      await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
        botId: bot.id,
        archived: bot.archivedAt !== undefined,
      });
    }

    const bindings = await deps.managedWorkspace.listBindings();
    const authoritative = new Set(botIds);
    if (bindings.some(({ botId }) => !authoritative.has(botId))) {
      throw new Error("Bot managed-home storage contains a home without a Bot identity.");
    }
    const bound = new Set(bindings.map(({ botId }) => botId));
    if (externallySealed && bots.some((bot) => !bound.has(bot.id))) {
      throw new Error("Bot managed-home storage is missing after migration was sealed.");
    }
    for (const bot of bots) {
      if (bound.has(bot.id)) continue;
      await deps.mutationGate.run(bot.id, async () => {
        const reservation = deps.managedWorkspace.reserve(bot.id);
        const operation = await beginPending({
          operationId: mintOperationId(),
          kind: "create_bot",
          botId: bot.id,
          subject: {
            workspaceId: reservation.workspaceId,
            workspaceCreatedAt: reservation.createdAt,
          },
        });
        await finishCreateBot(operation);
      });
    }
    await deps.managedWorkspace.audit();
    if (!externallySealed) await deps.migrationSeal.seal();

    // Historical Bot chats may still point at an old visible workspace. Keep
    // their history in place; the one-time atomic migration above published
    // inherited policies and sealed the inventory before the app became ready.
    for (const chat of botChats) {
      if (!authoritative.has(chat.botId)) {
        throw new Error("Bot chat storage contains a chat without a Bot identity.");
      }
      const existing = await currentChatPolicy(chat.id);
      if (!existing || existing.botId !== chat.botId || existing.chatId !== chat.id) {
        throw new Error("Bot chat access storage has the wrong identity.");
      }
    }
  };

  const ensureInitialized = (): Promise<void> => {
    initializePromise ??= initialize().catch((error) => {
      initializePromise = undefined;
      throw error;
    });
    return initializePromise;
  };

  const assertOperational = (): void => {
    if (recoveryFailure) {
      throw new Error(
        "Bot changes are paused until Aiden restarts and repairs an incomplete operation.",
      );
    }
  };

  const ensureOperational = async (): Promise<void> => {
    await ensureInitialized();
    assertOperational();
  };

  const runBotMutation = <Result>(
    botId: string,
    action: () => Promise<Result>,
  ): Promise<Result> => deps.mutationGate.run(botId, async () => {
    // A same-Bot caller may have passed the outer check before another queued
    // mutation poisoned live recovery. Recheck after acquiring the gate.
    assertOperational();
    return action();
  });

  const activeBot = async (botId: string): Promise<BotDefinition> => {
    const bot = await deps.botStore.get(botId);
    if (!bot) throw new BotApplicationUnavailableError("missing");
    if (bot.archivedAt !== undefined) {
      throw new BotApplicationUnavailableError("archived");
    }
    await deps.capabilityStore.assertBotAuthorityMatchesIdentity({ botId, archived: false });
    return bot;
  };

  const canonicalChatForBot = async (botId: string): Promise<Chat | null> => {
    const selected = selectCanonicalBotChat(await deps.chatStore.listByBot(botId));
    if (!selected) return null;
    const chat = await deps.chatStore.get(selected.id);
    if (!chat || chat.botId !== botId) {
      throw new BotCapabilityUnavailableError(
        "The canonical Bot chat could not be verified.",
      );
    }
    const policy = await deps.capabilityStore.getChatPolicy(chat.id);
    if (policy.botId !== botId || policy.chatId !== chat.id) {
      throw new BotCapabilityUnavailableError(
        "The canonical Bot chat access policy could not be verified.",
      );
    }
    return chat;
  };

  const createChatUnderMutation = async (
    input: CreateBotChatApplicationInput,
  ): Promise<Chat> => {
    const bot = await activeBot(input.botId);
    const home = await deps.managedWorkspace.resolve(input.botId);
    const existing = await canonicalChatForBot(input.botId);
    if (existing) {
      return existing;
    }
    const botPolicy = await deps.capabilityStore.getBotPolicy(input.botId);
    const binding = botPolicy.accessMode === "custom"
      ? await deps.capabilityStore.getBotBinding(input.botId)
      : undefined;
    const modelAuthority = await deps.capabilityStore.getBotModelAuthority(input.botId);
    if (botPolicy.accessMode === "custom" && !binding) {
      throw new BotCapabilityUnavailableError(
        "This Custom Bot's provider and model selection is unavailable.",
      );
    }
    const inventoryLease = deps.inventoryLeases?.acquire();
    const assertCurrent = () => {
      inventoryLease?.assertCurrent();
      input.assertCurrent?.();
    };
    try {
    const snapshot = await deps.catalog.snapshot({
      audienceId: input.audienceId,
      botId: input.botId,
      ...(binding ? { retainedBindings: [binding] } : {}),
    });
    if (binding) {
      await deps.capabilityStore.assertAuthorityBindingsCurrent({
        botId: input.botId,
        snapshot,
      });
    }
    if (!modelAuthority) {
      throw new BotCapabilityUnavailableError(
        "This Bot's saved provider and model selection is unavailable.",
      );
    }
    const providerId = modelAuthority.binding.sourceProviderId;
    const model = modelAuthority.binding.sourceModelId;
    if (
      modelAuthority &&
      ((input.providerId !== undefined && input.providerId !== providerId) ||
        (input.model !== undefined && input.model !== model))
    ) {
      throw new BotCapabilityUnavailableError(
        "This Bot must use the provider and model saved in Bot settings.",
      );
    }
    const chatId = input.chatId ?? mintChatId();
    const workspaceId = home.workspaceId;
    const operationId = mintOperationId();
    let operation = await beginPending({
      operationId,
      kind: "create_chat",
      botId: input.botId,
      subject: { chatId, workspaceId },
    });
    try {
      await deps.capabilityStore.createChatPolicy({
        chatId,
        botId: input.botId,
        expectedBotPolicyRevision: botPolicy.revision,
        catalog: snapshot.catalog,
        assertCurrent,
      });
      operation = await advance(operation, "policy_committed");
      const chat = await deps.chatStore.create({
        id: chatId,
        title: bot.name,
        workspaceId,
        botId: input.botId,
        providerId,
        model,
        initialAssistantMessage: bot.openingGreeting,
        assertCurrent,
      });
      operation = await advance(operation, "chat_committed");
      await deps.lifecycleJournal.complete(operationId, "chat_committed");
      return chat;
    } catch (error) {
      const visible = await deps.chatStore.get(chatId);
      if (visible) {
        await reconcileVisibleCommit(operation, async () => {
          const committed = await deps.chatStore.get(chatId);
          if (
            !committed ||
            committed.botId !== input.botId ||
            committed.workspaceId !== workspaceId ||
            committed.providerId !== providerId ||
            committed.model !== model
          ) {
            throw new Error("The visible Bot chat does not match its committed operation.");
          }
          const policy = await deps.capabilityStore.getChatPolicy(chatId);
          if (policy.botId !== input.botId) {
            throw new Error("The visible Bot chat has the wrong access policy.");
          }
        });
        return (await deps.chatStore.get(chatId))!;
      }
      try {
        await rollbackChatPolicy(operation, chatId);
      } catch {
        // Preserve the original error and pending journal for startup repair.
      }
      throw error;
    }
    } finally {
      inventoryLease?.release();
    }
  };

  return {
    initialize: ensureOperational,

    async list(includeArchived = false) {
      await ensureOperational();
      return deps.botStore.list(includeArchived);
    },

    async get(botId: string) {
      await ensureOperational();
      return deps.botStore.get(botId);
    },

    async createBot(input: CreateBotApplicationInput): Promise<BotDefinition> {
      await ensureOperational();
      const botId = mintBotId();
      return runBotMutation(botId, async () => {
        const reservation = deps.managedWorkspace.reserve(botId);
        const operationId = mintOperationId();
        let operation = await beginPending({
          operationId,
          kind: "create_bot",
          botId,
          subject: {
            workspaceId: reservation.workspaceId,
            workspaceCreatedAt: reservation.createdAt,
          },
        });
        try {
          await deps.managedWorkspace.provision(botId, reservation);
          operation = await advance(operation, "workspace_provisioned");
          await createPolicy(botId, input.audienceId, input.access);
          operation = await advance(operation, "policy_committed");
          const bot = await deps.botStore.createWithId(botId, input.bot);
          operation = await advance(operation, "identity_committed");
          await deps.lifecycleJournal.complete(operationId, "identity_committed");
          return bot;
        } catch (error) {
          const visible = await deps.botStore.get(botId);
          if (visible) {
            await reconcileVisibleCommit(operation, async () => {
              const committed = await deps.botStore.get(botId);
              if (!committed) throw new Error("The committed Bot identity disappeared.");
              await deps.managedWorkspace.resolve(botId);
              await requirePolicyForVisibleBot(botId);
            });
            return (await deps.botStore.get(botId))!;
          }
          try {
            await deps.capabilityStore.rollbackUncommittedBotPolicy({
              botId,
              identityCommitted: false,
            });
            await deps.managedWorkspace.rollbackProvision({
              ...reservation,
              identityCommitted: false,
            });
            await deps.lifecycleJournal.rollback(operationId, operation.stage);
          } catch {
            // Preserve the original error and pending journal for startup repair.
          }
          throw error;
        }
      });
    },

    async updateBot(input: BotUpdateInput): Promise<BotDefinition> {
      await ensureOperational();
      return runBotMutation(input.id, async () => {
        await activeBot(input.id);
        await deps.managedWorkspace.resolve(input.id);
        await requirePolicyForVisibleBot(input.id);
        return deps.botStore.update(input);
      });
    },

    async updateBotAccess(input: {
      audienceId: string;
      botId: string;
      expectedRevision: string;
      access: BotAccessUpdate;
    }) {
      await ensureOperational();
      return runBotMutation(input.botId, async () => {
        await activeBot(input.botId);
        return withFreshInventoryLease(async (assertCurrent) => {
          const currentChat = await canonicalChatForBot(input.botId);
          const snapshot = await snapshotForAudience(
            input.audienceId,
            input.botId,
            [
              ...(currentChat ? retainedBotProviderForChat(currentChat) : []),
              ...(await retainedVisionProvider(input.botId)),
            ],
          );
          // Audience-safe IDs are revalidated against this exact fresh snapshot.
          // A stale client revision can therefore be rebased without accepting a
          // removed or changed provider, model, connection, skill, or file scope.
          const access: BotAccessUpdate = withCurrentCatalogRevision(
            input.access,
            snapshot.catalog.revision,
          );
          const savedBinding = await deps.capabilityStore.getBotBinding(input.botId);
          const binding = access.accessMode === "custom"
            ? await deps.catalog.bindCustom({
                audienceId: input.audienceId,
                botId: input.botId,
                selection: access.custom,
                catalogRevision: access.catalogRevision,
                retainedBindings: savedBinding ? [savedBinding] : [],
                snapshot,
              })
            : undefined;
          const modelBinding = access.accessMode === "full" && access.providerId && access.modelId
            ? (await deps.catalog.bindCustom({
                audienceId: input.audienceId,
                botId: input.botId,
                selection: {
                  providerId: access.providerId,
                  modelId: access.modelId,
                  fileScopeIds: [],
                  shellEnabled: false,
                  connectionIds: [],
                  skillIds: [],
                  otherCapabilityIds: [],
                },
                catalogRevision: access.catalogRevision,
                snapshot,
              })).provider
            : undefined;
          const visionModelBinding = access.visionModel
            ? await bindVisionModel({
                audienceId: input.audienceId,
                botId: input.botId,
                providerId: access.visionModel.providerId,
                modelId: access.visionModel.modelId,
                catalogRevision: access.catalogRevision,
                requireImages: true,
                snapshot,
              })
            : undefined;
          const currentModel = await deps.capabilityStore.getBotModelAuthority(input.botId);
          const selectedProvider = binding?.provider ?? modelBinding ?? currentModel?.binding;
          const needsMirror = Boolean(
            currentChat && selectedProvider &&
            (currentChat.providerId !== selectedProvider.sourceProviderId ||
              currentChat.model !== selectedProvider.sourceModelId),
          );
          let operation = needsMirror && currentChat
            ? await beginPending({
                operationId: mintOperationId(),
                kind: "update_model",
                botId: input.botId,
                subject: {
                  chatId: currentChat.id,
                  expectedRevision: input.expectedRevision,
                },
              })
            : undefined;
          let result;
          try {
            assertCurrent();
            result = await deps.capabilityStore.updateBotPolicy({
              botId: input.botId,
              expectedRevision: input.expectedRevision,
              catalog: snapshot.catalog,
              access,
              ...(binding ? { binding } : {}),
              ...(modelBinding ? { modelBinding } : {}),
              ...(visionModelBinding ? { visionModelBinding } : {}),
              ...(currentChat ? { canonicalChatId: currentChat.id } : {}),
              assertCurrent,
            });
          } catch (error) {
            if (operation) {
              await deps.lifecycleJournal.rollback(operation.operationId, operation.stage);
            }
            throw error;
          }
          if (operation) {
            try {
              await finishUpdateModel(operation);
            } catch {
              await reconcileVisibleCommit(operation, async () => {
                const authority = await deps.capabilityStore.getBotModelAuthority(input.botId);
                const chat = await deps.chatStore.get(currentChat!.id);
                if (
                  !authority || !chat || chat.botId !== input.botId ||
                  chat.providerId !== authority.binding.sourceProviderId ||
                  chat.model !== authority.binding.sourceModelId
                ) {
                  throw new Error("The Bot model mirror could not be verified after recovery.");
                }
              });
            }
          }
          return result;
        });
      });
    },

    async archiveBot(input: {
      botId: string;
      expectedRevision: string;
    }): Promise<BotDefinition> {
      await ensureOperational();
      return runBotMutation(input.botId, async () => {
        const bot = await activeBot(input.botId);
        if (bot.revision !== input.expectedRevision) {
          throw new BotIdentityRevisionConflictError(bot.revision);
        }
        const operationId = mintOperationId();
        let operation = await beginPending({
          operationId,
          kind: "archive_bot",
          botId: input.botId,
          subject: { expectedRevision: input.expectedRevision },
        });
        try {
          await finishArchive(operation);
          const archived = await deps.botStore.get(input.botId);
          if (!archived || archived.archivedAt === undefined) {
            throw new Error("The Bot archive did not reach its visible commit.");
          }
          void bot;
          return archived;
        } catch {
          await reconcileVisibleCommit(operation, async () => {
            const committed = await deps.botStore.get(input.botId);
            if (!committed || committed.archivedAt === undefined) {
              throw new Error("The Bot archive did not reach its visible commit.");
            }
            await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
              botId: input.botId,
              archived: true,
            });
          });
          return (await deps.botStore.get(input.botId))!;
        }
      });
    },

    async restoreBot(input: {
      botId: string;
      expectedRevision: string;
    }): Promise<BotDefinition> {
      await ensureOperational();
      return runBotMutation(input.botId, async () => {
        const existing = await deps.botStore.get(input.botId);
        if (!existing) throw new Error("This Bot is no longer available.");
        if (existing.revision !== input.expectedRevision) {
          throw new BotIdentityRevisionConflictError(existing.revision);
        }
        await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
          botId: input.botId,
          archived: existing.archivedAt !== undefined,
        });
        if (existing.archivedAt === undefined) return existing;
        await deps.managedWorkspace.resolve(input.botId);
        await requirePolicyForVisibleBot(input.botId);
        const operationId = mintOperationId();
        let operation = await beginPending({
          operationId,
          kind: "restore_bot",
          botId: input.botId,
          subject: { expectedRevision: input.expectedRevision },
        });
        try {
          await finishRestore(operation);
          const restored = await deps.botStore.get(input.botId);
          if (!restored || restored.archivedAt !== undefined) {
            throw new Error("The Bot restore did not reach its visible commit.");
          }
          return restored;
        } catch {
          await reconcileVisibleCommit(operation, async () => {
            const committed = await deps.botStore.get(input.botId);
            if (!committed || committed.archivedAt !== undefined) {
              throw new Error("The Bot restore did not reach its visible commit.");
            }
            await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
              botId: input.botId,
              archived: false,
            });
          });
          return (await deps.botStore.get(input.botId))!;
        }
      });
    },

    async createChat(input: CreateBotChatApplicationInput): Promise<Chat> {
      await ensureOperational();
      return runBotMutation(input.botId, () => createChatUnderMutation(input));
    },

    async getCanonicalChat(botId: string): Promise<Chat | null> {
      await ensureOperational();
      await activeBot(botId);
      await deps.managedWorkspace.resolve(botId);
      return canonicalChatForBot(botId);
    },

    async withBotMutation<Result>(
      botId: string,
      action: (operations: {
        createChat(input: Omit<CreateBotChatApplicationInput, "botId">): Promise<Chat>;
        managedWorkspace: BotManagedWorkspaceResolution;
      }) => Promise<Result>,
    ): Promise<Result> {
      await ensureOperational();
      return runBotMutation(botId, async () => {
        await activeBot(botId);
        const managedWorkspace = await deps.managedWorkspace.resolve(botId);
        return action({
          createChat: (input) => createChatUnderMutation({ ...input, botId }),
          managedWorkspace,
        });
      });
    },

    async copyChat(input: CopyBotChatApplicationInput): Promise<Chat> {
      await ensureOperational();
      return runBotMutation(input.botId, async () => {
        await activeBot(input.botId);
        await deps.managedWorkspace.resolve(input.botId);
        const source = await deps.chatStore.get(input.sourceChatId);
        if (!source || source.botId !== input.botId) {
          throw new Error("This Bot chat is no longer available.");
        }
        const canonical = await canonicalChatForBot(input.botId);
        if (!canonical) throw new Error("This Bot chat is no longer available.");
        return canonical;
      });
    },

    async deleteChat(input: {
      botId: string;
      chatId: string;
      assertCurrent?: (chat: Chat) => void | Promise<void>;
    }): Promise<void> {
      await ensureOperational();
      return runBotMutation(input.botId, async () => {
        await activeBot(input.botId);
        const chat = await deps.chatStore.get(input.chatId);
        if (!chat || chat.botId !== input.botId) {
          throw new Error("This Bot chat is no longer available.");
        }
        if ((await canonicalChatForBot(input.botId))?.id !== chat.id) {
          throw new BotHistoricalChatReadOnlyError();
        }
        throw new BotPersistentChatDeletionError();
      });
    },

    async getBotAccess(botId: string) {
      await ensureOperational();
      return deps.capabilityStore.getBotPolicy(botId);
    },

    async capabilityCatalog(audienceId: string, botId?: string) {
      await ensureOperational();
      const binding = botId === undefined
        ? undefined
        : await (async () => {
            if (!(await deps.botStore.get(botId))) {
              throw new Error("This Bot is no longer available.");
            }
            return deps.capabilityStore.getBotBinding(botId);
          })();
      const chat = botId === undefined ? undefined : await canonicalChatForBot(botId);
      const snapshot = await deps.catalog.snapshot({
        audienceId,
        botId,
        ...(binding ? { retainedBindings: [binding] } : {}),
        ...(botId === undefined
          ? {}
          : {
              retainedProviders: [
                ...(chat ? retainedBotProviderForChat(chat) : []),
                ...(await retainedVisionProvider(botId)),
              ],
            }),
      });
      if (botId !== undefined && snapshot.catalog.skillsEnabled === false) {
        // Full Bots have no exact Custom binding, but their existing chat
        // reductions still own saved skill IDs. Retain safe presentation-only
        // tombstones so native readers/editors can preserve those reductions.
        // Never turn these IDs into runtime resources or new positive grants.
        const chats = await deps.chatStore.listByBot(botId);
        const policies = await Promise.all(chats.map(({ id }) => deps.capabilityStore.getChatPolicy(id)));
        const skills = new Map(snapshot.catalog.skills.map((option) => [option.id, option]));
        for (const policy of policies) {
          if (policy.botId !== botId || policy.mode !== "custom") continue;
          for (const id of policy.custom.skillIds) {
            if (!skills.has(id)) skills.set(id, { id, label: "Saved skill", available: false });
          }
        }
        return finalizeBotCapabilityCatalog({
          ...snapshot.catalog,
          skills: [...skills.values()].sort((left, right) => left.id.localeCompare(right.id)),
        });
      }
      return snapshot.catalog;
    },

    async modelSelection(audienceId: string, botId: string) {
      await ensureOperational();
      const bot = await deps.botStore.get(botId);
      if (!bot) throw new Error("This Bot is no longer available.");
      const authority = await deps.capabilityStore.getBotModelAuthority(botId);
      if (!authority) return undefined;
      const chat = await canonicalChatForBot(botId);
      if (
        chat &&
        (chat.providerId !== authority.binding.sourceProviderId ||
          chat.model !== authority.binding.sourceModelId)
      ) {
        return undefined;
      }
      void audienceId;
      return { ...authority.selection };
    },

    async visionModelSelection(audienceId: string, botId: string) {
      await ensureOperational();
      if (!(await deps.botStore.get(botId))) throw new Error("This Bot is no longer available.");
      const authority = await deps.capabilityStore.getBotVisionModelAuthority?.(botId);
      void audienceId;
      return authority ? { ...authority.selection } : undefined;
    },

    async getChatAccess(chatId: string) {
      await ensureOperational();
      return deps.capabilityStore.getChatPolicy(chatId);
    },

    async updateChatAccess(input: {
      audienceId: string;
      botId: string;
      chatId: string;
      expectedRevision: string;
      access: BotChatAccessUpdate;
    }) {
      await ensureOperational();
      return runBotMutation(input.botId, async () => {
        await activeBot(input.botId);
        const chat = await deps.chatStore.get(input.chatId);
        if (!chat || chat.botId !== input.botId) {
          throw new Error("This Bot chat is no longer available.");
        }
        if ((await canonicalChatForBot(input.botId))?.id !== chat.id) {
          throw new BotHistoricalChatReadOnlyError();
        }
        return withFreshInventoryLease(async (assertCurrent) => {
          const snapshot = await snapshotForAudience(
            input.audienceId,
            input.botId,
            retainedBotProviderForChat(chat),
          );
          const access: BotChatAccessUpdate = withCurrentCatalogRevision(
            input.access,
            snapshot.catalog.revision,
          );
          assertCurrent();
          return deps.capabilityStore.updateChatPolicy({
            chatId: input.chatId,
            expectedRevision: input.expectedRevision,
            catalog: snapshot.catalog,
            access,
            assertCurrent,
          });
        });
      });
    },

    async noticeStatus(audienceId: string) {
      await ensureOperational();
      return deps.capabilityStore.noticeStatus(audienceId);
    },

    async acknowledgeNotice(
      audienceId: string,
      acknowledgement: BotNoticeAcknowledgement,
      assertCurrent?: () => void,
    ) {
      await ensureOperational();
      return deps.capabilityStore.acknowledgeNotice(
        audienceId,
        acknowledgement,
        assertCurrent,
      );
    },

    async revokeNoticeAudience(audienceId: string) {
      await ensureOperational();
      return deps.capabilityStore.revokeNoticeAudience(audienceId);
    },

    async resolveManagedWorkspace(botId: string) {
      await ensureOperational();
      await activeBot(botId);
      return deps.managedWorkspace.resolve(botId);
    },

    async listChats(botId: string) {
      await ensureOperational();
      if (!(await deps.botStore.get(botId))) {
        throw new Error("This Bot is no longer available.");
      }
      return deps.chatStore.listByBot(botId);
    },

    /**
     * Authorize a retained external chat handle without exposing whether
     * policy, notice, or exact Custom bindings caused a denial. Historical
     * reads remain available for archived Bots; every write requires current
     * active runtime authority and the caller's one-time notice decision.
     */
    async authorizeRetainedChat(input: {
      audienceId: string;
      botId: string;
      chatId: string;
      access: "read" | "write";
    }): Promise<boolean> {
      try {
        await ensureOperational();
        const [bot, chat] = await Promise.all([
          deps.botStore.get(input.botId),
          deps.chatStore.get(input.chatId),
        ]);
        if (!bot || !chat || chat.botId !== input.botId) return false;
        await deps.capabilityStore.assertBotAuthorityMatchesIdentity({
          botId: input.botId,
          archived: bot.archivedAt !== undefined,
        });
        const [botPolicy, chatPolicy] = await Promise.all([
          deps.capabilityStore.getBotPolicy(input.botId),
          deps.capabilityStore.getChatPolicy(input.chatId),
        ]);
        if (
          botPolicy.botId !== input.botId ||
          chatPolicy.botId !== input.botId ||
          chatPolicy.chatId !== input.chatId
        ) {
          return false;
        }
        // An archived retained handle is still authentic. The chat service's
        // lifecycle gate returns the stable bot_archived mutation result
        // before any effect; requiring active turn authority here would turn
        // that useful state into an indistinguishable not_found response.
        if (input.access === "read") return true;
        if ((await canonicalChatForBot(input.botId))?.id !== input.chatId) {
          return false;
        }
        if (bot.archivedAt !== undefined) return true;

        const binding = botPolicy.accessMode === "custom"
          ? await deps.capabilityStore.getBotBinding(input.botId)
          : undefined;
        if (botPolicy.accessMode === "custom" && !binding) return false;
        const snapshot = await deps.catalog.snapshotForRuntime({
          botId: input.botId,
          ...(binding ? { retainedBindings: [binding] } : {}),
          retainedProviders: retainedBotProviderForChat(chat),
        });
        const admission = await deps.capabilityStore.admit({
          audienceId: input.audienceId,
          botId: input.botId,
          chatId: input.chatId,
          snapshot,
        });
        admission.lease.release();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type BotApplicationService = ReturnType<typeof createBotApplicationService>;
