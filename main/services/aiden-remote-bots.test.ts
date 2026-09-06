import assert from "node:assert/strict";
import test from "node:test";
import {
  BotCapabilityValidationError,
  type BotAccessUpdate,
  type BotAccessView,
  type BotCapabilityCatalog,
  type BotChatAccessUpdate,
  type BotChatAccessView,
} from "../../renderer/shared/bot-capabilities.js";
import type { BotCreateInput, BotDefinition, BotUpdateInput } from "../../renderer/shared/bots.js";
import { BotCapabilityRevisionConflictError } from "./bot-capability-store-core.js";
import { BotIdentityRevisionConflictError } from "./bot-store-core.js";
import {
  AidenRemoteBotService,
  EMPTY_AIDEN_REMOTE_BOT_FAVORITES,
  normalizeAidenRemoteBotFavoritesSnapshot,
  projectAidenRemoteBotSummary,
  type AidenRemoteBotServiceOptions,
  type AidenRemoteBotFavoritesSnapshot,
} from "./aiden-remote-bots.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { parseAidenRemoteBotCapabilityCatalog } from "./aiden-remote-protocol.js";
import type { Chat } from "./types.js";

const CATALOG_REVISION = "catalog_revision_1";
const PROVIDER_ID = "provider_opaque_1";
const MODEL_ID = "model_opaque_1";

function catalog(): BotCapabilityCatalog {
  return {
    revision: CATALOG_REVISION,
    providers: [{
      id: PROVIDER_ID,
      label: "Configured provider",
      available: true,
      models: [{ id: MODEL_ID, label: "Configured model", available: true }],
    }],
    fileScopes: [{
      id: "scope_bot_home",
      label: "Bot folder",
      available: true,
      kind: "bot_home",
    }],
    shellAvailable: true,
    connections: [],
    skills: [],
    otherCapabilities: [],
    notice: {
      version: "bot-full-access-v1",
      requiresAcknowledgement: false,
      acceptedAt: "2026-08-23T00:00:00.000Z",
      acceptedDecision: "continue_full",
    },
  };
}

function fullAccess(botId: string, revision = "policy_revision_1"): BotAccessView {
  return {
    botId,
    accessMode: "full",
    revision,
    policyEpoch: "policy_epoch_1",
    summary: "Can use your Mac, shell, enabled connections, and skills.",
  };
}

function bot(id: string, overrides: Partial<BotDefinition> = {}): BotDefinition {
  return {
    id,
    revision: `bot_revision_${id}`,
    name: "Planner",
    description: "Keeps projects moving",
    instructions: "Help plan projects.",
    openingGreeting: "What should we plan?",
    avatar: "spark",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function fixture(
  initial: BotDefinition[] = [bot("bot_1")],
  options: {
    idempotency?: AidenIdempotencyLedger;
    persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
    avatar?: AidenRemoteBotServiceOptions["avatar"];
    inbox?: AidenRemoteBotServiceOptions["inbox"];
    resolveProviderModel?: AidenRemoteBotServiceOptions["resolveProviderModel"];
    withBotMutation?: NonNullable<
      AidenRemoteBotServiceOptions["application"]["withBotMutation"]
    >;
    withFavoritesMutation?: AidenRemoteBotServiceOptions["withFavoritesMutation"];
    beforeSaveFavorites?: (
      snapshot: AidenRemoteBotFavoritesSnapshot,
    ) => Promise<void>;
    onArchiveBot?: (botId: string) => Promise<void>;
    updateBotAccessError?: unknown;
  } = {},
) {
  let bots = initial.map((entry) => structuredClone(entry));
  const policies = new Map(bots.map(({ id }) => [id, fullAccess(id)]));
  const chats = new Map<string, Chat>();
  const chatPolicies = new Map<string, BotChatAccessView>();
  let favorites: AidenRemoteBotFavoritesSnapshot = structuredClone(
    EMPTY_AIDEN_REMOTE_BOT_FAVORITES,
  );
  let botSequence = bots.length;
  let chatSequence = 0;
  let createCalls = 0;
  let savedFavorites = 0;
  const resolvedSelections: unknown[] = [];
  const notifications: string[] = [];

  const application = {
    async list(includeArchived = false) {
      return structuredClone(bots.filter((entry) => includeArchived || entry.archivedAt === undefined));
    },
    async get(botId: string) {
      return structuredClone(bots.find(({ id }) => id === botId) ?? null);
    },
    async createBot(input: {
      audienceId: string;
      bot: BotCreateInput;
      access?: BotAccessUpdate;
    }) {
      createCalls += 1;
      botSequence += 1;
      const created = bot(`bot_${botSequence}`, {
        ...input.bot,
        revision: `bot_revision_${botSequence}`,
        createdAt: 3_000 + botSequence,
        updatedAt: 3_000 + botSequence,
      });
      bots.push(created);
      policies.set(created.id, fullAccess(created.id));
      return structuredClone(created);
    },
    async updateBot(input: BotUpdateInput) {
      const index = bots.findIndex(({ id }) => id === input.id);
      const existing = bots[index];
      if (!existing) throw new Error("missing");
      if (existing.revision !== input.expectedRevision) {
        throw new BotIdentityRevisionConflictError(existing.revision);
      }
      const updated = bot(existing.id, {
        ...input,
        description: input.description,
        openingGreeting: input.openingGreeting,
        revision: `${existing.revision}_next`,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt + 1,
      });
      bots[index] = updated;
      return structuredClone(updated);
    },
    async archiveBot(input: { botId: string; expectedRevision: string }) {
      const action = async () => {
        const index = bots.findIndex(({ id }) => id === input.botId);
        const existing = bots[index]!;
        if (existing.revision !== input.expectedRevision) {
          throw new BotIdentityRevisionConflictError(existing.revision);
        }
        const archived = {
          ...existing,
          revision: `${existing.revision}_archived`,
          updatedAt: existing.updatedAt + 1,
          archivedAt: existing.updatedAt + 1,
        };
        bots[index] = archived;
        await options.onArchiveBot?.(input.botId);
        return structuredClone(archived);
      };
      return options.withBotMutation
        ? options.withBotMutation(input.botId, action)
        : action();
    },
    async restoreBot(input: { botId: string; expectedRevision: string }) {
      const index = bots.findIndex(({ id }) => id === input.botId);
      const existing = bots[index]!;
      if (existing.revision !== input.expectedRevision) {
        throw new BotIdentityRevisionConflictError(existing.revision);
      }
      const { archivedAt: _archivedAt, ...active } = existing;
      const restored = {
        ...active,
        revision: `${existing.revision}_restored`,
        updatedAt: existing.updatedAt + 1,
      };
      bots[index] = restored;
      return structuredClone(restored);
    },
    async createChat(input: {
      audienceId: string;
      botId: string;
      providerId?: string;
      model?: string;
      assertCurrent?: () => void;
    }) {
      input.assertCurrent?.();
      chatSequence += 1;
      const created: Chat = {
        id: `chat_${chatSequence}`,
        botId: input.botId,
        workspaceId: "managed_home_opaque",
        title: "Planner",
        providerId: input.providerId,
        model: input.model,
        createdAt: 4_000,
        updatedAt: 4_000,
        messages: [],
      };
      chats.set(created.id, created);
      chatPolicies.set(created.id, {
        chatId: created.id,
        botId: input.botId,
        mode: "inherit",
        revision: "chat_policy_revision_1",
        botPolicyRevision: policies.get(input.botId)!.revision,
        summary: "Full",
      });
      return structuredClone(created);
    },
    async getCanonicalChat(botId: string) {
      const matching = [...chats.values()].filter((chat) => chat.botId === botId);
      const selected = matching.sort((left, right) =>
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt ||
        left.id.localeCompare(right.id),
      )[0];
      return selected ? structuredClone(selected) : null;
    },
    async capabilityCatalog() { return catalog(); },
    async getBotAccess(botId: string) {
      const policy = policies.get(botId);
      if (!policy) throw new Error("missing");
      return structuredClone(policy);
    },
    async modelSelection(_audienceId: string, botId: string) {
      const matching = [...chats.values()]
        .filter((chat) => chat.botId === botId)
        .sort((left, right) =>
          right.updatedAt - left.updatedAt ||
          right.createdAt - left.createdAt ||
          left.id.localeCompare(right.id),
        );
      const selected = matching[0];
      return selected?.providerId === "source-provider" && selected.model === "source-model"
        ? { providerId: PROVIDER_ID, modelId: MODEL_ID }
        : undefined;
    },
    async updateBotAccess(input: {
      botId: string;
      expectedRevision: string;
      access: BotAccessUpdate;
    }) {
      if (options.updateBotAccessError !== undefined) {
        throw options.updateBotAccessError;
      }
      const current = policies.get(input.botId)!;
      if (current.revision !== input.expectedRevision) {
        throw new BotCapabilityRevisionConflictError(current.revision);
      }
      const updated: BotAccessView = input.access.accessMode === "full"
        ? { ...fullAccess(input.botId, `${current.revision}_next`) }
        : {
            botId: input.botId,
            accessMode: "custom",
            revision: `${current.revision}_next`,
            policyEpoch: "policy_epoch_2",
            summary: "Uses only the access you select. This chat can reduce it further.",
            custom: structuredClone(input.access.custom),
          };
      policies.set(input.botId, updated);
      return structuredClone(updated);
    },
    async getChatAccess(chatId: string) {
      const policy = chatPolicies.get(chatId);
      if (!policy) throw new Error("missing");
      return structuredClone(policy);
    },
    async updateChatAccess(input: {
      botId: string;
      chatId: string;
      expectedRevision: string;
      access: BotChatAccessUpdate;
    }) {
      const current = chatPolicies.get(input.chatId)!;
      if (current.revision !== input.expectedRevision) {
        throw new BotCapabilityRevisionConflictError(current.revision);
      }
      const updated: BotChatAccessView = input.access.mode === "inherit"
        ? {
            chatId: input.chatId,
            botId: input.botId,
            mode: "inherit",
            revision: `${current.revision}_next`,
            botPolicyRevision: input.access.expectedBotPolicyRevision,
            summary: "Full",
          }
        : {
            chatId: input.chatId,
            botId: input.botId,
            mode: "custom",
            revision: `${current.revision}_next`,
            botPolicyRevision: input.access.expectedBotPolicyRevision,
            summary: "Custom",
            custom: structuredClone(input.access.custom),
          };
      chatPolicies.set(input.chatId, updated);
      return structuredClone(updated);
    },
    async withBotMutation<Result>(
      botId: string,
      action: () => Promise<Result>,
    ): Promise<Result> {
      return options.withBotMutation
        ? options.withBotMutation(botId, action)
        : action();
    },
  };

  const service = new AidenRemoteBotService({
    application,
    chatStore: { get: async (chatId) => structuredClone(chats.get(chatId) ?? null) },
    favorites: {
      load: async () => structuredClone(favorites),
      save: async (snapshot) => {
        await options.beforeSaveFavorites?.(structuredClone(snapshot));
        favorites = structuredClone(snapshot);
        savedFavorites += 1;
      },
    },
    resolveProviderModel: async (selection) => {
      resolvedSelections.push(structuredClone(selection));
      assert.equal(selection.providerId, PROVIDER_ID);
      assert.equal(selection.modelId, MODEL_ID);
      return { providerId: "source-provider", model: "source-model" };
    },
    ...options,
    notifyBotsChanged: (botId) => notifications.push(`bot:${botId ?? "all"}`),
    notifyChatsChanged: (chatId) => notifications.push(`chat:${chatId ?? "all"}`),
  });

  return {
    service,
    createCalls: () => createCalls,
    savedFavorites: () => savedFavorites,
    favoriteSnapshot: () => structuredClone(favorites),
    resolvedSelections,
    notifications,
    chats,
    chatPolicies,
    policies,
    bots: () => structuredClone(bots),
    pruneFavoriteUnsafe(botId: string) {
      favorites = {
        version: 1,
        botIds: favorites.botIds.filter((candidate) => candidate !== botId),
      };
      savedFavorites += 1;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function serializedLane() {
  let tail: Promise<void> = Promise.resolve();
  return async function run<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = tail.then(action, action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function serializedBotGate(events: string[]) {
  const tails = new Map<string, Promise<void>>();
  return async function run<Result>(
    botId: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const previous = tails.get(botId) ?? Promise.resolve();
    const result = previous.then(async () => {
      events.push(`enter:${botId}`);
      try {
        return await action();
      } finally {
        events.push(`exit:${botId}`);
      }
    }, async () => {
      events.push(`enter:${botId}`);
      try {
        return await action();
      } finally {
        events.push(`exit:${botId}`);
      }
    });
    tails.set(botId, result.then(() => undefined, () => undefined));
    return result;
  };
}

test("Bot projection exposes semantic identity without private paths or credentials", () => {
  const projected = projectAidenRemoteBotSummary(bot("bot_safe"));
  const serialized = JSON.stringify(projected);
  assert.equal(projected.purpose, "Keeps projects moving");
  assert.equal(projected.health, "ready");
  assert.equal(serialized.includes("workspace"), false);
  assert.equal(serialized.includes("credential"), false);
  assert.equal(serialized.includes("/Users/"), false);
});

test("Remote Bot inbox and avatar adapter stay device-scoped, mutation-gated, and idempotent", async () => {
  const avatarCalls: string[] = [];
  let asset: {
    assetRevision: string;
    mimeType: "image/png";
    width: 512;
    height: 512;
    byteSize: number;
  } | undefined;
  const app = fixture([bot("bot_1")], {
    inbox: {
      list: async (deviceId, input) => ({
        conversations: [{
          chatId: "chat_1",
          botId: "bot_1",
          title: input.query ?? "Inbox",
          activityState: "waiting_for_approval",
          canRespondToApproval: deviceId === "device_1",
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(2_000).toISOString(),
          revision: "chat_revision_1",
        }],
      }),
    },
    avatar: {
      view: async (_botId, semantic) => ({
        semantic: structuredClone(semantic),
        ...(asset ? { asset: structuredClone(asset) } : {}),
      }),
      put: async (mutation) => {
        avatarCalls.push(
          `put:${mutation.botId}:${mutation.expectedAssetRevision ?? "none"}:${mutation.operationId}`,
        );
        asset = {
          assetRevision: `avatar_revision_${"a".repeat(32)}`,
          mimeType: "image/png",
          width: 512,
          height: 512,
          byteSize: 5,
        };
        return structuredClone(asset);
      },
      delete: async (mutation) => {
        avatarCalls.push(
          `delete:${mutation.botId}:${mutation.expectedAssetRevision ?? "none"}:${mutation.operationId}`,
        );
        asset = undefined;
      },
      content: async (botId, revision) => {
        avatarCalls.push(`content:${botId}:${revision}`);
        if (!asset || asset.assetRevision !== revision) throw new Error("missing");
        return { metadata: structuredClone(asset), bytes: Buffer.from("hello") };
      },
    },
  });

  const inbox = await app.service.listConversations("device_1", {
    query: "Plan this week",
  });
  assert.equal(inbox.conversations[0]?.title, "Plan this week");
  assert.equal(inbox.conversations[0]?.canRespondToApproval, true);

  const upload = { mimeType: "image/png", data: "aGVsbG8=" } as const;
  const first = await app.service.putAvatar(
    "device_1",
    "bot_1",
    "bot_revision_bot_1",
    "avatar-idempotency-key-0001",
    upload,
  );
  const replay = await app.service.putAvatar(
    "device_1",
    "bot_1",
    "bot_revision_bot_1",
    "avatar-idempotency-key-0001",
    upload,
  );
  assert.deepEqual(replay, first);
  assert.equal(avatarCalls.filter((call) => call.startsWith("put:")).length, 1);
  await assert.rejects(
    app.service.putAvatar(
      "device_1",
      "bot_1",
      "bot_revision_bot_1",
      "avatar-idempotency-key-0001",
      { mimeType: "image/png", data: "d29ybGQ=" },
    ),
    (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
  );
  await assert.rejects(
    app.service.putAvatar(
      "device_2",
      "bot_1",
      "bot_revision_bot_1",
      "avatar-idempotency-key-race-01",
      upload,
    ),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
  assert.equal(avatarCalls.filter((call) => call.startsWith("put:")).length, 1);
  assert.equal(
    (await app.service.avatarContent("bot_1", first.assetRevision)).bytes.toString("utf8"),
    "hello",
  );
  const fallback = await app.service.deleteAvatar(
    "bot_1",
    first.assetRevision,
  );
  assert.equal(fallback.avatar.asset, undefined);
  assert.equal(avatarCalls.filter((call) => call.startsWith("delete:")).length, 1);

  await assert.rejects(
    app.service.putAvatar(
      "device_1",
      "bot_1",
      "stale_revision",
      "avatar-idempotency-key-0002",
      upload,
    ),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
});

test("complete Remote Bot flow is exact, idempotent, revisioned, and Bot-classified", async () => {
  const app = fixture([]);
  const createRequest = {
    name: "Researcher",
    purpose: "Finds useful context",
    instructions: "Research carefully.",
    openingGreeting: "What should I research?",
    avatar: "orbit",
    access: {
      accessMode: "full",
      catalogRevision: CATALOG_REVISION,
      confirmedForeground: true,
    },
  } as const;
  const created = await app.service.create("device_1", "bot-create-key-0001", createRequest);
  const replay = await app.service.create("device_1", "bot-create-key-0001", createRequest);
  assert.deepEqual(replay, created);
  assert.equal(app.createCalls(), 1);
  assert.equal(created.instructions, "Research carefully.");

  const updated = await app.service.updateIdentity(created.id, created.revision, {
    purpose: "Researches selected topics",
    openingGreeting: "",
  });
  assert.equal(updated.purpose, "Researches selected topics");
  assert.equal(updated.openingGreeting, undefined);

  const chat = await app.service.createChat(
    "device_1",
    created.id,
    "bot-chat-key-0001",
    { providerId: PROVIDER_ID, modelId: MODEL_ID },
  );
  assert.equal(chat.botId, created.id);
  assert.equal(chat.providerId, "source-provider");
  assert.equal(chat.modelId, "source-model");
  assert.equal(app.resolvedSelections.length, 1);
  const replayedChat = await app.service.createChat(
    "device_1",
    created.id,
    "bot-chat-key-0001",
    { providerId: PROVIDER_ID, modelId: MODEL_ID },
  );
  const reopenedChat = await app.service.createChat(
    "device_1",
    created.id,
    "bot-chat-key-0002",
    { providerId: "stale-provider", modelId: "stale-model" },
  );
  assert.equal(replayedChat.id, chat.id);
  assert.equal(reopenedChat.id, chat.id);
  assert.equal(app.chats.size, 1);
  assert.equal(app.resolvedSelections.length, 1);
  assert.deepEqual(
    (await app.service.get(created.id, "device_1")).modelSelection,
    { providerId: PROVIDER_ID, modelId: MODEL_ID },
  );

  const subset = await app.service.getChatAccess(chat.id);
  const narrowed = await app.service.updateChatAccess(
    "device_1",
    chat.id,
    subset.revision,
    {
      mode: "custom",
      catalogRevision: CATALOG_REVISION,
      expectedBotPolicyRevision: subset.botPolicyRevision,
      custom: {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        fileScopeIds: ["scope_bot_home"],
        shellEnabled: false,
        connectionIds: [],
        skillIds: [],
        otherCapabilityIds: [],
      },
    },
  );
  assert.equal(narrowed.mode, "custom");
  assert.equal(narrowed.custom.shellEnabled, false);

  const archived = await app.service.archive(created.id, updated.revision);
  assert.equal(archived.health, "archived");
  const restored = await app.service.restore(
    "device_1",
    created.id,
    archived.revision,
    "bot-restore-key-001",
  );
  assert.equal(restored.health, "ready");
  assert.ok(app.notifications.includes(`bot:${created.id}`));
  assert.ok(app.notifications.includes(`chat:${chat.id}`));
});

test("a durable legacy chat replay reconciles to the current canonical Bot chat", async () => {
  const idempotency = new AidenIdempotencyLedger();
  const request = { providerId: PROVIDER_ID, modelId: MODEL_ID } as const;
  const beforeUpgrade = fixture([bot("bot_1")], { idempotency });
  const historical = await beforeUpgrade.service.createChat(
    "device_1",
    "bot_1",
    "bot-chat-legacy-replay-01",
    request,
  );

  const restarted = fixture([bot("bot_1")], {
    idempotency: new AidenIdempotencyLedger(idempotency.snapshot()),
  });
  restarted.chats.set(historical.id, {
    id: historical.id,
    botId: historical.botId,
    workspaceId: "managed_home_opaque",
    title: historical.title,
    providerId: historical.providerId,
    model: historical.modelId,
    createdAt: Date.parse(historical.createdAt),
    updatedAt: Date.parse(historical.updatedAt),
    messages: [],
  });
  restarted.chats.set("chat_current", {
    id: "chat_current",
    botId: "bot_1",
    workspaceId: "managed_home_opaque",
    title: "Planner",
    providerId: "source-provider",
    model: "source-model",
    createdAt: 5_000,
    updatedAt: 6_000,
    messages: [],
  });

  const replay = await restarted.service.createChat(
    "device_1",
    "bot_1",
    "bot-chat-legacy-replay-01",
    request,
  );
  const repeatedReplay = await restarted.service.createChat(
    "device_1",
    "bot_1",
    "bot-chat-legacy-replay-01",
    request,
  );
  assert.equal(replay.id, "chat_current");
  assert.equal(replay.botId, "bot_1");
  assert.deepEqual(repeatedReplay, replay);
  assert.equal(restarted.resolvedSelections.length, 0);
});

test("an invalidated provider inventory lease publishes neither Full nor Custom Bot chat state", async () => {
  for (const accessMode of ["full", "custom"] as const) {
    let released = 0;
    const app = fixture([bot(`bot_${accessMode}`)], {
      resolveProviderModel: async (selection) => {
        assert.equal(selection.providerId, PROVIDER_ID);
        assert.equal(selection.modelId, MODEL_ID);
        return {
          providerId: "source-provider",
          model: "source-model",
          assertCurrent: () => {
            throw new AidenRemoteServiceError(
              "operation_stale",
              "Provider inventory changed before publication.",
              409,
              true,
            );
          },
          release: () => { released += 1; },
        };
      },
    });
    const botId = `bot_${accessMode}`;
    if (accessMode === "custom") {
      app.policies.set(botId, {
        botId,
        accessMode: "custom",
        revision: "policy_revision_custom",
        policyEpoch: "policy_epoch_custom",
        summary: "Custom",
        custom: {
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          fileScopeIds: ["scope_bot_home"],
          shellEnabled: false,
          connectionIds: [],
          skillIds: [],
          otherCapabilityIds: [],
        },
      });
    }

    await assert.rejects(
      app.service.createChat(
        "device_1",
        botId,
        `inventory-stale-${accessMode}-key`,
        { providerId: PROVIDER_ID, modelId: MODEL_ID },
      ),
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "operation_stale",
    );
    assert.equal(app.chats.size, 0);
    assert.equal(app.chatPolicies.size, 0);
    assert.equal(released, 1);
    assert.equal(app.notifications.some((entry) => entry.startsWith("chat:")), false);
  }
});

test("an omitted first-chat pair inherits Bot authority without resolving a new default", async () => {
  const app = fixture([bot("bot_saved_model")], {
    resolveProviderModel: async () => {
      throw new Error("An omitted pair must not resolve the current global default.");
    },
  });

  const chat = await app.service.createChat(
    "device_1",
    "bot_saved_model",
    "inherit-saved-model-key",
    {},
  );

  assert.equal(chat.botId, "bot_saved_model");
  assert.equal(app.resolvedSelections.length, 0);
});

test("Mac archive and Remote favorites updates are linearizable through Bot gates then the shared favorites lane", async () => {
  {
    const gateEvents: string[] = [];
    const withBotMutation = serializedBotGate(gateEvents);
    const withFavoritesMutation = serializedLane();
    const saveEntered = deferred();
    const releaseSave = deferred();
    let blockFavoriteSave = true;
    let app!: ReturnType<typeof fixture>;
    app = fixture([bot("bot_1"), bot("bot_2")], {
      withBotMutation,
      withFavoritesMutation,
      beforeSaveFavorites: async (snapshot) => {
        if (blockFavoriteSave && snapshot.botIds.length > 0) {
          blockFavoriteSave = false;
          saveEntered.resolve();
          await releaseSave.promise;
        }
      },
      onArchiveBot: (botId) => withFavoritesMutation(async () => {
        app.pruneFavoriteUnsafe(botId);
      }),
    });
    const empty = await app.service.favorites();
    const update = app.service.updateFavorites(empty.revision, {
      botIds: ["bot_2", "bot_1"],
    });
    await saveEntered.promise;
    const detail = await app.service.get("bot_1");
    const archive = app.service.archive("bot_1", detail.revision);
    releaseSave.resolve();

    assert.deepEqual((await update).botIds, ["bot_2", "bot_1"]);
    assert.equal((await archive).health, "archived");
    assert.deepEqual((await app.service.favorites()).botIds, ["bot_2"]);
    assert.deepEqual(gateEvents.slice(0, 6), [
      "enter:bot_1",
      "enter:bot_2",
      "exit:bot_2",
      "exit:bot_1",
      "enter:bot_1",
      "exit:bot_1",
    ]);
  }

  {
    const withFavoritesMutation = serializedLane();
    const archiveHookEntered = deferred();
    const releaseArchiveHook = deferred();
    let app!: ReturnType<typeof fixture>;
    app = fixture([bot("bot_1")], {
      withBotMutation: serializedBotGate([]),
      withFavoritesMutation,
      onArchiveBot: (botId) => withFavoritesMutation(async () => {
        archiveHookEntered.resolve();
        await releaseArchiveHook.promise;
        app.pruneFavoriteUnsafe(botId);
      }),
    });
    const empty = await app.service.favorites();
    const detail = await app.service.get("bot_1");
    const archive = app.service.archive("bot_1", detail.revision);
    await archiveHookEntered.promise;
    const update = app.service.updateFavorites(empty.revision, { botIds: ["bot_1"] });
    releaseArchiveHook.resolve();

    assert.equal((await archive).health, "archived");
    await assert.rejects(
      update,
      (error: unknown) =>
        error instanceof AidenRemoteServiceError && error.code === "bot_archived",
    );
    assert.deepEqual((await app.service.favorites()).botIds, []);
  }
});

test("stale identity, policy, and favorites revisions return authoritative conflicts", async () => {
  const app = fixture();
  const detail = await app.service.get("bot_1");
  await assert.rejects(
    app.service.updateIdentity("bot_1", "stale_revision", { name: "Changed" }),
    (error: unknown) =>
      (error as { code?: string }).code === "revision_conflict" &&
      (error as { details?: { currentRevision?: string } }).details?.currentRevision === detail.revision,
  );
  await assert.rejects(
    app.service.updateAccess("device_1", "bot_1", "stale_policy", {
      accessMode: "full",
      catalogRevision: CATALOG_REVISION,
      confirmedForeground: true,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "revision_conflict" &&
      (error as { details?: { currentRevision?: string } }).details?.currentRevision ===
        "policy_revision_1",
  );
  const favorites = await app.service.favorites();
  await app.service.updateFavorites(favorites.revision, { botIds: ["bot_1"] });
  await assert.rejects(
    app.service.updateFavorites(favorites.revision, { botIds: [] }),
    (error: unknown) => (error as { code?: string }).code === "revision_conflict",
  );
});

test("stale capability validation maps to a retryable operation conflict", async () => {
  const app = fixture(undefined, {
    updateBotAccessError: new BotCapabilityValidationError(
      "Internal inventory details must not cross the Remote boundary.",
    ),
  });

  await assert.rejects(
    app.service.updateAccess("device_1", "bot_1", "policy_revision_1", {
      accessMode: "full",
      catalogRevision: CATALOG_REVISION,
      confirmedForeground: true,
    }),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      error.code === "operation_stale" &&
      error.status === 409 &&
      error.retryable === true &&
      !error.message.includes("Internal inventory details"),
  );
});

test("favorites preserve order, reject duplicates and archived Bots, and prune on archive", async () => {
  const app = fixture([bot("bot_1"), bot("bot_2")]);
  const empty = await app.service.favorites();
  const ordered = await app.service.updateFavorites(empty.revision, {
    botIds: ["bot_2", "bot_1"],
  });
  assert.deepEqual(ordered.botIds, ["bot_2", "bot_1"]);
  await assert.rejects(
    app.service.updateFavorites(ordered.revision, { botIds: ["bot_1", "bot_1"] }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  const detail = await app.service.get("bot_2");
  await app.service.archive("bot_2", detail.revision);
  assert.deepEqual((await app.service.favorites()).botIds, ["bot_1"]);
  assert.ok(app.savedFavorites() >= 2);
});

test("unknown fields and private capability material fail before application effects", async () => {
  const app = fixture([]);
  await assert.rejects(
    app.service.create("device_1", "bot-create-key-0002", {
      name: "Unsafe",
      purpose: "",
      instructions: "No",
      avatar: "spark",
      access: {
        accessMode: "full",
        catalogRevision: CATALOG_REVISION,
        confirmedForeground: true,
        credentialFingerprint: "secret",
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  assert.equal(app.createCalls(), 0);
  await assert.rejects(
    app.service.createChat("device_1", "bot_missing", "bot-chat-key-0002", {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      workspacePath: "/Users/private",
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});

test("durable Bot idempotency publishes in-flight admission before mutation and replays", async () => {
  let persisted: AidenIdempotencySnapshot | undefined;
  const snapshots: string[] = [];
  const first = fixture([], {
    persistIdempotency: async (snapshot) => {
      persisted = structuredClone(snapshot);
      snapshots.push(snapshot.entries[0]?.state ?? "missing");
    },
  });
  const request = {
    name: "Durable",
    purpose: "Persists",
    instructions: "Persist safely.",
    avatar: "spark",
    access: {
      accessMode: "full",
      catalogRevision: CATALOG_REVISION,
      confirmedForeground: true,
    },
  } as const;
  const created = await first.service.create("device_1", "bot-durable-key-001", request);
  assert.deepEqual(snapshots, ["in_flight", "fulfilled"]);
  assert.equal(first.createCalls(), 1);
  assert.ok(persisted);

  const restarted = fixture([], {
    idempotency: new AidenIdempotencyLedger(persisted),
  });
  const replay = await restarted.service.create("device_1", "bot-durable-key-001", request);
  assert.deepEqual(replay, created);
  assert.equal(restarted.createCalls(), 0);
});

test("favorites storage rejects corrupt, duplicate, and oversized snapshots", () => {
  assert.deepEqual(
    normalizeAidenRemoteBotFavoritesSnapshot({ version: 1, botIds: ["bot_1"] }),
    { version: 1, botIds: ["bot_1"] },
  );
  assert.throws(() => normalizeAidenRemoteBotFavoritesSnapshot({
    version: 1,
    botIds: ["bot_1", "bot_1"],
  }));
  assert.throws(() => normalizeAidenRemoteBotFavoritesSnapshot({ version: 2, botIds: [] }));
});


test("Remote catalog preserves the strict optional global Skills gate", () => {
  const saved = { ...catalog(), skills: [{ id: "skill:saved", label: "Saved skill", available: false }] };
  saved.providers[0]!.models[0]!.supportsImages = false;
  assert.equal(parseAidenRemoteBotCapabilityCatalog(saved).skillsEnabled, undefined);
  assert.equal(parseAidenRemoteBotCapabilityCatalog({ ...saved, skillsEnabled: false }).skillsEnabled, false);
  assert.equal(parseAidenRemoteBotCapabilityCatalog({ ...saved, skillsEnabled: true }).skillsEnabled, true);
  for (const invalid of [null, "false", 0, {}, []]) {
    assert.throws(() => parseAidenRemoteBotCapabilityCatalog({ ...saved, skillsEnabled: invalid }), /skillsEnabled/u);
  }
});
