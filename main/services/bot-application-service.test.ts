import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_FULL_ACCESS_NOTICE_VERSION,
  type BotAccessUpdate,
  type BotAccessView,
  type BotCapabilityCatalog,
  type BotChatAccessView,
} from "../../renderer/shared/bot-capabilities.js";
import type { BotDefinition, BotUpdateInput } from "../../renderer/shared/bots.js";
import type { BotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";
import type {
  BotLifecycleBeginInput,
  BotLifecycleOperation,
  BotLifecycleStage,
} from "./bot-lifecycle-journal-core.js";
import { BotMutationGate } from "./bot-mutation-gate.js";
import { reconcilePendingChatDeletions } from "./chat-deletion-reconciliation.js";
import type { Chat } from "./types.js";
import {
  createBotApplicationService,
  type BotApplicationDependencies,
} from "./bot-application-service.js";
import { TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE } from "./telegram/telegram-bot-chat-lifecycle.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CATALOG_REVISION = "catalog:1";

function catalog(): BotCapabilityCatalogSnapshot {
  const publicCatalog: BotCapabilityCatalog = {
    revision: CATALOG_REVISION,
    providers: [{
      id: "provider:opaque",
      label: "Provider",
      available: true,
      models: [{ id: "model:opaque", label: "Model", available: true }],
    }],
    fileScopes: [{
      id: "scope:home",
      label: "Bot folder",
      available: true,
      kind: "bot_home",
    }],
    shellAvailable: true,
    connections: [],
    skills: [],
    otherCapabilities: [],
    notice: {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: false,
      acceptedAt: "2026-08-23T00:00:00.000Z",
      acceptedDecision: "continue_full",
    },
  };
  return {
    catalog: publicCatalog,
    resources: {
      providers: [],
      fileScopes: [],
      shell: { available: true, shellFingerprint: "a".repeat(64), exactFingerprint: "b".repeat(64) },
      connections: [],
      skills: [],
      otherCapabilities: [],
    },
  };
}

function bot(id: string, overrides: Partial<BotDefinition> = {}): BotDefinition {
  return {
    id,
    revision: `botrev:${id}`,
    name: "Planner",
    description: "Keeps projects moving",
    instructions: "Help plan projects.",
    openingGreeting: "What should we plan?",
    avatar: "spark",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixture(options: {
  bots?: BotDefinition[];
  pending?: BotLifecycleOperation[];
  failIdentityCreate?: boolean;
  migrationSealed?: boolean;
  failJournalOnceAfter?: { method: "checkpoint" | "complete"; stage: BotLifecycleStage };
  failPendingReadAfterEvent?: string;
} = {}) {
  const events: string[] = [];
  const catalogTargets: Array<string | undefined> = [];
  const bots = [...(options.bots ?? [])];
  const chats = new Map<string, Chat>();
  const policies = new Map<string, BotAccessView>();
  const authorityStatuses = new Map<string, "active" | "archived">(
    bots.map((entry) => [entry.id, entry.archivedAt === undefined ? "active" : "archived"]),
  );
  const chatPolicies = new Map<string, BotChatAccessView>();
  const botBindings = new Map<string, unknown>();
  const homes = new Map<string, { botId: string; workspaceId: string; createdAt: number }>();
  const pending = new Map((options.pending ?? []).map((entry) => [entry.operationId, entry]));
  let revision = 0;
  let identityRevision = 0;
  let journalFailureRemaining = options.failJournalOnceAfter ? 1 : 0;
  let migrationSealed = options.migrationSealed === true;

  const botPolicy = (botId: string): BotAccessView => ({
    botId,
    accessMode: "full",
    revision: `revision:policy:${++revision}`,
    policyEpoch: "epoch:1",
    summary: "Full",
  });

  const chatPolicy = (botId: string, chatId: string): BotChatAccessView => ({
    botId,
    chatId,
    mode: "inherit",
    revision: `revision:chat:${++revision}`,
    botPolicyRevision: policies.get(botId)?.revision ?? "revision:policy:missing",
    summary: "Full",
  });

  const lifecycleJournal = {
    async begin(input: BotLifecycleBeginInput) {
      const operation: BotLifecycleOperation = {
        ...input,
        stage: "prepared",
        startedAt: 1,
        updatedAt: 1,
      };
      pending.set(input.operationId, operation);
      events.push(`journal:begin:${input.kind}`);
      return { status: "pending" as const, operation };
    },
    async checkpoint(operationId: string, expected: BotLifecycleStage, next: BotLifecycleStage) {
      const operation = pending.get(operationId);
      assert.ok(operation);
      assert.equal(operation.stage, expected);
      const updated = { ...operation, stage: next, updatedAt: operation.updatedAt + 1 };
      pending.set(operationId, updated);
      events.push(`journal:${next}`);
      if (
        journalFailureRemaining > 0 &&
        options.failJournalOnceAfter?.method === "checkpoint" &&
        options.failJournalOnceAfter.stage === next
      ) {
        journalFailureRemaining -= 1;
        throw new Error("journal checkpoint committed then disconnected");
      }
      return updated;
    },
    async complete(operationId: string, expected: BotLifecycleStage) {
      assert.equal(pending.get(operationId)?.stage, expected);
      pending.delete(operationId);
      events.push("journal:complete");
      if (
        journalFailureRemaining > 0 &&
        options.failJournalOnceAfter?.method === "complete" &&
        options.failJournalOnceAfter.stage === expected
      ) {
        journalFailureRemaining -= 1;
        throw new Error("journal completion committed then disconnected");
      }
    },
    async rollback(operationId: string, expected: BotLifecycleStage) {
      assert.equal(pending.get(operationId)?.stage, expected);
      pending.delete(operationId);
      events.push("journal:rollback");
    },
    async listPending() {
      if (
        options.failPendingReadAfterEvent &&
        events.includes(options.failPendingReadAfterEvent)
      ) {
        throw new Error("journal unavailable during live recovery");
      }
      return [...pending.values()];
    },
  };

  const deps = {
    botStore: {
      async list(includeArchived = false) {
        return bots.filter((entry) => includeArchived || entry.archivedAt === undefined);
      },
      async get(id: string) {
        return bots.find((entry) => entry.id === id) ?? null;
      },
      async createWithId(id: string, input: Omit<BotDefinition, "id" | "createdAt" | "updatedAt">) {
        events.push("identity:create");
        if (options.failIdentityCreate) throw new Error("identity failed");
        const created = bot(id, input);
        bots.push(created);
        return created;
      },
      async update(input: BotDefinition & { expectedRevision?: string }) {
        const index = bots.findIndex(({ id }) => id === input.id);
        const current = bots[index]!;
        if (input.expectedRevision && current.revision !== input.expectedRevision) {
          throw new Error("This Bot changed on another surface. Refresh it and try again.");
        }
        const updated = {
          ...current,
          ...input,
          revision: `botrev:${input.id}:${++identityRevision}`,
          updatedAt: current.updatedAt + 1,
        };
        bots[index] = updated;
        events.push("identity:update");
        return updated;
      },
      async archive(id: string, expectedRevision: string) {
        const entry = bots.find((candidate) => candidate.id === id)!;
        if (entry.revision !== expectedRevision) {
          throw new Error("This Bot changed on another surface. Refresh it and try again.");
        }
        entry.archivedAt = entry.updatedAt + 1;
        entry.updatedAt += 1;
        entry.revision = `botrev:${id}:${++identityRevision}`;
        events.push("identity:archive");
        return { ...entry };
      },
      async restore(id: string, expectedRevision: string) {
        const entry = bots.find((candidate) => candidate.id === id)!;
        if (entry.revision !== expectedRevision) {
          throw new Error("This Bot changed on another surface. Refresh it and try again.");
        }
        delete entry.archivedAt;
        entry.updatedAt += 1;
        entry.revision = `botrev:${id}:${++identityRevision}`;
        events.push("identity:restore");
        return { ...entry };
      },
    },
    chatStore: {
      async list() { return [...chats.values()]; },
      async get(id: string) { return chats.get(id) ?? null; },
      async listByBot(botId: string) {
        return [...chats.values()].filter((entry) => entry.botId === botId);
      },
      async create(input: {
        id?: string;
        title?: string;
        workspaceId?: string;
        botId?: string;
        providerId?: string;
        model?: string;
        initialAssistantMessage?: string;
        assertCurrent?: () => void;
      }) {
        input.assertCurrent?.();
        events.push("chat:create");
        const created: Chat = {
          id: input.id!,
          title: input.title!,
          workspaceId: input.workspaceId,
          botId: input.botId,
          providerId: input.providerId,
          model: input.model,
          createdAt: 1,
          updatedAt: 1,
          messages: input.initialAssistantMessage ? [{
            id: "greeting",
            role: "assistant",
            content: input.initialAssistantMessage,
            createdAt: 1,
          }] : [],
        };
        chats.set(created.id, created);
        return created;
      },
      async copyVisibleHistory(input: {
        sourceChatId: string;
        targetChatId?: string;
        expectedWorkspaceId?: string;
        targetWorkspaceId?: string;
        assertCurrent?: () => void;
      }) {
        input.assertCurrent?.();
        events.push("chat:copy");
        const source = chats.get(input.sourceChatId)!;
        assert.equal(source.workspaceId, input.expectedWorkspaceId);
        const copied = {
          ...source,
          id: input.targetChatId!,
          workspaceId: input.targetWorkspaceId ?? source.workspaceId,
          messages: [...source.messages],
        };
        chats.set(copied.id, copied);
        return copied;
      },
      async remove(id: string, assertCurrent?: (chat: Chat | null) => void | Promise<void>) {
        const current = chats.get(id) ?? null;
        await assertCurrent?.(current);
        events.push("chat:remove");
        chats.delete(id);
      },
    },
    capabilityStore: {
      async initialize() { events.push("policy:initialize"); },
      async noticeStatus() { return catalog().catalog.notice; },
      async acknowledgeNotice() { return catalog().catalog.notice; },
      async auditBotInventory(botIds: readonly string[]) {
        return {
          complete: botIds.every((id) => policies.has(id)),
          missingBotIds: botIds.filter((id) => !policies.has(id)),
          orphanedBotIds: [...policies.keys()].filter((id) => !botIds.includes(id)),
        };
      },
      async migrateLegacyBotsToFull(input: {
        botIds: readonly string[];
        archivedBotIds?: readonly string[];
        chats?: readonly { chatId: string; botId: string }[];
      }) {
        events.push("policy:migrate-full");
        for (const id of input.botIds) {
          const expected = input.archivedBotIds?.includes(id) ? "archived" : "active";
          if (!policies.has(id)) {
            policies.set(id, botPolicy(id));
            authorityStatuses.set(id, expected);
          } else if (authorityStatuses.get(id) !== expected) {
            throw new BotCapabilityUnavailableError("authority mismatch");
          }
        }
        for (const chat of input.chats ?? []) {
          if (!chatPolicies.has(chat.chatId)) {
            chatPolicies.set(chat.chatId, chatPolicy(chat.botId, chat.chatId));
          }
        }
        return input.botIds.map((id) => policies.get(id)!);
      },
      async getBotPolicy(id: string) {
        const value = policies.get(id);
        if (!value) throw new Error("missing policy");
        return value;
      },
      async getBotAuthorityStatus(id: string) {
        const value = authorityStatuses.get(id);
        if (!value || !policies.has(id)) throw new Error("missing policy authority");
        return value;
      },
      async assertBotAuthorityMatchesIdentity(input: { botId: string; archived: boolean }) {
        const value = authorityStatuses.get(input.botId);
        const expected = input.archived ? "archived" : "active";
        if (value !== expected) throw new BotCapabilityUnavailableError("authority mismatch");
      },
      async archiveBotAuthority(id: string) {
        if (!policies.has(id)) throw new Error("missing policy");
        const changed = authorityStatuses.get(id) !== "archived";
        authorityStatuses.set(id, "archived");
        events.push("policy:archive");
        return changed;
      },
      async restoreBotAuthority(id: string) {
        if (!policies.has(id)) throw new Error("missing policy");
        const changed = authorityStatuses.get(id) !== "active";
        authorityStatuses.set(id, "active");
        events.push("policy:restore");
        return changed;
      },
      async getBotBinding(id: string) { return botBindings.get(id); },
      async createBotPolicy(input: { botId: string; binding?: unknown }) {
        events.push(input.binding ? "policy:create:bound" : "policy:create");
        const value = botPolicy(input.botId);
        policies.set(input.botId, value);
        authorityStatuses.set(input.botId, "active");
        return value;
      },
      async updateBotPolicy(input: {
        botId: string;
        expectedRevision: string;
        access: BotAccessUpdate;
        binding?: unknown;
      }) {
        const current = policies.get(input.botId);
        if (!current) throw new BotCapabilityUnavailableError("missing policy");
        if (current.revision !== input.expectedRevision) {
          throw new Error("This Bot access changed on another surface. Refresh it and try again.");
        }
        if (input.access.accessMode === "custom") {
          assert.deepEqual(input.binding, { version: 1 });
          events.push("policy:validate-binding");
        } else {
          assert.equal(input.binding, undefined);
        }
        events.push(input.binding ? "policy:update:bound" : "policy:update");
        const issued = botPolicy(input.botId);
        const value: BotAccessView = input.access.accessMode === "custom"
          ? {
              ...issued,
              accessMode: "custom",
              custom: structuredClone(input.access.custom),
            }
          : issued;
        policies.set(input.botId, value);
        return value;
      },
      async getChatPolicy(id: string) {
        const value = chatPolicies.get(id);
        if (!value) throw new BotCapabilityUnavailableError("missing chat policy");
        return value;
      },
      async createChatPolicy(input: { botId: string; chatId: string }) {
        events.push("chat-policy:create");
        const value = chatPolicy(input.botId, input.chatId);
        chatPolicies.set(input.chatId, value);
        return value;
      },
      async updateChatPolicy(input: { chatId: string }) {
        events.push("chat-policy:update");
        return chatPolicies.get(input.chatId)!;
      },
      async copyChatPolicy(input: { botId: string; targetChatId: string }) {
        events.push("chat-policy:copy");
        const value = chatPolicy(input.botId, input.targetChatId);
        chatPolicies.set(input.targetChatId, value);
        return value;
      },
      async deleteChatPolicy(input: { chatId: string }) {
        events.push("chat-policy:delete");
        return chatPolicies.delete(input.chatId);
      },
      async rollbackUncommittedBotPolicy(input: { botId: string }) {
        events.push("policy:rollback");
        authorityStatuses.delete(input.botId);
        return policies.delete(input.botId);
      },
      invalidateBotAuthority() { events.push("policy:fence"); },
      invalidateChatAuthority() { events.push("chat-policy:fence"); },
    },
    catalog: {
      async snapshot(input?: { retainedBindings?: readonly unknown[]; botId?: string }) {
        catalogTargets.push(input?.botId);
        if (input?.retainedBindings?.length) events.push("catalog:retained-binding");
        return catalog();
      },
      async snapshotForRuntime(input?: { botId?: string }) {
        catalogTargets.push(input?.botId);
        return catalog();
      },
      async bindCustom(input?: { botId?: string }) {
        catalogTargets.push(input?.botId);
        events.push("catalog:bind-custom");
        return { version: 1 };
      },
    },
    managedWorkspace: {
      reserve(botId: string) { return { botId, workspaceId: WORKSPACE_ID, createdAt: 1 }; },
      async provision(botId: string, reservation?: { workspaceId: string; createdAt: number }) {
        events.push("home:provision");
        const value = { botId, workspaceId: reservation?.workspaceId ?? WORKSPACE_ID, createdAt: reservation?.createdAt ?? 1 };
        homes.set(botId, value);
        return { ...value, homePath: `/private/${value.workspaceId}` };
      },
      async reconcileProvision(reservation: { botId: string; workspaceId: string; createdAt: number }) {
        events.push("home:reconcile");
        homes.set(reservation.botId, reservation);
        return { ...reservation, homePath: `/private/${reservation.workspaceId}` };
      },
      async resolve(botId: string) {
        const value = homes.get(botId);
        if (!value) throw new Error("missing home");
        if (value.botId !== botId) throw new Error("corrupt home");
        return { ...value, homePath: `/private/${value.workspaceId}` };
      },
      async listBindings() { return [...homes.values()]; },
      async audit() { events.push("home:audit"); },
      async rollbackProvision(input: { botId: string }) {
        events.push("home:rollback");
        homes.delete(input.botId);
      },
    },
    lifecycleJournal,
    migrationSeal: {
      async isSealed() { return migrationSealed; },
      async seal() {
        migrationSealed = true;
        events.push("migration:seal");
      },
    },
    mutationGate: new BotMutationGate(),
    mintBotId: () => "bot:new",
    mintChatId: (() => {
      let sequence = 0;
      return () => `chat:${++sequence}`;
    })(),
    mintOperationId: (() => {
      let sequence = 0;
      return () => `operation:${++sequence}`;
    })(),
  } as unknown as BotApplicationDependencies;

  return {
    service: createBotApplicationService(deps),
    deps,
    events,
    bots,
    chats,
    policies,
    authorityStatuses,
    chatPolicies,
    botBindings,
    homes,
    pending,
    catalogTargets,
  };
}

test("initialization migrates legacy Bots to explicit Full and gives each exactly one hidden home", async () => {
  const app = fixture({ bots: [bot("bot:legacy")] });
  await app.service.initialize();
  assert.equal(app.policies.get("bot:legacy")?.accessMode, "full");
  assert.equal(app.homes.size, 1);
  assert.equal(app.homes.get("bot:legacy")?.workspaceId, WORKSPACE_ID);
  assert.deepEqual(app.events, [
    "policy:initialize",
    "policy:migrate-full",
    "journal:begin:create_bot",
    "home:reconcile",
    "journal:workspace_provisioned",
    "journal:policy_committed",
    "journal:identity_committed",
    "journal:complete",
    "home:audit",
    "migration:seal",
  ]);
});

test("identity updates require a live Bot, exact revision, managed home, and policy", async () => {
  const active = bot("bot:update");
  const archived = bot("bot:archived-update", { archivedAt: 2 });
  const app = fixture({ bots: [active, archived] });
  await app.service.initialize();
  app.events.length = 0;

  const input: BotUpdateInput = {
    id: active.id,
    expectedRevision: active.revision,
    name: "Updated planner",
    description: "Keeps the current plan moving",
    instructions: "Keep the plan current.",
    openingGreeting: "What changed?",
    avatar: "orbit",
  };
  const updated = await app.service.updateBot(input);
  assert.equal(updated.name, input.name);
  assert.equal(updated.openingGreeting, input.openingGreeting);
  assert.notEqual(updated.revision, input.expectedRevision);
  assert.deepEqual(app.events, ["identity:update"]);

  await assert.rejects(
    app.service.updateBot({ ...input, name: "Stale writer" }),
    /changed on another surface/u,
  );
  assert.equal(app.bots.find(({ id }) => id === active.id)?.name, input.name);

  await assert.rejects(
    app.service.updateBot({ ...input, id: archived.id, expectedRevision: archived.revision }),
    /no longer available/u,
  );
  await assert.rejects(
    app.service.updateBot({ ...input, id: "bot:missing" }),
    /no longer available/u,
  );

  app.homes.delete(active.id);
  await assert.rejects(
    app.service.updateBot({ ...input, expectedRevision: updated.revision }),
    /missing home/u,
  );
  app.homes.set(active.id, {
    botId: "bot:wrong-owner",
    workspaceId: WORKSPACE_ID,
    createdAt: 1,
  });
  await assert.rejects(
    app.service.updateBot({ ...input, expectedRevision: updated.revision }),
    /corrupt home/u,
  );
  app.homes.set(active.id, { botId: active.id, workspaceId: WORKSPACE_ID, createdAt: 1 });
  app.policies.delete(active.id);
  await assert.rejects(
    app.service.updateBot({ ...input, expectedRevision: updated.revision }),
    /missing policy/u,
  );
});

test("identity updates serialize under the Bot mutation gate", async () => {
  const owner = bot("bot:serialized-update");
  const app = fixture({ bots: [owner] });
  await app.service.initialize();
  app.events.length = 0;

  const originalUpdate = app.deps.botStore.update.bind(app.deps.botStore);
  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  app.deps.botStore.update = async (input) => {
    app.events.push(`identity:update-start:${input.name}`);
    if (input.name === "First") await held;
    return originalUpdate(input);
  };
  const base: BotUpdateInput = {
    id: owner.id,
    expectedRevision: owner.revision,
    name: "First",
    instructions: owner.instructions,
    avatar: owner.avatar,
  };
  const first = app.service.updateBot(base);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = app.service.updateBot({ ...base, name: "Second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(app.events, ["identity:update-start:First"]);

  releaseFirst();
  const firstResult = await first;
  await assert.rejects(second, /changed on another surface/u);
  assert.equal(firstResult.name, "First");
  assert.deepEqual(app.events, [
    "identity:update-start:First",
    "identity:update",
    "identity:update-start:Second",
  ]);
});

test("Bot access updates use a scoped catalog and publish only a validated private binding", async () => {
  const owner = bot("bot:access-update");
  const app = fixture({ bots: [owner] });
  await app.service.initialize();
  app.events.length = 0;
  app.catalogTargets.length = 0;

  const originalRevision = app.policies.get(owner.id)!.revision;
  const custom: BotAccessUpdate = {
    accessMode: "custom",
    catalogRevision: CATALOG_REVISION,
    custom: {
      providerId: "provider:opaque",
      modelId: "model:opaque",
      fileScopeIds: ["scope:home"],
      shellEnabled: false,
      connectionIds: [],
      skillIds: [],
      otherCapabilityIds: [],
    },
  };
  const customResult = await app.service.updateBotAccess({
    audienceId: "device:a",
    botId: owner.id,
    expectedRevision: originalRevision,
    access: custom,
  });

  assert.equal(customResult.accessMode, "custom");
  assert.deepEqual(customResult.custom, custom.custom);
  assert.deepEqual(app.catalogTargets, [owner.id, owner.id]);
  assert.ok(
    app.events.indexOf("catalog:bind-custom") <
      app.events.indexOf("policy:validate-binding") &&
      app.events.indexOf("policy:validate-binding") <
        app.events.indexOf("policy:update:bound"),
  );

  app.events.length = 0;
  app.catalogTargets.length = 0;
  const fullResult = await app.service.updateBotAccess({
    audienceId: "device:a",
    botId: owner.id,
    expectedRevision: customResult.revision,
    access: {
      accessMode: "full",
      catalogRevision: CATALOG_REVISION,
      confirmedForeground: true,
    },
  });

  assert.equal(fullResult.accessMode, "full");
  assert.deepEqual(app.catalogTargets, [owner.id]);
  assert.deepEqual(app.events, ["policy:update"]);

  await assert.rejects(
    app.service.updateBotAccess({
      audienceId: "device:a",
      botId: owner.id,
      expectedRevision: customResult.revision,
      access: {
        accessMode: "full",
        catalogRevision: CATALOG_REVISION,
        confirmedForeground: true,
      },
    }),
    /changed on another surface/u,
  );
  assert.equal(app.policies.get(owner.id)?.revision, fullResult.revision);
  assert.equal(app.policies.get(owner.id)?.accessMode, "full");
});

test("sealed policy or managed-home loss blocks instead of reminting Full authority", async () => {
  const app = fixture({ bots: [bot("bot:legacy")] });
  await app.service.initialize();

  app.policies.clear();
  await assert.rejects(
    createBotApplicationService(app.deps).initialize(),
    /access storage is missing/u,
  );

  app.policies.set("bot:legacy", {
    botId: "bot:legacy",
    accessMode: "full",
    revision: "revision:policy:restored",
    policyEpoch: "epoch:1",
    summary: "Full",
  });
  app.homes.clear();
  await assert.rejects(
    createBotApplicationService(app.deps).initialize(),
    /managed-home storage is missing/u,
  );
});

test("archived Bot conversations remain readable", async () => {
  const archived = bot("bot:archived");
  archived.archivedAt = 2;
  const app = fixture({ bots: [archived] });
  await app.service.initialize();
  await assert.doesNotReject(app.service.listChats(archived.id));
});

test("archive recovery rejects a newer identity when the old intent never committed", async () => {
  const current = bot("bot:changed", { revision: "botrev:newer", updatedAt: 2 });
  const app = fixture({
    bots: [current],
    migrationSealed: true,
    pending: [{
      operationId: "operation:archive-stale",
      kind: "archive_bot",
      botId: current.id,
      subject: { expectedRevision: "botrev:older" },
      stage: "authority_archived",
      startedAt: 1,
      updatedAt: 1,
    }],
  });
  app.policies.set(current.id, {
    botId: current.id,
    accessMode: "full",
    revision: "revision:policy:archive-recovery",
    policyEpoch: "epoch:2",
    summary: "Full",
  });
  app.authorityStatuses.set(current.id, "archived");

  await assert.rejects(app.service.initialize(), /changed on another surface/u);
  assert.equal(app.bots[0]?.archivedAt, undefined);
  assert.equal(app.pending.size, 1);
});

test("archive fences authority both before and after the identity commit", async () => {
  const current = bot("bot:archive-fence");
  const app = fixture({ bots: [current] });
  await app.service.initialize();
  app.events.length = 0;

  await app.service.archiveBot({ botId: current.id, expectedRevision: current.revision });

  const identityIndex = app.events.indexOf("identity:archive");
  const fenceIndexes = app.events.flatMap((event, index) =>
    event === "policy:fence" ? [index] : [],
  );
  assert.equal(fenceIndexes.length, 2);
  assert.ok(fenceIndexes[0]! < identityIndex);
  assert.ok(fenceIndexes[1]! > identityIndex);
});

test("post-visible archive and restore journal failures recover live without replaying identity", async () => {
  const archiveOwner = bot("bot:archive-live");
  const archiveApp = fixture({
    bots: [archiveOwner],
    failJournalOnceAfter: { method: "complete", stage: "identity_archived" },
  });
  await archiveApp.service.initialize();
  const archived = await archiveApp.service.archiveBot({
    botId: archiveOwner.id,
    expectedRevision: archiveOwner.revision,
  });
  assert.ok(archived.archivedAt);
  assert.equal(archiveApp.events.filter((event) => event === "identity:archive").length, 1);
  assert.equal(archiveApp.pending.size, 0);

  const restoreOwner = bot("bot:restore-live", { archivedAt: 2, updatedAt: 2 });
  const restoreApp = fixture({
    bots: [restoreOwner],
    failJournalOnceAfter: { method: "checkpoint", stage: "identity_restored" },
  });
  await restoreApp.service.initialize();
  const restored = await restoreApp.service.restoreBot({
    botId: restoreOwner.id,
    expectedRevision: restoreOwner.revision,
  });
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restoreApp.events.filter((event) => event === "identity:restore").length, 1);
  assert.equal(restoreApp.pending.size, 0);
});

test("restore recovery rejects a newer archived identity when the old intent never committed", async () => {
  const current = bot("bot:changed", {
    revision: "botrev:newer-archived",
    updatedAt: 3,
    archivedAt: 2,
  });
  const app = fixture({
    bots: [current],
    migrationSealed: true,
    pending: [{
      operationId: "operation:restore-stale",
      kind: "restore_bot",
      botId: current.id,
      subject: { expectedRevision: "botrev:older-archived" },
      stage: "identity_restored",
      startedAt: 1,
      updatedAt: 1,
    }],
  });
  app.policies.set(current.id, {
    botId: current.id,
    accessMode: "full",
    revision: "revision:policy:restore-recovery",
    policyEpoch: "epoch:1",
    summary: "Full",
  });
  app.homes.set(current.id, { botId: current.id, workspaceId: WORKSPACE_ID, createdAt: 1 });

  await assert.rejects(app.service.initialize(), /changed on another surface/u);
  assert.equal(app.bots[0]?.archivedAt, 2);
  assert.equal(app.pending.size, 1);
});

test("archive and restore recovery are idempotent at every protected checkpoint", async (t) => {
  const policyFor = (botId: string): BotAccessView => ({
    botId,
    accessMode: "full",
    revision: `revision:policy:${botId}`,
    policyEpoch: "epoch:1",
    summary: "Full",
  });

  for (const stage of ["prepared", "authority_archived", "identity_archived"] as const) {
    await t.test(`archive ${stage}`, async () => {
      const current = bot(`bot:archive:${stage}`);
      if (stage === "identity_archived") {
        current.archivedAt = 2;
        current.updatedAt = 2;
        current.revision = `botrev:${current.id}:archived`;
      }
      const app = fixture({
        bots: [current],
        migrationSealed: true,
        pending: [{
          operationId: `operation:archive:${stage}`,
          kind: "archive_bot",
          botId: current.id,
          subject: { expectedRevision: bot(current.id).revision },
          stage,
          startedAt: 1,
          updatedAt: 2,
        }],
      });
      app.policies.set(current.id, policyFor(current.id));
      app.authorityStatuses.set(
        current.id,
        stage === "prepared" ? "active" : "archived",
      );
      app.homes.set(current.id, { botId: current.id, workspaceId: WORKSPACE_ID, createdAt: 1 });

      await app.service.initialize();
      assert.ok(app.bots[0]?.archivedAt);
      assert.equal(app.authorityStatuses.get(current.id), "archived");
      assert.equal(app.pending.size, 0);
    });
  }

  for (const stage of ["prepared", "identity_restored", "authority_restored"] as const) {
    await t.test(`restore ${stage}`, async () => {
      const current = bot(`bot:restore:${stage}`);
      if (stage === "prepared") {
        current.archivedAt = 2;
        current.updatedAt = 2;
      }
      const app = fixture({
        bots: [current],
        migrationSealed: true,
        pending: [{
          operationId: `operation:restore:${stage}`,
          kind: "restore_bot",
          botId: current.id,
          subject: { expectedRevision: current.revision },
          stage,
          startedAt: 1,
          updatedAt: 2,
        }],
      });
      app.policies.set(current.id, policyFor(current.id));
      app.authorityStatuses.set(
        current.id,
        stage === "authority_restored" ? "active" : "archived",
      );
      app.homes.set(current.id, { botId: current.id, workspaceId: WORKSPACE_ID, createdAt: 1 });

      await app.service.initialize();
      assert.equal(app.bots[0]?.archivedAt, undefined);
      assert.equal(app.authorityStatuses.get(current.id), "active");
      assert.equal(app.pending.size, 0);
    });
  }
});

test("startup rejects offline Bot identity rollback in either authority direction", async (t) => {
  for (const mismatch of [
    { identityArchived: false, protectedStatus: "archived" as const },
    { identityArchived: true, protectedStatus: "active" as const },
  ]) {
    await t.test(`${mismatch.identityArchived ? "archived" : "active"} identity`, async () => {
      const current = bot("bot:offline-rollback");
      if (mismatch.identityArchived) current.archivedAt = 2;
      const app = fixture({ bots: [current], migrationSealed: true });
      app.policies.set(current.id, {
        botId: current.id,
        accessMode: "full",
        revision: "revision:policy:rollback",
        policyEpoch: "epoch:2",
        summary: "Full",
      });
      app.authorityStatuses.set(current.id, mismatch.protectedStatus);
      app.homes.set(current.id, { botId: current.id, workspaceId: WORKSPACE_ID, createdAt: 1 });

      await assert.rejects(app.service.initialize(), /authority mismatch/u);
    });
  }
});

test("Bot creation commits home then policy then visible identity", async () => {
  const app = fixture();
  await app.service.initialize();
  app.events.length = 0;
  const created = await app.service.createBot({
    audienceId: "device:a",
    bot: {
      name: "Planner",
      instructions: "Plan carefully.",
      openingGreeting: "What should we plan?",
      avatar: "spark",
    },
  });
  assert.equal(created.id, "bot:new");
  assert.ok(
    app.events.indexOf("home:provision") < app.events.indexOf("policy:create") &&
    app.events.indexOf("policy:create") < app.events.indexOf("identity:create"),
  );
  assert.equal(app.pending.size, 0);
});

test("a post-identity journal failure is recovered live without duplicating the Bot", async () => {
  const app = fixture({
    failJournalOnceAfter: { method: "complete", stage: "identity_committed" },
  });
  await app.service.initialize();

  const created = await app.service.createBot({
    audienceId: "device:a",
    bot: { name: "One Bot", instructions: "Stay singular.", avatar: "spark" },
  });

  assert.equal(created.id, "bot:new");
  assert.equal(app.bots.filter(({ id }) => id === created.id).length, 1);
  assert.equal(app.homes.size, 1);
  assert.equal(app.pending.size, 0);
});

test("post-visible chat journal failures recover the exact chat in the live service", async () => {
  const owner = bot("bot:chat-live-recovery");
  const app = fixture({
    bots: [owner],
    failJournalOnceAfter: { method: "checkpoint", stage: "chat_committed" },
  });
  await app.service.initialize();

  const chat = await app.service.createChat({ audienceId: "device:a", botId: owner.id });

  assert.equal(chat.botId, owner.id);
  assert.equal(app.chats.size, 1);
  assert.equal(app.chatPolicies.size, 1);
  assert.equal(app.pending.size, 0);
});

test("an unrecoverable visible commit fences later Bot mutations until restart", async () => {
  const owner = bot("bot:poisoned-live-recovery");
  const app = fixture({
    bots: [owner],
    failJournalOnceAfter: { method: "checkpoint", stage: "chat_committed" },
    failPendingReadAfterEvent: "chat:create",
  });
  await app.service.initialize();

  const first = app.service.createChat({ audienceId: "device:a", botId: owner.id });
  const preadmittedWaiter = app.service.createChat({ audienceId: "device:a", botId: owner.id });
  await assert.rejects(
    first,
    /committed but its recovery record could not be finalized/u,
  );
  await assert.rejects(
    preadmittedWaiter,
    /changes are paused/u,
  );
  assert.equal(app.chats.size, 1);
  assert.equal(app.pending.size, 1);
});

test("a post-visible copy journal failure recovers the exact copy without duplication", async () => {
  const owner = bot("bot:copy-live-recovery");
  const app = fixture({
    bots: [owner],
    failJournalOnceAfter: { method: "complete", stage: "chat_committed" },
  });
  await app.service.initialize();
  const source: Chat = {
    id: "chat:source-live",
    title: "Source",
    workspaceId: WORKSPACE_ID,
    botId: owner.id,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
  app.chats.set(source.id, source);
  app.chatPolicies.set(source.id, {
    botId: owner.id,
    chatId: source.id,
    mode: "inherit",
    revision: "revision:chat:source-live",
    botPolicyRevision: app.policies.get(owner.id)!.revision,
    summary: "Full",
  });

  const copy = await app.service.copyChat({ botId: owner.id, sourceChatId: source.id });

  assert.notEqual(copy.id, source.id);
  assert.equal(app.chats.size, 2);
  assert.equal([...app.chats.values()].filter(({ id }) => id === copy.id).length, 1);
  assert.equal(app.pending.size, 0);
});

test("new and copied Bot chats publish policy before chat in the managed home", async () => {
  const app = fixture({ bots: [bot("bot:one")] });
  await app.service.initialize();
  app.events.length = 0;
  const chat = await app.service.createChat({ audienceId: "device:a", botId: "bot:one" });
  assert.equal(chat.workspaceId, WORKSPACE_ID);
  assert.equal(chat.messages[0]?.content, "What should we plan?");
  assert.ok(app.events.indexOf("chat-policy:create") < app.events.indexOf("chat:create"));

  chat.workspaceId = "legacy-workspace";
  app.events.length = 0;
  const copy = await app.service.copyChat({ botId: "bot:one", sourceChatId: chat.id });
  assert.equal(copy.workspaceId, WORKSPACE_ID);
  assert.ok(app.events.indexOf("chat-policy:copy") < app.events.indexOf("chat:copy"));
});

test("initialization gives legacy Bot chats inherited policy without moving history", async () => {
  const app = fixture({ bots: [bot("bot:one")] });
  const legacy: Chat = {
    id: "chat:legacy",
    title: "Legacy",
    workspaceId: "old-visible-workspace",
    botId: "bot:one",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: "message:1", role: "user", content: "Keep me", createdAt: 1 }],
  };
  app.chats.set(legacy.id, legacy);
  await app.service.initialize();
  assert.equal(app.chatPolicies.get(legacy.id)?.mode, "inherit");
  assert.equal(app.chats.get(legacy.id)?.workspaceId, "old-visible-workspace");
  assert.equal(app.chats.get(legacy.id)?.messages[0]?.content, "Keep me");

  const copy = await app.service.copyChat({ botId: "bot:one", sourceChatId: legacy.id });
  assert.equal(copy.workspaceId, WORKSPACE_ID);
  assert.equal(copy.messages[0]?.content, "Keep me");

  const policyCount = app.chatPolicies.size;
  await createBotApplicationService(app.deps).initialize();
  assert.equal(app.chatPolicies.size, policyCount);
});

test("a stale chat owner prevents visible create and compensates its pending policy", async () => {
  const app = fixture({ bots: [bot("bot:one")] });
  await app.service.initialize();
  app.events.length = 0;
  await assert.rejects(
    app.service.createChat({
      audienceId: "device:a",
      botId: "bot:one",
      assertCurrent: () => { throw new Error("owner stale"); },
    }),
    /owner stale/u,
  );
  assert.equal(app.chats.size, 0);
  assert.equal(app.chatPolicies.size, 0);
  assert.equal(app.pending.size, 0);
  assert.deepEqual(app.events.slice(-2), ["chat-policy:delete", "journal:rollback"]);
});

test("failed identity creation rolls back only uncommitted policy and empty home", async () => {
  const app = fixture({ failIdentityCreate: true });
  await app.service.initialize();
  app.events.length = 0;
  await assert.rejects(
    app.service.createBot({
      audienceId: "device:a",
      bot: { name: "Planner", instructions: "Plan.", avatar: "spark" },
    }),
    /identity failed/u,
  );
  assert.equal(app.bots.length, 0);
  assert.equal(app.policies.size, 0);
  assert.equal(app.homes.size, 0);
  assert.equal(app.pending.size, 0);
  assert.deepEqual(app.events.slice(-3), ["policy:rollback", "home:rollback", "journal:rollback"]);
});

test("startup reconciliation finishes a visible identity without creating a duplicate home", async () => {
  const operation: BotLifecycleOperation = {
    operationId: "operation:pending",
    kind: "create_bot",
    botId: "bot:one",
    subject: { workspaceId: WORKSPACE_ID, workspaceCreatedAt: 1 },
    stage: "policy_committed",
    startedAt: 1,
    updatedAt: 2,
  };
  const app = fixture({ bots: [bot("bot:one")], pending: [operation] });
  app.policies.set("bot:one", {
    botId: "bot:one",
    accessMode: "full",
    revision: "revision:policy:existing",
    policyEpoch: "epoch:1",
    summary: "Full",
  });
  await app.service.initialize();
  assert.equal(app.bots.length, 1);
  assert.equal(app.homes.size, 1);
  assert.equal(app.pending.size, 0);
  assert.equal(app.events.filter((event) => event === "home:reconcile").length, 1);
  assert.equal(app.events.includes("identity:create"), false);
});

test("startup reconciliation is idempotent at every Bot-create checkpoint", async (t) => {
  const incomplete: Array<{
    name: string;
    stage: BotLifecycleStage;
    home: boolean;
    policy: boolean;
  }> = [
    { name: "prepared before home", stage: "prepared", home: false, policy: false },
    { name: "prepared after home crash window", stage: "prepared", home: true, policy: false },
    { name: "workspace checkpoint", stage: "workspace_provisioned", home: true, policy: false },
    { name: "policy checkpoint", stage: "policy_committed", home: true, policy: true },
  ];
  for (const scenario of incomplete) {
    await t.test(scenario.name, async () => {
      const operation: BotLifecycleOperation = {
        operationId: "operation:pending",
        kind: "create_bot",
        botId: "bot:pending",
        subject: { workspaceId: WORKSPACE_ID, workspaceCreatedAt: 1 },
        stage: scenario.stage,
        startedAt: 1,
        updatedAt: 2,
      };
      const app = fixture({ pending: [operation] });
      if (scenario.home) {
        app.homes.set("bot:pending", {
          botId: "bot:pending",
          workspaceId: WORKSPACE_ID,
          createdAt: 1,
        });
      }
      if (scenario.policy) {
        app.policies.set("bot:pending", {
          botId: "bot:pending",
          accessMode: "full",
          revision: "revision:policy:pending",
          policyEpoch: "epoch:1",
          summary: "Full",
        });
      }
      await app.service.initialize();
      assert.equal(app.pending.size, 0);
      assert.equal(app.homes.size, 0);
      assert.equal(app.policies.size, 0);
      assert.equal(app.bots.length, 0);
    });
  }

  await t.test("identity commit", async () => {
    const operation: BotLifecycleOperation = {
      operationId: "operation:pending",
      kind: "create_bot",
      botId: "bot:committed",
      subject: { workspaceId: WORKSPACE_ID, workspaceCreatedAt: 1 },
      stage: "identity_committed",
      startedAt: 1,
      updatedAt: 2,
    };
    const app = fixture({ bots: [bot("bot:committed")], pending: [operation] });
    app.homes.set("bot:committed", {
      botId: "bot:committed",
      workspaceId: WORKSPACE_ID,
      createdAt: 1,
    });
    app.policies.set("bot:committed", {
      botId: "bot:committed",
      accessMode: "full",
      revision: "revision:policy:committed",
      policyEpoch: "epoch:1",
      summary: "Full",
    });
    await app.service.initialize();
    assert.equal(app.pending.size, 0);
    assert.equal(app.homes.size, 1);
    assert.equal(app.policies.size, 1);
    assert.equal(app.bots.length, 1);
  });
});

test("Custom access is privately bound before it is committed", async () => {
  const app = fixture();
  await app.service.initialize();
  app.events.length = 0;
  await app.service.createBot({
    audienceId: "device:a",
    bot: { name: "Planner", instructions: "Plan.", avatar: "spark" },
    access: {
      accessMode: "custom",
      catalogRevision: CATALOG_REVISION,
      custom: {
        providerId: "provider:opaque",
        modelId: "model:opaque",
        fileScopeIds: ["scope:home"],
        shellEnabled: false,
        connectionIds: [],
        skillIds: [],
        otherCapabilityIds: [],
      },
    },
  });
  assert.ok(
    app.events.indexOf("catalog:bind-custom") < app.events.indexOf("policy:create:bound"),
  );
});

test("capability catalog retains a private binding but returns only the safe public projection", async () => {
  const app = fixture({ bots: [bot("bot:one")] });
  await app.service.initialize();
  app.botBindings.set("bot:one", { privatePath: "/must/not/escape" });
  app.events.length = 0;
  const result = await app.service.capabilityCatalog("device:a", "bot:one");
  assert.equal(result.revision, CATALOG_REVISION);
  assert.equal("resources" in result, false);
  assert.doesNotMatch(JSON.stringify(result), /must\/not\/escape/u);
  assert.deepEqual(app.events, ["catalog:retained-binding"]);
  assert.equal(app.catalogTargets[app.catalogTargets.length - 1], "bot:one");
});

test("Bot and chat access catalogs are scoped to their owning Bot while create is targetless", async () => {
  const owner = bot("bot:scope");
  const app = fixture({ bots: [owner] });
  await app.service.initialize();
  app.catalogTargets.length = 0;
  const chat = await app.service.createChat({ audienceId: "device:a", botId: owner.id });
  await app.service.updateChatAccess({
    audienceId: "device:a",
    botId: owner.id,
    chatId: chat.id,
    expectedRevision: app.chatPolicies.get(chat.id)!.revision,
    access: {
      mode: "inherit",
      catalogRevision: CATALOG_REVISION,
      expectedBotPolicyRevision: app.policies.get(owner.id)!.revision,
    },
  });
  await app.service.createBot({
    audienceId: "device:a",
    bot: { name: "New", instructions: "Help.", avatar: "spark" },
  });
  assert.deepEqual(app.catalogTargets, [owner.id, owner.id, undefined]);
});

test("archived Bot chats remain readable but reject a new delete mutation", async () => {
  const app = fixture({ bots: [bot("bot:one", { archivedAt: 2 })] });
  await app.service.initialize();
  const chat: Chat = {
    id: "chat:old",
    title: "Old",
    workspaceId: "legacy-workspace",
    botId: "bot:one",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
  app.chats.set(chat.id, chat);
  app.chatPolicies.set(chat.id, {
    botId: "bot:one",
    chatId: chat.id,
    mode: "inherit",
    revision: "revision:chat:old",
    botPolicyRevision: app.policies.get("bot:one")!.revision,
    summary: "Full",
  });
  app.events.length = 0;
  assert.deepEqual(await app.service.listChats("bot:one"), [chat]);
  await assert.rejects(
    app.service.deleteChat({ botId: "bot:one", chatId: chat.id }),
    /no longer available/u,
  );
  assert.equal(app.chats.has(chat.id), true);
  assert.equal(app.chatPolicies.has(chat.id), true);
  assert.deepEqual(app.events, []);
});

test("an enabled Telegram backing chat cannot be deleted or resurrected on restart", async () => {
  const owner = bot("bot:telegram");
  const app = fixture({ bots: [owner] });
  await app.service.initialize();
  const backing = await app.service.createChat({
    audienceId: "telegram:work",
    botId: owner.id,
    chatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
  });
  app.deps.assertChatDeletionAllowed = async (botId, chatId) => {
    if (botId === owner.id && chatId === backing.id) {
      throw new Error(TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE);
    }
  };
  app.events.length = 0;

  await assert.rejects(
    app.service.deleteChat({ botId: owner.id, chatId: backing.id }),
    (error: unknown) => {
      assert.equal((error as Error).message, TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE);
      return true;
    },
  );
  assert.equal(app.chats.has(backing.id), true);
  assert.equal(app.chatPolicies.has(backing.id), true);
  assert.equal(app.pending.size, 0);
  assert.equal(app.events.includes("chat:remove"), false);

  const restarted = createBotApplicationService(app.deps);
  await restarted.initialize();
  assert.equal((await restarted.listChats(owner.id)).filter(({ id }) => id === backing.id).length, 1);
});

test("a stale delete owner leaves chat and policy visible and rolls back its journal", async () => {
  const app = fixture({ bots: [bot("bot:one")] });
  await app.service.initialize();
  const chat: Chat = {
    id: "chat:stale",
    title: "Keep",
    workspaceId: WORKSPACE_ID,
    botId: "bot:one",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
  app.chats.set(chat.id, chat);
  app.chatPolicies.set(chat.id, {
    botId: "bot:one",
    chatId: chat.id,
    mode: "inherit",
    revision: "revision:chat:stale",
    botPolicyRevision: app.policies.get("bot:one")!.revision,
    summary: "Full",
  });
  let assertions = 0;
  app.events.length = 0;
  await assert.rejects(
    app.service.deleteChat({
      botId: "bot:one",
      chatId: chat.id,
      assertCurrent: () => {
        assertions += 1;
        if (assertions === 2) throw new Error("owner stale");
      },
    }),
    /owner stale/u,
  );
  assert.equal(app.chats.has(chat.id), true);
  assert.equal(app.chatPolicies.has(chat.id), true);
  assert.equal(app.pending.size, 0);
  assert.equal(app.events.includes("chat:remove"), false);
  assert.equal(app.events[app.events.length - 1], "journal:rollback");
});

test("a durable deletion tombstone keeps Bot cleanup pending until restart rolls it forward", async () => {
  const owner = bot("bot:delete-roll-forward");
  const app = fixture({ bots: [owner] });
  await app.service.initialize();
  const chat = await app.service.createChat({ audienceId: "device:a", botId: owner.id });
  app.events.length = 0;
  app.deps.deleteChatWithEffects = async (
    chatId,
    assertCurrent,
    onDeletionRollForward,
  ) => {
    await assertCurrent(app.chats.get(chatId) ?? null);
    app.events.push("subagent:tombstone");
    onDeletionRollForward?.();
    app.events.push("effects:failed");
    throw new Error("private effect cleanup failed");
  };

  await assert.rejects(
    app.service.deleteChat({ botId: owner.id, chatId: chat.id }),
    /must finish on restart/u,
  );
  assert.equal(app.chats.has(chat.id), true);
  assert.equal(app.chatPolicies.has(chat.id), true);
  assert.equal(app.pending.size, 1);
  assert.equal([...app.pending.values()][0]?.stage, "authority_fenced");
  assert.equal(app.events.includes("journal:rollback"), false);
  await assert.rejects(
    app.service.createChat({ audienceId: "device:a", botId: owner.id }),
    /changes are paused/u,
  );

  // Main startup first rolls the durable generic deletion tombstone forward.
  const tombstones = new Set([chat.id]);
  await reconcilePendingChatDeletions({
    pendingChatDeletions: async () => [...tombstones],
    completeChatDeletion: async (chatId) => { tombstones.delete(chatId); },
  }, async (chatId) => { app.chats.delete(chatId); });
  assert.equal(tombstones.size, 0);
  app.deps.deleteChatWithEffects = async () => {
    throw new Error("startup Bot replay must not repeat generic private cleanup");
  };
  const restarted = createBotApplicationService(app.deps);
  await restarted.initialize();

  assert.equal(app.pending.size, 0);
  assert.equal(app.chats.has(chat.id), false);
  assert.equal(app.chatPolicies.has(chat.id), false);
  assert.ok(
    app.events.indexOf("chat-policy:delete") < app.events.lastIndexOf("journal:complete"),
  );
});

test("delete-chat recovery is idempotent at every durable checkpoint", async (t) => {
  const stages: BotLifecycleStage[] = [
    "prepared",
    "authority_fenced",
    "chat_deleted",
    "policy_removed",
  ];
  for (const stage of stages) {
    await t.test(stage, async () => {
      const operation: BotLifecycleOperation = {
        operationId: "operation:delete",
        kind: "delete_chat",
        botId: "bot:one",
        subject: { chatId: "chat:one" },
        stage,
        startedAt: 1,
        updatedAt: 2,
      };
      const app = fixture({ bots: [bot("bot:one")], pending: [operation] });
      if (stage === "prepared" || stage === "authority_fenced") {
        app.chats.set("chat:one", {
          id: "chat:one",
          title: "Delete",
          workspaceId: "legacy-workspace",
          botId: "bot:one",
          createdAt: 1,
          updatedAt: 1,
          messages: [],
        });
      }
      if (stage !== "policy_removed") {
        app.chatPolicies.set("chat:one", {
          botId: "bot:one",
          chatId: "chat:one",
          mode: "inherit",
          revision: "revision:chat:delete",
          botPolicyRevision: "revision:policy:old",
          summary: "Full",
        });
      }
      await app.service.initialize();
      assert.equal(app.pending.size, 0);
      assert.equal(app.chats.has("chat:one"), false);
      assert.equal(app.chatPolicies.has("chat:one"), false);
    });
  }
});
