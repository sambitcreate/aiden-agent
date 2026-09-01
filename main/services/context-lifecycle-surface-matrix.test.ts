import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ChatTurnLease } from "./chat-turn-admission.js";
import {
  compactDesktopChat,
  createTelegramLifecycleAdapter,
} from "./context-lifecycle-adapters.js";
import {
  beginSurfaceGeneration,
  remoteGenerationSurface,
  scheduledGenerationSurface,
  startSurfaceGeneration,
} from "./conversation-surface-generation.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import {
  ContextLifecycleService,
  type ContextLifecycleAudience,
  type ContextLifecycleServiceDeps,
} from "./context-lifecycle-service.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { createPiSessionPort } from "./pi-session-port.js";
import { telegramChatId } from "./telegram/telegram-turn.js";
import type { Chat, ChatStartParams } from "./types.js";

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("conversation surface matrix converges every authorized turn on the managed lifecycle", async () => {
  const [desktop, telegram, remote, scheduled, child] = await Promise.all([
    source("./llm-client.ts"),
    source("./telegram/telegram-turn.ts"),
    source("./aiden-remote-chats.ts"),
    source("./schedule-execution.ts"),
    source("./subagents/child-agent-runtime.ts"),
  ]);

  assert.match(desktop, /new PiAgentRuntimeHarness\(/u);
  assert.match(desktop, /createGenerationContextTransform/u);
  assert.match(telegram, /beginChatTurn\(chatId, streamId, background\.owner\.documentId\)/u);
  assert.match(telegram, /deps\.llmClient\.start\(/u);
  assert.match(remote, /startSurfaceGeneration\(/u);
  assert.match(remote, /authoritative\.botId \? \{ botAudienceId: deviceId \}/u);
  assert.match(scheduled, /beginSurfaceGeneration\(llmClient\.beginChatTurn\.bind\(llmClient\), surface\)/u);
  assert.match(scheduled, /startSurfaceGeneration\(/u);
  assert.match(child, /agent\.runManaged\(/u);
  assert.doesNotMatch(telegram, /new PiAgentRuntimeHarness|new PiCompactionCoordinator/u);
  assert.doesNotMatch(remote, /new PiAgentRuntimeHarness|new PiCompactionCoordinator/u);
  assert.doesNotMatch(scheduled, /new PiAgentRuntimeHarness|new PiCompactionCoordinator/u);
});

function lifecycleLease(chatId: string, events: string[]): ChatTurnLease {
  return {
    chatId,
    ownerId: "matrix-owner",
    turnId: "matrix-turn",
    isActive: () => true,
    reserveAppendPayload: () => undefined,
    reserveSkillPreparation: () => undefined,
    prepareSkillInvocation: () => undefined,
    settleAsyncWork: () => events.push("settled"),
    onReleased: () => undefined,
    release: () => events.push("released"),
  };
}

function summary(label: string): string {
  return `## Goal\n${label}\n\n## Constraints & Preferences\n- none\n\n## Progress\n### Done\n- [x] checkpointed\n\n### In Progress\n- [ ] continue\n\n### Blocked\n- none\n\n## Key Decisions\n- keep the canonical chat\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- ${label}`;
}

const lifecycleCases: Array<{
  name: string;
  audience: ContextLifecycleAudience;
  botId?: string;
}> = [
  { name: "ordinary workspace", audience: { kind: "desktop", ownerId: "renderer:1" } },
  {
    name: "canonical Bot on Mac",
    audience: { kind: "desktop", ownerId: "renderer:2" },
    botId: "bot-mac",
  },
  {
    name: "Telegram-bound Bot",
    audience: { kind: "telegram", profile: "bot-profile", ownerId: "telegram:bot-profile" },
    botId: "bot-telegram",
  },
  {
    name: "ordinary Telegram",
    audience: { kind: "telegram", profile: "work", ownerId: "telegram:work" },
  },
  {
    name: "remote/mobile Bot",
    audience: { kind: "remote", ownerId: "remote-device" },
    botId: "bot-mobile",
  },
];

test("authorized persistent surfaces share admission, saved-model authority, and native checkpoints", async () => {
  for (const [index, surface] of lifecycleCases.entries()) {
    const providerId = `matrix-provider-${index}`;
    const modelId = `matrix-model-${index}`;
    const chatId = surface.name === "ordinary Telegram"
      ? telegramChatId(42, "workspace-a", "work")
      : `matrix-chat-${index}`;
    const faux = fauxProvider({
      api: "openai-completions",
      provider: providerId,
      models: [{ id: modelId, contextWindow: 8_000, maxTokens: 1_000 }],
    });
    faux.setResponses([fauxAssistantMessage(summary(surface.name))]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel() as Model<Api>;
    const runtime: ResolvedModelRuntime = {
      provider: {
        id: providerId,
        kind: "openai",
        label: surface.name,
        baseUrl: "https://matrix.invalid/v1",
        models: [modelId],
        needsKey: false,
      },
      model,
      models,
      apiKey: undefined,
      headers: undefined,
      streams: {
        streamSimple: () => {
          throw new Error("registered faux model must own summary dispatch");
        },
      },
    };
    const chat: Chat = {
      id: chatId,
      title: surface.name,
      ...(surface.botId ? { botId: surface.botId } : {}),
      providerId,
      model: modelId,
      messages: [
        { id: `${chatId}-u1`, role: "user", content: `old ${"x".repeat(90_000)}`, createdAt: 1 },
        { id: `${chatId}-a1`, role: "assistant", content: "old answer", createdAt: 2 },
        { id: `${chatId}-u2`, role: "user", content: `recent ${"y".repeat(10_000)}`, createdAt: 3 },
        { id: `${chatId}-a2`, role: "assistant", content: "recent answer", createdAt: 4 },
      ],
      createdAt: 1,
      updatedAt: 4,
    };
    const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: chatId }));
    const calls: Array<{ chatId: string; ownerId: string; providerId?: string; model?: string }> = [];
    const leaseEvents: string[] = [];
    const deps: ContextLifecycleServiceDeps = {
      getChat: async (requestedChatId) => requestedChatId === chatId ? chat : null,
      listChatsByBot: async () => [chat],
      isBotArchived: async () => false,
      beginChatTurn: (requestedChatId, _turnId, ownerId) => {
        calls.push({ chatId: requestedChatId, ownerId });
        return lifecycleLease(requestedChatId, leaseEvents);
      },
      openSession: async (requestedChatId) => {
        assert.equal(requestedChatId, chatId);
        return session;
      },
      resolveRuntime: async (savedProviderId, savedModel) => {
        calls.push({ chatId, ownerId: surface.audience.ownerId, providerId: savedProviderId, model: savedModel });
        return runtime;
      },
      resolveThinkingLevel: async () => "off",
    };

    const result = await new ContextLifecycleService(deps).compactChat(
      chatId,
      surface.audience,
      "operator",
    );

    assert.equal(result.compacted, true, `${surface.name} should compact`);
    assert.deepEqual(calls[0], { chatId, ownerId: surface.audience.ownerId });
    assert.deepEqual(calls[1], {
      chatId,
      ownerId: surface.audience.ownerId,
      providerId,
      model: modelId,
    });
    assert.deepEqual(leaseEvents, ["settled", "released"]);
    assert.equal((await session.getBranch()).filter((entry) => entry.type === "compaction").length, 1);
  }
});

test("production Mac and bound-Telegram adapters share one canonical Bot journal", async () => {
  const providerId = "shared-bot-provider";
  const modelId = "shared-bot-model";
  const chatId = "shared-canonical-bot-chat";
  const faux = fauxProvider({
    api: "openai-completions",
    provider: providerId,
    models: [{ id: modelId, contextWindow: 8_000, maxTokens: 1_000 }],
  });
  faux.setResponses([
    fauxAssistantMessage(summary("Mac checkpoint")),
    fauxAssistantMessage(summary("Telegram checkpoint")),
    fauxAssistantMessage(summary("Telegram checkpoint continuation")),
    fauxAssistantMessage(summary("Telegram checkpoint final")),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const runtime = {
    provider: {
      id: providerId,
      kind: "openai" as const,
      label: "Shared Bot provider",
      baseUrl: "https://shared.invalid/v1",
      models: [modelId],
      needsKey: false,
    },
    model,
    models,
    apiKey: undefined,
    headers: undefined,
    streams: {
      streamSimple: () => {
        throw new Error("registered faux model must own summary dispatch");
      },
    },
  } satisfies ResolvedModelRuntime;
  const chat: Chat = {
    id: chatId,
    botId: "shared-bot",
    title: "Shared Bot",
    providerId,
    model: modelId,
    messages: [
      { id: "shared-u1", role: "user", content: `old ${"x".repeat(90_000)}`, createdAt: 1 },
      { id: "shared-a1", role: "assistant", content: "old answer", createdAt: 2 },
      { id: "shared-u2", role: "user", content: `recent ${"y".repeat(10_000)}`, createdAt: 3 },
      { id: "shared-a2", role: "assistant", content: "recent answer", createdAt: 4 },
    ],
    createdAt: 1,
    updatedAt: 4,
  };
  const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: chatId }));
  const admittedOwners: string[] = [];
  const resolved: string[] = [];
  const service = new ContextLifecycleService({
    getChat: async () => chat,
    listChatsByBot: async () => [chat],
    isBotArchived: async () => false,
    beginChatTurn: (requestedChatId, _turnId, ownerId) => {
      assert.equal(requestedChatId, chatId);
      admittedOwners.push(ownerId);
      return lifecycleLease(requestedChatId, []);
    },
    openSession: async (requestedChatId) => {
      assert.equal(requestedChatId, chatId);
      return session;
    },
    resolveRuntime: async (savedProviderId, savedModel) => {
      resolved.push(savedProviderId, savedModel);
      return runtime;
    },
    resolveThinkingLevel: async () => "off",
  });
  const telegram = createTelegramLifecycleAdapter(service, "bot-profile");

  const macResult = await compactDesktopChat(service, chatId, "renderer:bot-window");
  chat.messages.push(
    { id: "shared-u3", role: "user", content: `later ${"z".repeat(90_000)}`, createdAt: 5 },
    { id: "shared-a3", role: "assistant", content: "later answer", createdAt: 6 },
  );
  chat.updatedAt = 6;
  const telegramResult = await telegram.compactChat(chatId);

  assert.equal(macResult.compacted, true);
  assert.equal(telegramResult.compacted, true, JSON.stringify(telegramResult));
  assert.deepEqual(admittedOwners, ["renderer:bot-window", "telegram:bot-profile"]);
  assert.deepEqual(resolved, [providerId, modelId, providerId, modelId]);
  assert.equal((await session.getBranch()).filter((entry) => entry.type === "compaction").length, 2);
});

test("production scheduled and remote adapters enter the admitted generation boundary", async () => {
  const records: Array<{ kind: "begin" | "start"; values: unknown[] }> = [];
  const owner: ChatGenerationOwner = {
    id: 0,
    documentId: "surface-owner",
    isDestroyed: () => false,
    send: () => undefined,
    onInvalidated: () => () => undefined,
  };
  const lease = { release: () => undefined };
  const begin = (chatId: string, turnId: string, ownerId: string) => {
    records.push({ kind: "begin", values: [chatId, turnId, ownerId] });
    return lease;
  };
  const start = async (
    streamId: string,
    params: ChatStartParams,
    generationOwner: ChatGenerationOwner,
    options: Record<string, unknown>,
  ) => {
    records.push({ kind: "start", values: [streamId, params, generationOwner.documentId, options] });
    return true;
  };
  const scheduled = scheduledGenerationSurface({
    chatId: "scheduled-chat",
    streamId: "scheduled-stream",
    ownerId: owner.documentId,
    workspaceId: "workspace-a",
    providerId: "scheduled-provider",
    model: "scheduled-model",
    mode: "assistant-automation",
    prompt: "scheduled prompt",
    permission: "read-only",
    excludeToolNames: new Set(["schedule_task"]),
    allowMcpTools: false,
    mcpServerIds: [],
  });
  const remote = remoteGenerationSurface({
    chatId: "canonical-remote-bot-chat",
    turnId: "remote-turn",
    streamId: "remote-stream",
    ownerId: owner.documentId,
    workspaceId: "bot-workspace",
    providerId: "bot-provider",
    model: "bot-model",
    botAudienceId: "paired-device",
    onTurnAccepted: () => undefined,
  });

  for (const surface of [scheduled, remote]) {
    assert.equal(beginSurfaceGeneration(begin, surface), lease);
    assert.equal(await startSurfaceGeneration(start, surface, owner), true);
  }

  assert.deepEqual(records[0], {
    kind: "begin",
    values: ["scheduled-chat", "scheduled-stream", owner.documentId],
  });
  assert.deepEqual(records[1]?.values.slice(0, 3), [
    "scheduled-stream",
    scheduled.params,
    owner.documentId,
  ]);
  assert.deepEqual(records[2], {
    kind: "begin",
    values: ["canonical-remote-bot-chat", "remote-turn", owner.documentId],
  });
  assert.deepEqual(records[3]?.values.slice(0, 3), [
    "remote-stream",
    remote.params,
    owner.documentId,
  ]);
  assert.equal(scheduled.options.usageSource, "scheduled");
  assert.equal(scheduled.options.allowSubagents, false);
  assert.equal(remote.options.usageSource, "chat");
  assert.equal(remote.options.botAudienceId, "paired-device");
});

test("ordinary Telegram journals remain profile/workspace scoped and distinct from Bot backing chats", () => {
  assert.equal(telegramChatId(42), "telegram-42");
  assert.equal(telegramChatId(42, "workspace-a"), "telegram-42-workspace-a");
  assert.equal(telegramChatId(42, "workspace-a", "work"), "telegram-work-42-workspace-a");
  assert.notEqual(telegramChatId(42, "workspace-a", "work"), "canonical-bot-chat");
});

test("mobile clients render lifecycle state but cannot author checkpoint or memory payloads", async () => {
  const [protocol, iosContract, iosChat, iosClient, androidChat, androidClient] = await Promise.all([
    readFile(new URL("../../protocol/aiden-remote/v1/openapi.json", import.meta.url), "utf8"),
    readFile(
      new URL("../../ios/AidenOnTheGo/Networking/AidenRemoteContract.swift", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../ios/AidenOnTheGo/Models/AidenChat.swift", import.meta.url), "utf8"),
    readFile(
      new URL("../../ios/AidenOnTheGo/Networking/AidenRemoteClient.swift", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../android/app/src/main/java/sbtbiswas/AidenOnTheGo/models/AidenChat.kt",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const forbidden = /firstKeptEntryId|retainedTail|appendCompaction|compactionSummary/u;

  for (const clientSource of [protocol, iosContract, iosChat, iosClient, androidChat, androidClient]) {
    assert.doesNotMatch(clientSource, forbidden);
  }
  assert.match(iosChat, /compact_context/u);
  assert.match(androidChat, /compact_context/u);
});
