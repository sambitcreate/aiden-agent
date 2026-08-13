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
import { test } from "node:test";
import { createTelegramServiceCore } from "./telegram-service-core.js";
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
}

interface SentMessage {
  chatId: number;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  disablePreview?: boolean;
}

function createMockApi(opts: MockApiOptions) {
  const pending = [...(opts.batches ?? [])];
  const sentMessages: SentMessage[] = [];
  const calls: string[] = [];
  let getMeCalls = 0;
  let getUpdatesCalls = 0;
  let sendChatActionCalls = 0;
  let answerCallbackQueryCalls = 0;

  const api = {
    sentMessages,
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
      text: string;
      parseMode?: "HTML" | "MarkdownV2";
      disablePreview?: boolean;
    }): Promise<TelegramMessage> {
      sentMessages.push({
        chatId: p.chatId,
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
    async sendChatAction(_chatId: number, _action: string): Promise<void> {
      sendChatActionCalls += 1;
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
      if (patch.telegramAllowedUserId !== undefined) {
        state.allowedUserId = patch.telegramAllowedUserId;
      }
      if (patch.telegramEnabled !== undefined) {
        state.enabled = patch.telegramEnabled;
      }
      if ("telegramWorkspaceId" in patch) {
        state.telegramWorkspaceId = patch.telegramWorkspaceId;
      }
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
  const createdChats: Array<{ id: string; workspaceId?: string }> = [];
  const startedParams: Array<{ chatId: string; workspaceId?: string; mode?: string }> = [];
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
      _params: { chatId: string; workspaceId?: string; mode?: string },
      owner: TurnOwner,
      _options: unknown,
    ): Promise<boolean> {
      startedParams.push(_params);
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
    async create(input: { id: string; title: string; workspaceId?: string }) {
      createCalls += 1;
      createdChats.push({ id: input.id, workspaceId: input.workspaceId });
      return {
        id: input.id,
        title: input.title,
        updatedAt: 0,
        workspaceId: input.workspaceId,
      };
    },
    async get(_id: string) {
      return null;
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
}

function harness(o: HarnessOptions = {}) {
  const config = createMockConfig({
    enabled: o.enabled ?? false,
    hasToken: o.hasToken ?? true,
    allowedUserId: o.allowedUserId,
    telegramWorkspaceId: o.telegramWorkspaceId,
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
  });

  const service = createTelegramServiceCore({
    api: api as unknown as TelegramBotApi,
    config: config as unknown as TelegramConfig,
    turn: turnMock.turn as unknown as TelegramTurnDeps,
    listWorkspaces: async () => o.workspaces ?? [],
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
