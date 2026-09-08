import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ChatTurnLease } from "./chat-turn-admission.js";
import {
  ContextLifecycleService,
  type ContextLifecycleServiceDeps,
} from "./context-lifecycle-service.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import {
  PiCompactionSessionStore,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import type { Chat } from "./types.js";

const baseChat: Chat = {
  id: "chat-1",
  title: "Chat",
  providerId: "saved-provider",
  model: "saved-model",
  messages: [],
  createdAt: 1,
  updatedAt: 2,
};

function lease(events: string[]): ChatTurnLease {
  return {
    chatId: baseChat.id,
    ownerId: "owner",
    turnId: "turn",
    isActive: () => true,
    reserveAppendPayload: () => undefined,
    reserveSkillPreparation: () => undefined,
    prepareSkillInvocation: () => undefined,
    settleAsyncWork: () => events.push("settle"),
    onReleased: () => undefined,
    release: () => events.push("release"),
  };
}

function deps(overrides: Partial<ContextLifecycleServiceDeps> = {}) {
  const events: string[] = [];
  const value: ContextLifecycleServiceDeps = {
    getChat: async () => baseChat,
    listChatsByBot: async () => [],
    isBotArchived: async () => false,
    beginChatTurn: () => lease(events),
    openSession: async () => {
      throw new Error("stop after authority checks");
    },
    resolveRuntime: async () =>
      ({
        provider: { id: "saved-provider" },
        model: { id: "saved-model" },
      }) as Awaited<ReturnType<ContextLifecycleServiceDeps["resolveRuntime"]>>,
    resolveThinkingLevel: async () => "off",
    ...overrides,
  };
  return { value, events };
}

test("manual compaction closes busy before reading or resolving chat state", async () => {
  let read = false;
  const { value } = deps({
    beginChatTurn: () => null,
    getChat: async () => {
      read = true;
      return baseChat;
    },
  });
  const result = await new ContextLifecycleService(value).compactChat(
    baseChat.id,
    { kind: "desktop", ownerId: "renderer:1" },
    "operator",
  );
  assert.deepEqual(result, { compacted: false, reason: "busy" });
  assert.equal(read, false);
});

test("startup rollback gate disables manual compaction before admission or journal access", async () => {
  let admitted = false;
  const { value } = deps({
    compactionEnabled: () => false,
    beginChatTurn: () => {
      admitted = true;
      return null;
    },
  });
  assert.deepEqual(
    await new ContextLifecycleService(value).compactChat(
      baseChat.id,
      { kind: "desktop", ownerId: "renderer:1" },
      "operator",
    ),
    { compacted: false, reason: "already_compact" },
  );
  assert.equal(admitted, false);
});

test("manual compaction resolves the exact provider and model saved on the chat", async () => {
  const resolved: string[] = [];
  const { value, events } = deps({
    resolveRuntime: async (providerId, model) => {
      resolved.push(providerId, model);
      return { provider: { id: providerId }, model: { id: model } } as Awaited<
        ReturnType<ContextLifecycleServiceDeps["resolveRuntime"]>
      >;
    },
  });
  const result = await new ContextLifecycleService(value).compactChat(
    baseChat.id,
    { kind: "telegram", profile: "work", ownerId: "telegram:work" },
    "operator",
  );
  assert.deepEqual(resolved, ["saved-provider", "saved-model"]);
  assert.deepEqual(result, { compacted: false, reason: "compaction_failed" });
  assert.deepEqual(events, ["settle", "release"]);
});

test("legacy Bot duplicates are read-only and never resolve provider state", async () => {
  let resolved = false;
  const duplicate = { ...baseChat, botId: "bot-1" };
  const { value } = deps({
    getChat: async () => duplicate,
    listChatsByBot: async () => [
      duplicate,
      { ...duplicate, id: "canonical", updatedAt: duplicate.updatedAt + 1 },
    ],
    resolveRuntime: async () => {
      resolved = true;
      throw new Error("must not resolve");
    },
  });
  const result = await new ContextLifecycleService(value).compactChat(
    duplicate.id,
    { kind: "desktop", ownerId: "renderer:1" },
    "operator",
  );
  assert.deepEqual(result, { compacted: false, reason: "not_canonical" });
  assert.equal(resolved, false);
});

test("manual compaction rejects a provider alias that changes the saved binding", async () => {
  const { value } = deps({
    resolveRuntime: async () =>
      ({
        provider: { id: "aliased-provider" },
        model: { id: "saved-model" },
      }) as Awaited<ReturnType<ContextLifecycleServiceDeps["resolveRuntime"]>>,
  });
  assert.deepEqual(
    await new ContextLifecycleService(value).compactChat(
      baseChat.id,
      { kind: "desktop", ownerId: "renderer:1" },
      "operator",
    ),
    { compacted: false, reason: "context_metadata_invalid" },
  );
});

test("archived Bots return a closed reason without leaking provider failures", async () => {
  const archived = { ...baseChat, botId: "bot-1" };
  const { value } = deps({
    getChat: async () => archived,
    isBotArchived: async () => true,
  });
  assert.deepEqual(
    await new ContextLifecycleService(value).compactChat(
      archived.id,
      { kind: "desktop", ownerId: "renderer:1" },
      "operator",
    ),
    { compacted: false, reason: "archived" },
  );
});

test("admission expiry aborts provider resolution and returns cancelled", async () => {
  const events: string[] = [];
  let expire: () => void = () => undefined;
  const expiringLease = lease(events);
  expiringLease.onReleased = (cleanup) => {
    expire = cleanup;
  };
  const { value } = deps({
    beginChatTurn: () => expiringLease,
    resolveRuntime: async (_providerId, _model, signal) => {
      expire();
      assert.equal(signal?.aborted, true);
      throw new DOMException("expired", "AbortError");
    },
  });
  assert.deepEqual(
    await new ContextLifecycleService(value).compactChat(
      baseChat.id,
      { kind: "desktop", ownerId: "renderer:1" },
      "operator",
    ),
    { compacted: false, reason: "cancelled" },
  );
});

test("the owning surface can cancel an admitted manual compaction", async () => {
  let resolutionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolutionStarted = resolve;
  });
  const { value } = deps({
    resolveRuntime: async (_providerId, _model, signal) => {
      resolutionStarted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
  });
  const service = new ContextLifecycleService(value);
  const operation = service.compactChat(
    baseChat.id,
    { kind: "desktop", ownerId: "renderer:1" },
    "operator",
  );
  await started;
  assert.equal(service.cancelChat(baseChat.id, "renderer:other"), false);
  assert.equal(service.cancelChat(baseChat.id, "renderer:1"), true);
  assert.deepEqual(await operation, { compacted: false, reason: "cancelled" });
  assert.equal(service.cancelChat(baseChat.id, "renderer:1"), false);
});

test("explicit VCC uses offline metadata without invoking provider auth or thinking resolution", async () => {
  let localRead = false;
  const { value } = deps({
    getCompactionEngine: async () => "llm",
    resolveRuntime: async () => {
      throw new Error("must not resolve authenticated runtime");
    },
    resolveThinkingLevel: async () => {
      throw new Error("must not resolve provider thinking");
    },
    resolveLocalModel: async () => {
      localRead = true;
      return { provider: "saved-provider", id: "saved-model" } as Awaited<
        ReturnType<NonNullable<ContextLifecycleServiceDeps["resolveLocalModel"]>>
      >;
    },
  });
  const result = await new ContextLifecycleService(value).compactChat(
    baseChat.id,
    { kind: "desktop", ownerId: "renderer:1" },
    "operator",
    "vcc",
  );
  assert.equal(localRead, true);
  // The fixture intentionally fails on session open, after the offline authority check.
  assert.deepEqual(result, { compacted: false, reason: "compaction_failed" });
});

function validSummary(label: string): string {
  return `## Goal\n${label}\n\n## Constraints & Preferences\n- none\n\n## Progress\n### Done\n- [x] checkpointed\n\n### In Progress\n- [ ] continue\n\n### Blocked\n- none\n\n## Key Decisions\n- preserve visible context\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- ${label}`;
}

function compactionRuntime(providerId: string, modelId: string) {
  const faux = fauxProvider({
    api: "openai-completions",
    provider: providerId,
    models: [{ id: modelId, contextWindow: 8_000, maxTokens: 1_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const runtime: ResolvedModelRuntime = {
    provider: {
      id: providerId,
      kind: "openai",
      label: "Compaction test",
      baseUrl: "https://compaction.invalid/v1",
      models: [modelId],
      needsKey: false,
    },
    model,
    models,
    apiKey: undefined,
    headers: undefined,
    streams: {
      streamSimple: () => {
        throw new Error("The registered faux provider must own compaction.");
      },
    },
  };
  return { faux, model, runtime };
}

test("manual compaction excludes durable skill instructions while Skills is disabled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-context-skill-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerId = "context-skill-gate";
  const modelId = "context-skill-gate-model";
  const { faux, model, runtime } = compactionRuntime(providerId, modelId);
  let providerObserved = false;
  const providerPayloads: string[] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      providerPayloads.push(JSON.stringify(context));
      providerObserved = true;
      return fauxAssistantMessage(validSummary("clean manual checkpoint"));
    }),
  );
  const chat: Chat = {
    ...baseChat,
    providerId,
    model: modelId,
    messages: Array.from({ length: 12 }, (_, index) => [
      {
        id: `visible-user-${index}`,
        role: "user" as const,
        content: `${index === 0 ? "Visible operator request" : `Visible follow-up ${index}`} ${"x".repeat(8_000)}`,
        createdAt: index * 2 + 10,
      },
      {
        id: `visible-assistant-${index}`,
        role: "assistant" as const,
        content: `Visible answer ${index}`,
        createdAt: index * 2 + 11,
      },
    ]).flat(),
  };
  const store = new PiCompactionSessionStore({ root: async () => root });
  const session = await store.openChat(chat.id);
  await syncChatMessagesToPiSession(
    session,
    chat.messages,
    model,
    false,
    new Map([["visible-user-0", "HIDDEN_SKILL_INSTRUCTIONS"]]),
  );
  const { value } = deps({
    getChat: async () => chat,
    skillsEnabled: async () => false,
    openSession: async () => session,
    resolveRuntime: async () => runtime,
  });

  const result = await new ContextLifecycleService(value).compactChat(
    chat.id,
    { kind: "desktop", ownerId: "renderer:1" },
    "operator",
  );

  assert.equal(result.compacted, true, JSON.stringify(result));
  assert.equal(providerObserved, true);
  assert.doesNotMatch(JSON.stringify(providerPayloads), /HIDDEN_SKILL_INSTRUCTIONS/u);
  assert.match(JSON.stringify(providerPayloads), /Visible operator request/u);
  assert.doesNotMatch(JSON.stringify(await session.buildContext()), /HIDDEN_SKILL_INSTRUCTIONS/u);
});

test("disabling Skills cancels an operator compaction already at the provider", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-context-skill-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerId = "context-skill-cancel";
  const modelId = "context-skill-cancel-model";
  const { faux, runtime } = compactionRuntime(providerId, modelId);
  let providerStarted!: () => void;
  const atProvider = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  faux.setResponses([
    async (_context, options) => {
      providerStarted();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage(validSummary("must not commit"));
    },
  ]);
  const chat: Chat = {
    ...baseChat,
    providerId,
    model: modelId,
    messages: [
      {
        id: "cancel-user",
        role: "user",
        content: `Compact ${"x".repeat(90_000)}`,
        createdAt: 10,
      },
      {
        id: "cancel-assistant",
        role: "assistant",
        content: "Current answer",
        createdAt: 20,
      },
      {
        id: "cancel-user-two",
        role: "user",
        content: `Continue ${"y".repeat(10_000)}`,
        createdAt: 30,
      },
      {
        id: "cancel-assistant-two",
        role: "assistant",
        content: "Latest answer",
        createdAt: 40,
      },
    ],
  };
  const store = new PiCompactionSessionStore({ root: async () => root });
  const session = await store.openChat(chat.id);
  const { value } = deps({
    getChat: async () => chat,
    skillsEnabled: async () => true,
    openSession: async () => session,
    resolveRuntime: async () => runtime,
  });
  const service = new ContextLifecycleService(value);
  const operation = service.compactChat(
    chat.id,
    { kind: "desktop", ownerId: "renderer:1" },
    "operator",
  );
  await atProvider;
  service.cancelForSkillsDisabled();

  assert.deepEqual(await operation, { compacted: false, reason: "cancelled" });
  assert.equal(
    (await session.getBranch()).some((entry) => entry.type === "compaction"),
    false,
  );
});
