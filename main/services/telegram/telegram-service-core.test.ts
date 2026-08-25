// Tests for the Telegram service core (telegram-service-core.ts).
//
// The service core is a DI factory that orchestrates: inbound long-polling,
// owner pairing, queue dispatch, and outbound reply delivery. These tests
// exercise the lifecycle and message-handling contract entirely through mock
// dependencies — no network, no real LLM client, no real chat store.
//
// The poll loop (runPollLoop) is an detached async loop. To keep tests
// deterministic, the mock getUpdates serves configured "batches" of updates
// in order; once batches are exhausted it either (a) self-terminates the loop
// via stop() or (b) parks on a never-resolving promise so the loop idles
// without spinning. The mock sleep resolves instantly and just counts calls.

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelegramServiceCore } from "./telegram-service-core.js";
import { createTelegramBotBindingStore } from "./telegram-bot-binding-store.js";
import type {
  TelegramBotApi,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./telegram-bot-api.js";
import type { TelegramConfig } from "./telegram-config.js";
import type { TelegramTurnDeps } from "./telegram-turn.js";
import type { AppSettings } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOT: TelegramUser = {
  id: 1,
  is_bot: true,
  first_name: "Aiden",
  username: "aiden_bot",
};

/** A human (non-bot) Telegram user. */
function person(id: number, username?: string): TelegramUser {
  return { id, is_bot: false, first_name: "Owner", username };
}

function makeMessage(
  messageId: number,
  from: TelegramUser,
  text: string,
  chatId = 100,
): TelegramMessage {
  return {
    message_id: messageId,
    from,
    chat: { id: chatId, type: "private" },
    date: 0,
    text,
  };
}

function makeUpdate(updateId: number, message: TelegramMessage): TelegramUpdate {
  return { update_id: updateId, message };
}

// ---------------------------------------------------------------------------
// Mock TelegramBotApi
// ---------------------------------------------------------------------------

interface MockApiOptions {
  me?: TelegramUser;
  batches?: TelegramUpdate[][];
  autoStop?: boolean;
  /** Invoked to break the poll loop (wired to service.stop()). */
  stop: () => void;
  delayAfterFirstBatch?: boolean;
}

interface SentMessage {
  chatId: number;
  threadId?: number;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
}

function createMockApi(opts: MockApiOptions) {
  const pending = [...(opts.batches ?? [])];
  const sentMessages: SentMessage[] = [];
  const richMessages: Array<{ chatId: number; threadId?: number; markdown: string }> = [];
  const voiceMessages: Array<{ chatId: number; threadId?: number; bytes: Uint8Array }> = [];
  const calls: string[] = [];
  let getMeCalls = 0;
  let getUpdatesCalls = 0;
  let sendChatActionCalls = 0;
  let answerCallbackQueryCalls = 0;

  const api = {
    sentMessages,
    richMessages,
    voiceMessages,
    calls,
    getMeCalls: () => getMeCalls,
    getUpdatesCalls: () => getUpdatesCalls,
    sendChatActionCalls: () => sendChatActionCalls,
    answerCallbackQueryCalls: () => answerCallbackQueryCalls,
    async getMe(): Promise<TelegramUser> {
      getMeCalls += 1;
      calls.push("getMe");
      return opts.me ?? BOT;
    },
    async getUpdates(
      _offset?: number,
      _timeoutSeconds?: number,
      _signal?: AbortSignal,
    ): Promise<TelegramUpdate[]> {
      getUpdatesCalls += 1;
      calls.push("getUpdates");
      if (opts.delayAfterFirstBatch && getUpdatesCalls > 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (pending.length > 0) return pending.shift() as TelegramUpdate[];
      if (opts.autoStop ?? true) {
        opts.stop();
        return [];
      }
      // Park the loop without busy-spinning; stopping the service releases it.
      if (!_signal) return [];
      await once(_signal, "abort");
      return [];
    },
    async sendMessage(p: {
      chatId: number;
      threadId?: number;
      text: string;
      parseMode?: "HTML" | "MarkdownV2";
      disablePreview?: boolean;
    }): Promise<TelegramMessage> {
      sentMessages.push({
        chatId: p.chatId,
        threadId: p.threadId,
        text: p.text,
        parseMode: p.parseMode,
        disablePreview: p.disablePreview,
      });
      return {
        message_id: sentMessages.length,
        chat: { id: p.chatId, type: "private" },
        date: 0,
        text: p.text,
      };
    },
    async sendRichMessage(p: {
      chatId: number;
      threadId?: number;
      markdown: string;
    }): Promise<TelegramMessage> {
      richMessages.push(p);
      return {
        message_id: richMessages.length,
        chat: { id: p.chatId, type: "private" },
        date: 0,
        text: p.markdown,
      };
    },
    async sendVoice(p: {
      chatId: number;
      threadId?: number;
      bytes: Uint8Array;
    }): Promise<TelegramMessage> {
      voiceMessages.push(p);
      return { message_id: voiceMessages.length, chat: { id: p.chatId, type: "private" }, date: 0 };
    },
    async sendChatAction(_chatId: number, _action: string): Promise<void> {
      sendChatActionCalls += 1;
    },
    async downloadFile(fileId: string) {
      return {
        file: { file_id: fileId, file_unique_id: `unique-${fileId}` },
        bytes: new Uint8Array([1, 2, 3]),
      };
    },
    async editMessageText(): Promise<void> {},
    async answerCallbackQuery(): Promise<void> {
      answerCallbackQueryCalls += 1;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Mock TelegramConfig
// ---------------------------------------------------------------------------

interface MockConfigState {
  enabled: boolean;
  hasToken: boolean;
  allowedUserId?: number;
  telegramWorkspaceId?: string;
  telegramRendering?: "rich" | "html";
  telegramVoiceMode?: "hidden" | "mirror" | "always";
  telegramThreadedMode?: boolean;
}

function createMockConfig(state: MockConfigState) {
  const setSettingsCalls: Array<Partial<AppSettings>> = [];
  let clearOffsetCalls = 0;
  let persistOffsetCalls = 0;

  const baseSettings = (): AppSettings => ({
    lastProviderId: "openai",
    lastModel: "gpt-4",
    telegramEnabled: state.enabled,
    telegramAllowedUserId: state.allowedUserId,
    telegramWorkspaceId: state.telegramWorkspaceId,
    // Preserve the legacy delivery assertions in this compatibility fixture.
    // Native rich delivery has dedicated coverage below.
    telegramRendering: state.telegramRendering ?? "html",
    telegramVoiceMode: state.telegramVoiceMode,
    telegramThreadedMode: state.telegramThreadedMode,
  });

  const config = {
    state,
    setSettingsCalls,
    clearOffsetCalls: () => clearOffsetCalls,
    persistOffsetCalls: () => persistOffsetCalls,
    async snapshot() {
      return {
        enabled: state.enabled,
        hasToken: state.hasToken,
        allowedUserId: state.allowedUserId,
        lastUpdateId: undefined,
      };
    },
    async getOffset(): Promise<number | undefined> {
      return undefined;
    },
    async persistOffset(updateId: number): Promise<void> {
      persistOffsetCalls += 1;
      void updateId;
    },
    async clearOffset(): Promise<void> {
      clearOffsetCalls += 1;
    },
    async getSettings(): Promise<AppSettings> {
      return baseSettings();
    },
    async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
      setSettingsCalls.push(patch);
      if ("telegramAllowedUserId" in patch) {
        state.allowedUserId = patch.telegramAllowedUserId;
      }
      if (patch.telegramEnabled !== undefined) {
        state.enabled = patch.telegramEnabled;
      }
      if ("telegramWorkspaceId" in patch) {
        state.telegramWorkspaceId = patch.telegramWorkspaceId;
      }
      if (patch.telegramRendering !== undefined) state.telegramRendering = patch.telegramRendering;
      if (patch.telegramVoiceMode !== undefined) state.telegramVoiceMode = patch.telegramVoiceMode;
      return { ...baseSettings(), ...patch };
    },
    async hasToken(): Promise<boolean> {
      return state.hasToken;
    },
  };
  return config;
}

// ---------------------------------------------------------------------------
// Mock TelegramTurnDeps
// ---------------------------------------------------------------------------

interface MockTurnOptions {
  reply?: string;
  /** Never resolve llmClient.start so the turn stays "active". */
  pending?: boolean;
  /** beginChatTurn returns null, simulating an already-busy chat. */
  busy?: boolean;
  /** Resolve the turn as a chat:error with this message. */
  failMessage?: string;
  workspace?: { kind: "assistant" } | { kind: "project"; workspaceId: string } | { kind: "stale" };
  workspaceResolver?: (
    workspaceId?: string,
  ) => { kind: "assistant" } | { kind: "project"; workspaceId: string } | { kind: "stale" };
  existingChats?: Array<{
    id: string;
    workspaceId: string;
    botId: string;
    providerId?: string;
    model?: string;
  }>;
}

/** Minimal owner surface the turn shim drives back through send(). */
interface TurnOwner {
  send(channel: string, payload: unknown): void;
}

function createMockTurn(opts: MockTurnOptions = {}) {
  let startCalls = 0;
  let appendCalls = 0;
  let createCalls = 0;
  let releasedLeases = 0;
  let settledLeases = 0;

  const pendingStart = new EventEmitter();
  let pendingOwner: TurnOwner | undefined;
  const createdChats: Array<{ id: string; workspaceId?: string; botId?: string }> = [];
  const startedParams: Array<{
    chatId: string;
    workspaceId?: string;
    mode?: string;
    content?: string;
  }> = [];
  const llmClient = {
    beginChatTurn() {
      if (opts.busy) return null;
      return {
        release: () => {
          releasedLeases += 1;
        },
        settleAsyncWork: () => {
          settledLeases += 1;
        },
      };
    },
    async start(
      streamId: string,
      _params: {
        chatId: string;
        workspaceId?: string;
        mode?: string;
        messages?: Array<{ content: string }>;
      },
      owner: TurnOwner,
      _options: unknown,
    ): Promise<boolean> {
      startedParams.push({ ..._params, content: _params.messages?.[0]?.content });
      startCalls += 1;
      if (opts.pending) {
        pendingOwner = owner;
        await once(pendingStart, "complete");
        return true;
      }
      if (opts.failMessage) {
        owner.send("chat:error", { streamId, message: opts.failMessage });
        return true;
      }
      owner.send("chat:done", { streamId, content: opts.reply ?? "Mock reply" });
      return true;
    },
    isChatBusy() {
      return false;
    },
    async waitForChatIdle(): Promise<boolean> {
      return true;
    },
  };

  const chatStore = {
    async create(input: { id: string; title: string; workspaceId?: string; botId?: string }) {
      createCalls += 1;
      createdChats.push({
        id: input.id,
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.botId !== undefined ? { botId: input.botId } : {}),
      });
      return {
        id: input.id,
        title: input.title,
        updatedAt: 0,
        workspaceId: input.workspaceId,
      };
    },
    async get(id: string) {
      const chat = opts.existingChats?.find((candidate) => candidate.id === id);
      return chat
        ? {
            providerId: "openai",
            model: "gpt-4",
            ...chat,
            title: "Telegram bot",
            updatedAt: 0,
          }
        : null;
    },
    async appendMessage(id: string, _message: unknown) {
      appendCalls += 1;
      return { id, title: "Telegram", updatedAt: 0 };
    },
  };

  const turn = {
    llmClient,
    chatStore,
    async resolveProvider() {
      return {
        providerId: "openai",
        model: "gpt-4",
        provider: {
          id: "openai",
          kind: "openai" as const,
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          needsKey: true,
        },
      };
    },
    async resolveWorkspace(workspaceId?: string) {
      return (
        opts.workspaceResolver?.(workspaceId) ?? opts.workspace ?? { kind: "assistant" as const }
      );
    },
    async preflightBotTurnAuthority() {},
    broadcastMetadata(_chat: unknown) {},
  };

  return {
    turn,
    startCalls: () => startCalls,
    appendCalls: () => appendCalls,
    createCalls: () => createCalls,
    createdChats: () => createdChats,
    startedParams: () => startedParams,
    releasedLeases: () => releasedLeases,
    completePendingTurn: () => {
      pendingOwner?.send("chat:done", { streamId: "pending-turn", content: "Mock reply" });
      pendingStart.emit("complete");
    },
    settledLeases: () => settledLeases,
  };
}

// ---------------------------------------------------------------------------
// Mock sleep + log capture
// ---------------------------------------------------------------------------

function createMockSleep() {
  let calls = 0;
  const lastArgs: number[] = [];
  const sleep = async (ms: number, _signal?: AbortSignal): Promise<void> => {
    calls += 1;
    lastArgs.push(ms);
    // Yield to the event loop so concurrent loops (typing indicator) don't starve macrotasks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { sleep, calls: () => calls, lastArgs: () => lastArgs };
}

function createLogs() {
  const info: string[] = [];
  const warn: string[] = [];
  const errors: Array<{ message: string; cause?: unknown }> = [];
  return {
    info,
    warn,
    errors,
    infoFn: (m: string) => {
      info.push(m);
    },
    warnFn: (m: string) => {
      warn.push(m);
    },
    errorFn: (m: string, cause?: unknown) => {
      errors.push({ message: m, cause });
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  enabled?: boolean;
  hasToken?: boolean;
  allowedUserId?: number;
  me?: TelegramUser;
  batches?: TelegramUpdate[][];
  autoStop?: boolean;
  reply?: string;
  pendingTurn?: boolean;
  busyTurn?: boolean;
  failMessage?: string;
  workspace?: { kind: "assistant" } | { kind: "project"; workspaceId: string } | { kind: "stale" };
  workspaces?: Array<{ id: string; name: string; folderPath: string }>;
  telegramWorkspaceId?: string;
  workspaceResolver?: MockTurnOptions["workspaceResolver"];
  telegramRendering?: "rich" | "html";
  telegramVoiceMode?: "hidden" | "mirror" | "always";
  telegramThreadedMode?: boolean;
  profile?: string;
  resolveBotBinding?: import("./telegram-service-core.js").TelegramServiceDeps["resolveBotBinding"];
  validateBotBinding?: import("./telegram-service-core.js").TelegramServiceDeps["validateBotBinding"];
  assertBotBindingStoreHealthy?: import("./telegram-service-core.js").TelegramServiceDeps["assertBotBindingStoreHealthy"];
  resolveThreadWorkspace?: (threadId: number) => Promise<string | undefined>;
  clearThreadTargets?: () => Promise<void>;
  listModels?: () => Promise<readonly import("./telegram-controls.js").TelegramModelChoice[]>;
  applyModelSelection?: (
    choice: import("./telegram-controls.js").TelegramModelChoice,
  ) => Promise<void>;
  abortChat?: (chatId: string) => Promise<void>;
  mediaGroupDebounceMs?: number;
  handleExtensionUpdate?: import("./telegram-service-core.js").TelegramServiceDeps["handleExtensionUpdate"];
  synthesizeVoice?: import("./telegram-service-core.js").TelegramServiceDeps["synthesizeVoice"];
  delayAfterFirstBatch?: boolean;
  existingChats?: MockTurnOptions["existingChats"];
  storeInboundFile?: import("./telegram-service-core.js").TelegramServiceDeps["storeInboundFile"];
}

function harness(o: HarnessOptions = {}) {
  const config = createMockConfig({
    enabled: o.enabled ?? false,
    hasToken: o.hasToken ?? true,
    allowedUserId: o.allowedUserId,
    telegramWorkspaceId: o.telegramWorkspaceId,
    telegramRendering: o.telegramRendering,
    telegramVoiceMode: o.telegramVoiceMode,
    telegramThreadedMode: o.telegramThreadedMode,
  });
  const turnMock = createMockTurn({
    reply: o.reply,
    pending: o.pendingTurn,
    busy: o.busyTurn,
    failMessage: o.failMessage,
    workspace: o.workspace,
    workspaceResolver:
      o.workspaceResolver ??
      ((workspaceId) => {
        if (workspaceId) {
          return o.workspaces?.some((workspace) => workspace.id === workspaceId)
            ? { kind: "project" as const, workspaceId }
            : { kind: "stale" as const };
        }
        return o.workspace ?? { kind: "assistant" as const };
      }),
    existingChats: o.existingChats,
  });
  const sleepMock = createMockSleep();
  const logs = createLogs();

  // The api's termination hook calls stop(); wire it after the service exists.
  let stopFn: () => void = () => undefined;

  const api = createMockApi({
    me: o.me,
    batches: o.batches,
    autoStop: o.autoStop,
    stop: () => stopFn(),
    delayAfterFirstBatch: o.delayAfterFirstBatch,
  });

  const service = createTelegramServiceCore({
    api: api as unknown as TelegramBotApi,
    config: config as unknown as TelegramConfig,
    turn: turnMock.turn as unknown as TelegramTurnDeps,
    profile: o.profile,
    resolveBotBinding: o.resolveBotBinding,
    validateBotBinding: o.validateBotBinding,
    assertBotBindingStoreHealthy: o.assertBotBindingStoreHealthy,
    listWorkspaces: async () => o.workspaces ?? [],
    listModels: o.listModels,
    applyModelSelection: o.applyModelSelection,
    abortChat: o.abortChat,
    resolveThreadWorkspace: o.resolveThreadWorkspace,
    clearThreadTargets: o.clearThreadTargets,
    mediaGroupDebounceMs: o.mediaGroupDebounceMs,
    handleExtensionUpdate: o.handleExtensionUpdate,
    synthesizeVoice: o.synthesizeVoice,
    storeInboundFile: o.storeInboundFile,
    getToken: () => Promise.resolve("mock-token"),
    now: () => 0,
    sleep: sleepMock.sleep,
    info: logs.infoFn,
    warn: logs.warnFn,
    error: logs.errorFn,
  });
  stopFn = () => service.stop();

  return { service, api, config, turnMock, sleepMock, logs };
}

/** Spin the event loop until predicate holds (or time out). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("start() is a no-op when the bridge is not enabled (status stays disabled)", async () => {
  const { service, api } = harness({ enabled: false, hasToken: true });

  await service.start();

  assert.equal(api.getMeCalls(), 0, "getMe not called");
  assert.equal(api.getUpdatesCalls(), 0, "getUpdates not called");
  assert.equal(service.getStatus().status, "disabled");
});

test("start() begins polling when enabled with a token (getMe then getUpdates)", async () => {
  const { service, api } = harness({
    enabled: true,
    hasToken: true,
    batches: [],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => api.getMeCalls() >= 1 && api.getUpdatesCalls() >= 1);

  assert.ok(api.getMeCalls() >= 1, "getMe was called");
  assert.ok(api.getUpdatesCalls() >= 1, "getUpdates was called");
  assert.ok(
    api.calls.indexOf("getMe") < api.calls.indexOf("getUpdates"),
    "getMe precedes getUpdates",
  );
  assert.equal(service.getStatus().botUsername, "aiden_bot");
});

test("stop() halts polling and clears the queue", async () => {
  const owner = person(42, "owner");
  const { service, api } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    batches: [
      [
        makeUpdate(1, makeMessage(10, owner, "first")),
        makeUpdate(2, makeMessage(11, owner, "second")),
      ],
    ],
    autoStop: false,
    pendingTurn: true,
  });

  await service.start();
  // First message dispatches and hangs (pending turn); second is gated behind it.
  await waitFor(() => service.isActive && service.queueSize >= 1);

  assert.ok(api.getMeCalls() >= 1, "polling had begun");
  assert.ok(api.getUpdatesCalls() >= 1, "polling had begun");
  assert.ok(service.queueSize >= 1, "queue held the gated turn");

  service.stop();

  assert.equal(service.queueSize, 0, "queue cleared");
  // activeTurn stays true while the in-flight turn is running — stop() must
  // not reset it, or a concurrent dispatch on the same chat would be allowed.
  assert.equal(service.isActive, true, "in-flight turn still tracked as active");
  assert.equal(service.getStatus().status, "disabled");
});

test("connect() throws when no bot token is configured", async () => {
  const { service, api } = harness({ enabled: true, hasToken: false });

  await assert.rejects(service.connect(), /Cannot connect without a bot token/);

  assert.equal(api.getMeCalls(), 0, "no polling attempted");
  assert.equal(api.getUpdatesCalls(), 0, "no polling attempted");
  assert.equal(service.getStatus().status, "disabled");
});

test("disconnect() clears polling and resets the persisted offset", async () => {
  const { service, api, config } = harness({
    enabled: true,
    hasToken: true,
    batches: [],
    autoStop: false,
  });

  await service.start();
  await waitFor(() => api.getMeCalls() >= 1);
  assert.equal(service.getStatus().botUsername, "aiden_bot", "polling had begun");

  await service.disconnect();

  assert.equal(config.clearOffsetCalls(), 1, "offset cleared on disconnect");
  assert.equal(service.getStatus().status, "disabled");
});

// ---------------------------------------------------------------------------
// Authorization / pairing
// ---------------------------------------------------------------------------

test("first message from a non-bot user pairs the owner (sets telegramAllowedUserId)", async () => {
  const newcomer = person(777, "newcomer");
  const { service, api, config } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: undefined,
    batches: [[makeUpdate(1, makeMessage(10, newcomer, "hi"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => config.setSettingsCalls.length >= 1);

  assert.deepEqual(config.setSettingsCalls[0], { telegramAllowedUserId: 777 });
  assert.equal(config.state.allowedUserId, 777, "pairing reflected in snapshot state");

  await waitFor(() => api.sentMessages.some((m) => m.text.includes("paired")));
  assert.ok(
    api.sentMessages.some((m) => m.text.includes("paired")),
    "pairing acknowledgement sent",
  );
});

test("unhealthy binding authority blocks both pairing and ordinary Telegram fallback", async (t) => {
  for (const allowedUserId of [undefined, 42]) {
    await t.test(allowedUserId === undefined ? "unpaired" : "paired", async () => {
      const sender = person(allowedUserId ?? 42, "owner");
      const { service, api, config, turnMock } = harness({
        enabled: true,
        hasToken: true,
        allowedUserId,
        assertBotBindingStoreHealthy: async () => {
          throw new Error("Telegram routing data is unavailable. Open Aiden on the Mac to repair it.");
        },
        batches: [[makeUpdate(1, makeMessage(10, sender, "must not fall back"))]],
        autoStop: true,
      });

      await service.start();
      await waitFor(() => api.sentMessages.some(({ text }) =>
        text.includes("Telegram routing data is unavailable")));

      assert.equal(turnMock.startCalls(), 0);
      assert.equal(service.queueSize, 0);
      assert.equal(config.state.allowedUserId, allowedUserId);
      assert.deepEqual(config.setSettingsCalls, []);
    });
  }
});

test("messages from a user other than the paired owner are ignored", async () => {
  const intruder = person(999, "intruder");
  const { service, api, turnMock, logs } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    batches: [[makeUpdate(1, makeMessage(10, intruder, "let me in"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => logs.warn.length >= 1);

  assert.ok(
    logs.warn.some((m) => m.includes("999")),
    "unauthorized user id logged",
  );
  assert.equal(turnMock.startCalls(), 0, "no LLM turn started");
  assert.equal(service.queueSize, 0, "nothing enqueued");
  assert.equal(api.sentMessages.length, 0, "no reply sent");
});

// ---------------------------------------------------------------------------
// Control commands
// ---------------------------------------------------------------------------

test("/start opens the operator menu and starts no LLM turn", async () => {
  const owner = person(42, "owner");
  const { service, api, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    batches: [[makeUpdate(1, makeMessage(10, owner, "/start"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => api.sentMessages.some((m) => m.text.includes("Aiden Telegram Agent")));

  assert.equal(turnMock.startCalls(), 0, "no LLM turn for /start");
  assert.equal(service.queueSize, 0, "command not enqueued");

  const menu = api.sentMessages.find((m) => m.text.includes("Aiden Telegram Agent"));
  assert.ok(menu, "operator menu present");
  assert.equal(menu?.parseMode, "HTML", "operator menu uses Telegram HTML");
  assert.match(menu.text, /Queue:/);
});

test("/workspace lists configured folders without creating a turn", async () => {
  const owner = person(42, "owner");
  const { service, api, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    workspaces: [
      { id: "aiden", name: "Aiden", folderPath: "/tmp/aiden" },
      { id: "notes", name: "Notes", folderPath: "/tmp/notes" },
    ],
    batches: [[makeUpdate(1, makeMessage(10, owner, "/workspace"))]],

    autoStop: true,
  });

  await service.start();
  await waitFor(() => api.sentMessages.some((message) => message.text.includes("Aiden")));

  const reply = api.sentMessages.find((message) => message.text.includes("Aiden"));
  assert.ok(reply, "workspace list sent");
  assert.match(reply.text, /1\. Aiden/);
  assert.match(reply.text, /2\. Notes/);
  assert.match(reply.text, /\/workspace &lt;number&gt;/);
  assert.equal(turnMock.startCalls(), 0, "workspace command is never an LLM prompt");
});
test("/workspace identifies the currently selected workspace", async () => {
  const owner = person(42, "owner");
  const { service, api } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    telegramWorkspaceId: "notes",
    workspaces: [{ id: "notes", name: "Notes", folderPath: "/tmp/notes" }],
    batches: [[makeUpdate(1, makeMessage(10, owner, "/workspace"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => api.sentMessages.some((message) => message.text.includes("Current: Notes")));
});

test("/workspace number persists the selected configured workspace", async () => {
  const owner = person(42, "owner");
  const { service, api, config, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    workspaces: [
      { id: "aiden", name: "Aiden", folderPath: "/tmp/aiden" },
      { id: "notes", name: "Notes", folderPath: "/tmp/notes" },
    ],
    batches: [[makeUpdate(1, makeMessage(10, owner, "/workspace 2"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => config.setSettingsCalls.some((patch) => "telegramWorkspaceId" in patch));

  assert.deepEqual(config.setSettingsCalls, [{ telegramWorkspaceId: "notes" }]);
  assert.equal(config.state.telegramWorkspaceId, "notes");
  assert.equal(turnMock.startCalls(), 0, "workspace command is never an LLM prompt");
  assert.ok(
    api.sentMessages.some((message) => message.text.includes("Notes")),
    "selection acknowledgement sent",
  );
});

test("/workspace selection scopes the following Telegram prompt", async () => {
  const owner = person(42, "owner");
  const { service, api, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    workspaces: [{ id: "notes", name: "Notes", folderPath: "/tmp/notes" }],
    batches: [
      [
        makeUpdate(1, makeMessage(10, owner, "/workspace notes")),
        makeUpdate(2, makeMessage(11, owner, "list files")),
      ],
    ],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() === 1);

  assert.deepEqual(turnMock.createdChats(), [{ id: "telegram-42-notes", workspaceId: "notes" }]);
  const [started] = turnMock.startedParams();
  assert.equal(started?.chatId, "telegram-42-notes");
  assert.equal(started?.workspaceId, "notes");
  assert.equal(started?.mode, "assistant-automation");
  assert.ok(
    api.sentMessages.some((message) => message.text.includes("Mock reply")),
    "scoped reply delivered",
  );
});

test("/workspace preserves consecutive spaces in an exact workspace name", async () => {
  const owner = person(42, "owner");
  const { service, api, config, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    workspaces: [{ id: "team-notes", name: "Team  Notes", folderPath: "/tmp/team-notes" }],
    batches: [[makeUpdate(1, makeMessage(10, owner, "/workspace Team  Notes"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => config.setSettingsCalls.length === 1);

  assert.deepEqual(config.setSettingsCalls, [{ telegramWorkspaceId: "team-notes" }]);
  assert.equal(turnMock.startCalls(), 0, "workspace command is never an LLM prompt");
  assert.ok(
    api.sentMessages.some((message) =>
      message.text.includes("Telegram workspace set to Team  Notes."),
    ),
    "exact workspace name is acknowledged",
  );
});

test("/workspace rejects a case-mismatched workspace name", async () => {
  const owner = person(42, "owner");
  const { service, api, config, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    workspaces: [{ id: "workspace-notes", name: "Notes", folderPath: "/tmp/notes" }],
    batches: [[makeUpdate(1, makeMessage(10, owner, "/workspace notes"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() =>
    api.sentMessages.some((message) => message.text.includes('Workspace "notes" was not found.')),
  );

  assert.deepEqual(config.setSettingsCalls, []);
  assert.equal(turnMock.startCalls(), 0, "workspace command is never an LLM prompt");
});

test("queued prompts retain the workspace selection present at receipt", async () => {
  const owner = person(42, "owner");
  const { service, config, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    pendingTurn: true,
    workspaces: [{ id: "notes", name: "Notes", folderPath: "/tmp/notes" }],
    batches: [
      [
        makeUpdate(1, makeMessage(10, owner, "first prompt")),
        makeUpdate(2, makeMessage(11, owner, "queued prompt")),
      ],
    ],
    autoStop: false,
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() === 1);
  await config.setSettings({ telegramWorkspaceId: "notes" });
  turnMock.completePendingTurn();
  await waitFor(() => turnMock.startCalls() === 2);

  assert.deepEqual(
    turnMock.startedParams().map(({ workspaceId, mode }) => ({ workspaceId, mode })),
    [
      { workspaceId: undefined, mode: "assistant-unattended" },
      { workspaceId: undefined, mode: "assistant-unattended" },
    ],
  );
  service.stop();
});

test("/workspace off restores assistant-only mode", async () => {
  const owner = person(42, "owner");
  const { service, api, config, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    telegramWorkspaceId: "notes",
    batches: [[makeUpdate(1, makeMessage(10, owner, "/workspace off"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => config.setSettingsCalls.some((patch) => "telegramWorkspaceId" in patch));

  assert.deepEqual(config.setSettingsCalls, [{ telegramWorkspaceId: undefined }]);
  assert.equal(config.state.telegramWorkspaceId, undefined);
  assert.equal(turnMock.startCalls(), 0, "workspace command is never an LLM prompt");
  assert.ok(
    api.sentMessages.some((message) => message.text.includes("assistant-only mode")),
    "assistant-only acknowledgement sent",
  );
});

test("/status replies with bridge status info", async () => {
  const owner = person(42, "owner");
  const { service, api } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    batches: [[makeUpdate(1, makeMessage(10, owner, "/status"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => api.sentMessages.some((m) => m.text.includes("<b>Bot:</b>")));

  const status = api.sentMessages.find((m) => m.text.includes("<b>Bot:</b>"));
  assert.ok(status, "status message sent");
  assert.match(status?.text ?? "", /<b>Bot:<\/b> @aiden_bot/);
  assert.match(status?.text ?? "", /<b>Paired owner:<\/b> <code>42<\/code>/);
  assert.match(status?.text ?? "", /<b>Queue:<\/b>/);
});

// ---------------------------------------------------------------------------
// Turn dispatch
// ---------------------------------------------------------------------------

test("a text message from the owner is dispatched as a headless turn and replied", async () => {
  const owner = person(42, "owner");
  const { service, api, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    batches: [[makeUpdate(1, makeMessage(10, owner, "hello there"))]],
    autoStop: true,
    reply: "Hi from Aiden",
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() >= 1);
  await waitFor(() => api.sentMessages.some((m) => m.text.includes("Hi from Aiden")));

  assert.equal(turnMock.startCalls(), 1, "exactly one turn dispatched");
  assert.equal(service.queueSize, 0, "queue drained after dispatch");
  assert.equal(service.isActive, false, "turn settled");

  const reply = api.sentMessages.find((m) => m.text.includes("Hi from Aiden"));
  assert.ok(reply, "reply delivered");
  assert.equal(reply?.parseMode, "HTML", "reply delivered as Telegram HTML");
  assert.equal(reply?.disablePreview, true, "link preview disabled");
});

test("always voice mode intercepts automatic text and falls back only when synthesis fails", async () => {
  const owner = person(42);
  const voiced = harness({
    enabled: true,
    allowedUserId: 42,
    telegramRendering: "rich",
    telegramVoiceMode: "always",
    batches: [[makeUpdate(1, makeMessage(10, owner, "Speak"))]],
    synthesizeVoice: async () => ({
      bytes: new Uint8Array([1]),
      name: "voice.ogg",
      mimeType: "audio/ogg",
    }),
  });
  await voiced.service.start();
  await waitFor(() => voiced.api.voiceMessages.length === 1);
  assert.equal(voiced.api.richMessages.length, 0);

  const fallback = harness({
    enabled: true,
    allowedUserId: 42,
    telegramRendering: "rich",
    telegramVoiceMode: "always",
    batches: [[makeUpdate(1, makeMessage(10, owner, "Speak"))]],
    synthesizeVoice: async () => undefined,
  });
  await fallback.service.start();
  await waitFor(() => fallback.api.richMessages.length === 1);
  assert.equal(fallback.api.voiceMessages.length, 0);
});

test("a scoped Telegram prompt uses an isolated project chat", async () => {
  const owner = person(42, "owner");
  const { service, api, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    workspace: { kind: "project", workspaceId: "workspace-a" },
    batches: [[makeUpdate(1, makeMessage(10, owner, "list files"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() === 1);
  await waitFor(() => api.sentMessages.some((message) => message.text.includes("Mock reply")));

  assert.deepEqual(turnMock.createdChats(), [
    { id: "telegram-42-workspace-a", workspaceId: "workspace-a" },
  ]);
  const [started] = turnMock.startedParams();
  assert.equal(started?.chatId, "telegram-42-workspace-a");
  assert.equal(started?.workspaceId, "workspace-a");
  assert.equal(started?.mode, "assistant-automation");
});

test("bot-bound Telegram turns use the profile/bot backing chat and normal Pi mode", async () => {
  const owner = person(42, "owner");
  const binding = {
    botId: "bot-a",
    profile: "work",
    chatId: 100,
    ownerUserId: 42,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-work-bot-a",
  } as const;
  const { service, api, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    profile: "work",
    resolveBotBinding: async (input) => input.profile === "work" ? binding : undefined,
    workspaces: [{ id: "work", name: "Work", folderPath: "/work" }],
    existingChats: [{ id: binding.backingChatId, workspaceId: "bot-home-a", botId: "bot-a" }],
    batches: [[makeUpdate(1, makeMessage(10, owner, "bot prompt"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() === 1 && api.sentMessages.some(({ text }) => text.includes("Mock reply")));

  assert.deepEqual(turnMock.createdChats(), []);
  assert.equal(turnMock.startedParams()[0]?.chatId, "telegram-work-bot-a");
  assert.equal(turnMock.startedParams()[0]?.workspaceId, "bot-home-a");
  assert.equal(turnMock.startedParams()[0]?.mode, undefined);
});

test("an ordinary unbound route never enters Bot validation or changes fallback routing", async () => {
  const owner = person(42, "owner");
  let validationCalls = 0;
  const { service, api, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    profile: "work",
    resolveBotBinding: async () => undefined,
    validateBotBinding: async () => {
      validationCalls += 1;
      return "Bot validation must not run for an unbound route.";
    },
    batches: [[makeUpdate(1, makeMessage(10, owner, "ordinary prompt"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(
    () =>
      turnMock.startCalls() === 1 &&
      api.sentMessages.some(({ text }) => text.includes("Mock reply")),
  );

  assert.equal(validationCalls, 0);
  assert.equal(turnMock.startedParams()[0]?.chatId, "telegram-work-42");
  assert.equal(turnMock.startedParams()[0]?.mode, "assistant-unattended");
});

test("a persisted Bot binding dispatches in its managed home while retaining its external route", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-telegram-binding-dispatch-"));
  try {
    const bindings = createTelegramBotBindingStore({
      root: () => root,
      now: () => 100,
      createBackingChatId: () => "telegram-bot-11111111-1111-4111-8111-111111111111",
    });
    const binding = await bindings.bind({
      botId: "bot-a",
      profile: "work",
      chatId: 100,
      ownerUserId: 42,
      workspaceId: "external-work",
      backingWorkspaceId: "managed-bot-home",
    });
    const owner = person(42, "owner");
    const { service, api, turnMock } = harness({
      enabled: true,
      allowedUserId: 42,
      profile: "work",
      resolveBotBinding: (input) => bindings.resolve(
        input.profile,
        input.chatId,
        input.threadId,
      ),
      existingChats: [{
        id: binding.backingChatId,
        workspaceId: binding.backingWorkspaceId,
        botId: binding.botId,
      }],
      batches: [[makeUpdate(1, makeMessage(10, owner, "managed prompt"))]],
      autoStop: true,
    });

    await service.start();
    await waitFor(() => turnMock.startCalls() === 1 && api.sentMessages.some(
      ({ text }) => text.includes("Mock reply"),
    ));

    assert.equal(binding.workspaceId, "external-work");
    assert.equal(turnMock.startedParams()[0]?.workspaceId, "managed-bot-home");
    assert.equal(turnMock.startedParams()[0]?.chatId, binding.backingChatId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bot-bound Telegram files carry exact Bot identity into managed-home storage", async () => {
  const owner = person(42, "owner");
  const stored: Array<{
    workspaceId?: string;
    botId?: string;
    name: string;
  }> = [];
  const inbound: TelegramMessage = {
    ...makeMessage(10, owner, "inspect this file"),
    document: {
      file_id: "file-1",
      file_unique_id: "unique-file-1",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      file_size: 3,
    },
  };
  const { service, api, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    profile: "work",
    resolveBotBinding: async () => ({
      botId: "bot-a",
      profile: "work",
      chatId: 100,
      ownerUserId: 42,
      workspaceId: "external-work",
      backingWorkspaceId: "managed-bot-home",
      backingChatId: "telegram-work-bot-a",
      enabled: true,
      revision: "binding-revision",
      createdAt: 1,
      updatedAt: 1,
    }),
    existingChats: [{
      id: "telegram-work-bot-a",
      workspaceId: "managed-bot-home",
      botId: "bot-a",
    }],
    storeInboundFile: async (input) => {
      stored.push({
        workspaceId: input.workspaceId,
        botId: input.botId,
        name: input.name,
      });
      return "/private/bot-home/.aiden/telegram-inbox/work/report.pdf";
    },
    batches: [[makeUpdate(1, inbound)]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() === 1 && api.sentMessages.some(
    ({ text }) => text.includes("Mock reply"),
  ));

  assert.deepEqual(stored, [{
    workspaceId: "managed-bot-home",
    botId: "bot-a",
    name: "report.pdf",
  }]);
});

test("bot binding validation rejects archived or missing bot identities before queue admission", async () => {
  const owner = person(42, "owner");
  const binding = {
    botId: "archived-bot",
    profile: "default",
    chatId: 100,
    ownerUserId: 42,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-archived",
    backingChatId: "telegram-default-archived-bot",
  } as const;
  const { service, api, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    resolveBotBinding: async () => binding,
    validateBotBinding: async () => false,
    batches: [[makeUpdate(1, makeMessage(10, owner, "should not run"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => api.sentMessages.some(({ text }) => text.includes("unavailable or archived")));

  assert.equal(turnMock.startCalls(), 0);
  assert.equal(service.queueSize, 0);
});

test("a binding resolver is never called for group chats or unauthorized users", async () => {
  let calls = 0;
  const resolver = async () => {
    calls += 1;
    return undefined;
  };
  const intruder = person(99, "intruder");
  const group = makeMessage(10, person(42, "owner"), "group prompt", -100);
  group.chat.type = "group";
  const { service } = harness({
    enabled: true,
    allowedUserId: 42,
    resolveBotBinding: resolver,
    batches: [[makeUpdate(1, group), makeUpdate(2, makeMessage(11, intruder, "private intruder"))]],
    autoStop: true,
  });

  await service.start();
  await waitFor(() => service.getStatus().status === "disabled");
  assert.equal(calls, 0);
});

test("queued turns retain their captured backing chat when a source is rebound", async () => {
  const owner = person(42, "owner");
  const first = {
    botId: "bot-a",
    profile: "default",
    chatId: 100,
    ownerUserId: 42,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-bot-a",
  } as const;
  const second = {
    botId: "bot-b",
    profile: "default",
    chatId: 100,
    ownerUserId: 42,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-b",
    backingChatId: "telegram-bot-b",
  } as const;
  let resolveCalls = 0;
  const { service, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    pendingTurn: true,
    resolveBotBinding: async () => resolveCalls++ === 0 ? first : second,
    workspaces: [{ id: "work", name: "Work", folderPath: "/work" }],
    existingChats: [
      { id: first.backingChatId, workspaceId: "bot-home-a", botId: "bot-a" },
      { id: second.backingChatId, workspaceId: "bot-home-b", botId: "bot-b" },
    ],
    batches: [[
      makeUpdate(1, makeMessage(10, owner, "first")),
      makeUpdate(2, makeMessage(11, owner, "second")),
    ]],
    autoStop: false,
  });

  await service.start();
  await waitFor(() => turnMock.startCalls() === 1 && service.queueSize === 1);
  turnMock.completePendingTurn();
  await waitFor(() => turnMock.startCalls() === 2);

  assert.deepEqual(turnMock.createdChats(), []);
  service.stop();
});

test("dispatch gate blocks a second turn while one is already active", async () => {
  const owner = person(42, "owner");
  const { service, turnMock } = harness({
    enabled: true,
    hasToken: true,
    allowedUserId: 42,
    batches: [
      [
        makeUpdate(1, makeMessage(10, owner, "first")),
        makeUpdate(2, makeMessage(11, owner, "second")),
      ],
    ],
    autoStop: false,
    pendingTurn: true,
  });

  await service.start();
  await waitFor(() => service.isActive);
  await waitFor(() => service.queueSize >= 1);

  assert.equal(turnMock.startCalls(), 1, "only the first turn was dispatched");
  assert.equal(service.isActive, true, "a turn is active");
  assert.ok(service.queueSize >= 1, "second turn held behind the active turn");

  service.stop();
});

test("thumbs-down reaction removes the matching queued prompt", async () => {
  const owner = person(42, "owner");
  const reaction: TelegramUpdate = {
    update_id: 3,
    message_reaction: {
      chat: { id: 100, type: "private" },
      message_id: 11,
      user: owner,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👎" }],
      date: 0,
    },
  };
  const { service, api, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    pendingTurn: true,
    delayAfterFirstBatch: true,
    batches: [
      [
        makeUpdate(1, makeMessage(10, owner, "active")),
        makeUpdate(2, makeMessage(11, owner, "queued")),
      ],
      [reaction],
    ],
    autoStop: false,
  });
  await service.start();
  await waitFor(
    () =>
      turnMock.startCalls() === 1 &&
      api.sentMessages.some(({ text }) => text.includes("Queued prompt removed")),
  );
  assert.equal(service.queueSize, 0);
  turnMock.completePendingTurn();
  service.stop();
});

test("reaction shortcut variants normalize variation selectors and promote queued prompts", async () => {
  const owner = person(42);
  const result = harness({
    enabled: true,
    allowedUserId: 42,
    pendingTurn: true,
    autoStop: false,
    delayAfterFirstBatch: true,
    batches: [
      [
        makeUpdate(1, makeMessage(10, owner, "active")),
        makeUpdate(2, makeMessage(11, owner, "waiting")),
      ],
      [
        {
          update_id: 3,
          message_reaction: {
            chat: { id: 100, type: "private" },
            message_id: 11,
            user: owner,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "❤️" }],
            date: 0,
          },
        },
      ],
    ],
  });
  await result.service.start();
  await waitFor(() => result.api.sentMessages.some(({ text }) => text.includes("promoted")));
  result.service.stop();
});

test("thread provisioning reports the BotFather capability prerequisite", async () => {
  const result = harness({
    enabled: true,
    telegramThreadedMode: true,
    me: { ...BOT, has_topics_enabled: false },
    batches: [],
  });
  await result.service.start();
  await assert.rejects(result.service.ensureThreads(), /BotFather/u);
  assert.ok(
    result.service
      .getStatus()
      .recentDiagnostics.some(({ message }) => message.includes("BotFather")),
  );
});

test("reaction updates are offered to registered extension routing first", async () => {
  const owner = person(42);
  let extensionCalls = 0;
  const { service } = harness({
    enabled: true,
    allowedUserId: 42,
    batches: [
      [
        {
          update_id: 1,
          message_reaction: {
            chat: { id: 100, type: "private" },
            message_id: 10,
            user: owner,
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👍" }],
            date: 0,
          },
        },
      ],
    ],
    handleExtensionUpdate: async () => {
      extensionCalls += 1;
      return true;
    },
  });
  await service.start();
  await waitFor(() => extensionCalls === 1);
});

test("thread messages capture their durable workspace and replies stay in the thread", async () => {
  const owner = person(42);
  const message = makeMessage(10, owner, "inspect");
  message.message_thread_id = 77;
  const { service, api, turnMock } = harness({
    enabled: true,
    allowedUserId: 42,
    telegramRendering: "rich",
    workspaces: [{ id: "project", name: "Project", folderPath: "/tmp/project" }],
    resolveThreadWorkspace: async (threadId) => (threadId === 77 ? "project" : undefined),
    batches: [[makeUpdate(1, message)]],
  });
  await service.start();
  await waitFor(() => api.richMessages.length === 1);
  assert.equal(turnMock.startedParams()[0]?.workspaceId, "project");
  assert.equal(api.richMessages[0]?.threadId, 77);
});

test("pairing reset clears queued work and durable thread bindings", async () => {
  let cleared = 0;
  const { service, config } = harness({
    enabled: true,
    allowedUserId: 42,
    clearThreadTargets: async () => {
      cleared += 1;
    },
    batches: [],
    autoStop: false,
  });
  await service.start();
  await service.resetPairing();
  assert.equal(cleared, 1);
  assert.equal(config.state.allowedUserId, undefined);
  service.stop();
});

test("offset persistence failure is diagnostic and polling remains live", async () => {
  const owner = person(42);
  const { service, api, config } = harness({
    enabled: true,
    allowedUserId: 42,
    batches: [
      [makeUpdate(1, makeMessage(10, owner, "/help"))],
      [makeUpdate(2, makeMessage(11, owner, "/help"))],
    ],
  });
  const originalPersist = config.persistOffset;
  let failed = false;
  config.persistOffset = async (offset: number) => {
    if (!failed) {
      failed = true;
      throw new Error("disk unavailable");
    }
    await originalPersist(offset);
  };
  await service.start();
  await waitFor(
    () => api.sentMessages.filter(({ text }) => text.includes("Aiden Telegram Agent")).length === 2,
  );
  assert.ok(
    service
      .getStatus()
      .recentDiagnostics.some(({ message }) => message.includes("disk unavailable")),
  );
});

test("active-run model switching persists first, aborts safely, and queues a continuation", async () => {
  const owner = person(42);
  const controlMessage = makeMessage(20, BOT, "model menu");
  const choice = {
    providerId: "next-provider",
    providerLabel: "Next",
    model: "next-model",
    reasoning: true,
  };
  const applied: unknown[] = [];
  let aborts = 0;
  let finishActive: () => void = () => undefined;
  const result = harness({
    enabled: true,
    allowedUserId: 42,
    pendingTurn: true,
    delayAfterFirstBatch: true,
    autoStop: false,
    batches: [
      [makeUpdate(1, makeMessage(10, owner, "long task"))],
      [
        {
          update_id: 2,
          callback_query: {
            id: "model",
            from: owner,
            message: controlMessage,
            data: "model:set:0",
          },
        },
      ],
    ],
    listModels: async () => [choice],
    applyModelSelection: async (selected) => {
      applied.push(selected);
    },
    abortChat: async () => {
      aborts += 1;
      finishActive();
    },
  });
  finishActive = result.turnMock.completePendingTurn;
  await result.service.start();
  await waitFor(() => applied.length === 1 && aborts === 1 && result.turnMock.startCalls() === 2);
  assert.deepEqual(applied, [choice]);
  assert.match(
    result.turnMock.startedParams()[1]?.content ?? "",
    /Continue the interrupted task using Next\/next-model/,
  );
  result.service.stop();
});

test("a stale model callback cannot select a model omitted by the current visible catalog", async () => {
  const owner = person(42);
  const applied: unknown[] = [];
  const result = harness({
    enabled: true,
    allowedUserId: 42,
    batches: [
      [
        {
          update_id: 1,
          callback_query: {
            id: "hidden-model",
            from: owner,
            message: makeMessage(20, BOT, "model menu"),
            data: "model:set:0",
          },
        },
      ],
    ],
    listModels: async () => [],
    applyModelSelection: async (selected) => {
      applied.push(selected);
    },
  });
  await result.service.start();
  await waitFor(() => result.api.answerCallbackQueryCalls() > 0);
  assert.deepEqual(applied, []);
  result.service.stop();
});
