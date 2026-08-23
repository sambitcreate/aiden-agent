import { randomUUID } from "node:crypto";
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

const STAGES = {
  create_bot: ["prepared", "workspace_provisioned", "policy_committed", "identity_committed"],
  create_chat: ["prepared", "policy_committed", "chat_committed"],
  copy_chat: ["prepared", "policy_committed", "chat_committed"],
  delete_chat: ["prepared", "authority_fenced", "chat_deleted", "policy_removed"],
  archive_bot: ["prepared", "authority_archived", "identity_archived"],
  restore_bot: ["prepared", "identity_restored", "authority_restored"],
} as const satisfies Partial<Record<BotLifecycleOperation["kind"], readonly BotLifecycleStage[]>>;

type BotStorePort = Pick<
  BotStore,
  "list" | "get" | "createWithId" | "update" | "archive" | "restore"
>;

type ChatStorePort = Pick<
  ChatStore,
  "list" | "get" | "create" | "copyVisibleHistory" | "remove" | "listByBot"
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
>;

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
>;

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
    const access: BotAccessUpdate = requested ?? {
      accessMode: "full",
      catalogRevision: snapshot.catalog.revision,
      confirmedForeground: true,
    };
    const binding = access.accessMode === "custom"
      ? await deps.catalog.bindCustom({
          audienceId,
          selection: access.custom,
          catalogRevision: access.catalogRevision,
        })
      : undefined;
    return { snapshot, access, binding };
  };

  const createPolicy = async (
    botId: string,
    audienceId: string,
    requested?: BotAccessUpdate,
  ) => {
    return withInventoryLease(async (assertCurrent) => {
      const { snapshot, access, binding } = await accessForCreate(audienceId, requested);
      assertCurrent();
      return deps.capabilityStore.createBotPolicy({
        botId,
        catalog: snapshot.catalog,
        access,
        ...(binding ? { binding } : {}),
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

  const reconcileOperation = (operation: BotLifecycleOperation): Promise<void> => {
    switch (operation.kind) {
      case "create_bot": return finishCreateBot(operation);
      case "create_chat": return finishCreateChat(operation);
      case "copy_chat": return finishCopyChat(operation);
      case "delete_chat": return finishDeleteChat(operation);
      case "archive_bot": return finishArchive(operation);
      case "restore_bot": return finishRestore(operation);
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

  const createChatUnderMutation = async (
    input: CreateBotChatApplicationInput,
  ): Promise<Chat> => {
    const bot = await activeBot(input.botId);
    const home = await deps.managedWorkspace.resolve(input.botId);
    const botPolicy = await deps.capabilityStore.getBotPolicy(input.botId);
    const binding = botPolicy.accessMode === "custom"
      ? await deps.capabilityStore.getBotBinding(input.botId)
      : undefined;
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
    const providerId = binding?.provider.sourceProviderId ?? input.providerId;
    const model = binding?.provider.sourceModelId ?? input.model;
    if (
      binding &&
      ((input.providerId !== undefined && input.providerId !== providerId) ||
        (input.model !== undefined && input.model !== model))
    ) {
      throw new BotCapabilityUnavailableError(
        "This Custom Bot must use its selected provider and model.",
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
        return withInventoryLease(async (assertCurrent) => {
          const snapshot = await snapshotForAudience(input.audienceId, input.botId);
          const access = input.access;
          const binding = access.accessMode === "custom"
            ? await deps.catalog.bindCustom({
                audienceId: input.audienceId,
                botId: input.botId,
                selection: access.custom,
                catalogRevision: access.catalogRevision,
              })
            : undefined;
          assertCurrent();
          return deps.capabilityStore.updateBotPolicy({
            botId: input.botId,
            expectedRevision: input.expectedRevision,
            catalog: snapshot.catalog,
            access,
            ...(binding ? { binding } : {}),
            assertCurrent,
          });
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
        const home = await deps.managedWorkspace.resolve(input.botId);
        const source = await deps.chatStore.get(input.sourceChatId);
        if (!source || source.botId !== input.botId) {
          throw new Error("This Bot chat is no longer available.");
        }
        const targetChatId = mintChatId();
        const operationId = mintOperationId();
        let operation = await beginPending({
          operationId,
          kind: "copy_chat",
          botId: input.botId,
          subject: { sourceChatId: input.sourceChatId, targetChatId },
        });
        try {
          await deps.capabilityStore.copyChatPolicy({
            sourceChatId: input.sourceChatId,
            targetChatId,
            botId: input.botId,
          });
          operation = await advance(operation, "policy_committed");
          const chat = await deps.chatStore.copyVisibleHistory({
            sourceChatId: input.sourceChatId,
            targetChatId,
            expectedWorkspaceId: source.workspaceId ?? "default",
            targetWorkspaceId: home.workspaceId,
            throughAssistantMessageId: input.throughAssistantMessageId,
            assertCurrent: input.assertCurrent,
          });
          operation = await advance(operation, "chat_committed");
          await deps.lifecycleJournal.complete(operationId, "chat_committed");
          return chat;
        } catch (error) {
          const visible = await deps.chatStore.get(targetChatId);
          if (visible) {
            await reconcileVisibleCommit(operation, async () => {
              const committed = await deps.chatStore.get(targetChatId);
              if (
                !committed ||
                committed.botId !== input.botId ||
                committed.workspaceId !== home.workspaceId
              ) {
                throw new Error("The visible Bot chat copy does not match its committed operation.");
              }
              const policy = await deps.capabilityStore.getChatPolicy(targetChatId);
              if (policy.botId !== input.botId) {
                throw new Error("The visible Bot chat copy has the wrong access policy.");
              }
            });
            return (await deps.chatStore.get(targetChatId))!;
          }
          try {
            await rollbackChatPolicy(operation, targetChatId);
          } catch {
            // Preserve the original error and pending journal for startup repair.
          }
          throw error;
        }
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
        await input.assertCurrent?.(chat);
        const policy = await deps.capabilityStore.getChatPolicy(input.chatId);
        if (policy.botId !== input.botId) {
          throw new Error("This Bot chat access policy has the wrong owner.");
        }
        await deps.assertChatDeletionAllowed?.(input.botId, input.chatId);
        const operationId = mintOperationId();
        let operation = await beginPending({
          operationId,
          kind: "delete_chat",
          botId: input.botId,
          subject: { chatId: input.chatId },
        });
        let deletionMustRollForward = false;
        try {
          deps.capabilityStore.invalidateChatAuthority(input.botId, input.chatId);
          operation = await advance(operation, "authority_fenced");
          await removeChat(input.chatId, async (current) => {
            if (!current || current.botId !== input.botId) {
              throw new Error("The Bot chat changed owner before deletion.");
            }
            await input.assertCurrent?.(current);
          }, () => {
            deletionMustRollForward = true;
          });
          operation = await advance(operation, "chat_deleted");
          await deps.capabilityStore.deleteChatPolicy({
            chatId: input.chatId,
            botId: input.botId,
          });
          operation = await advance(operation, "policy_removed");
          await deps.lifecycleJournal.complete(operationId, "policy_removed");
        } catch (error) {
          const visible = await deps.chatStore.get(input.chatId);
          if (visible) {
            if (deletionMustRollForward) {
              // The shared deletion coordinator has already installed its
              // durable tombstone. Generic startup reconciliation will remove
              // the visible chat before Bot lifecycle replay; retaining this
              // pending operation lets replay remove the matching policy too.
              deps.capabilityStore.invalidateBotAuthority(input.botId);
              recoveryFailure = error;
              throw new Error(
                "A Bot chat deletion crossed its durable cleanup boundary and must finish on restart.",
              );
            }
            if (visible.botId !== input.botId) {
              throw new Error("The Bot chat changed owner during failed deletion.");
            }
            try {
              await deps.lifecycleJournal.rollback(operationId, operation.stage);
            } catch (rollbackError) {
              deps.capabilityStore.invalidateBotAuthority(input.botId);
              recoveryFailure = rollbackError;
              throw new Error(
                "A Bot chat deletion could not be rolled back safely. Restart Aiden to repair it.",
              );
            }
            throw error;
          }
          await reconcileVisibleCommit(operation, async () => {
            if (await deps.chatStore.get(input.chatId)) {
              throw new Error("The deleted Bot chat reappeared during live recovery.");
            }
            try {
              await deps.capabilityStore.getChatPolicy(input.chatId);
            } catch (policyError) {
              if (policyError instanceof BotCapabilityUnavailableError) return;
              throw policyError;
            }
            throw new Error("The deleted Bot chat retained an access policy.");
          });
        }
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
      const snapshot = await deps.catalog.snapshot({
        audienceId,
        botId,
        ...(binding ? { retainedBindings: [binding] } : {}),
      });
      return snapshot.catalog;
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
        return withInventoryLease(async (assertCurrent) => {
          const snapshot = await snapshotForAudience(
            input.audienceId,
            input.botId,
            retainedBotProviderForChat(chat),
          );
          assertCurrent();
          return deps.capabilityStore.updateChatPolicy({
            chatId: input.chatId,
            expectedRevision: input.expectedRevision,
            catalog: snapshot.catalog,
            access: input.access,
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
        if (input.access === "read" || bot.archivedAt !== undefined) return true;

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
