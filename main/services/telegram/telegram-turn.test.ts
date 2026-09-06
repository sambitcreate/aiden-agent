import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramBackgroundOwner,
  ensureTelegramChat,
  sendTelegramTurn,
  telegramChatId,
  type ChatTurnLease,
  type TelegramChatStore,
  type TelegramLlmClient,
  type TelegramTurnDeps,
} from "./telegram-turn.js";

type ChatRecord = {
  id: string;
  workspaceId?: string;
  botId?: string;
  providerId?: string;
  model?: string;
  title: string;
  updatedAt: number;
};

function lease(): ChatTurnLease {
  return {
    release() {},
    settleAsyncWork() {},
  };
}

/** Build a mock llmClient. `start` receives the synthetic owner so it can settle the turn. */
function mockLlm(
  start?: TelegramLlmClient["start"],
  begin: ChatTurnLease | null = lease(),
): TelegramLlmClient {
  return {
    beginChatTurn: () => begin,
    start: start ?? (async () => true),
    isChatBusy: () => false,
    waitForChatIdle: async () => true,
  };
}

function mockChatStore(existing: ChatRecord | null = null): {
  store: TelegramChatStore;
  created: string[];
  appended: Array<{ id: string; role: string; content: string }>;
} {
  const created: string[] = [];
  const appended: Array<{ id: string; role: string; content: string }> = [];
  const store: TelegramChatStore = {
    async create(input) {
      created.push(input.id);
      return { id: input.id, title: input.title, updatedAt: 1 };
    },
    async get(id) {
      return existing && existing.id === id ? existing : null;
    },
    async appendMessage(id, message) {
      appended.push({ id, role: message.role, content: message.content });
      return { id, title: "Telegram", updatedAt: 2 };
    },
  };
  return { store, created, appended };
}

const MOCK_PROVIDER = {
  id: "openai",
  kind: "openai" as const,
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  needsKey: true,
};

function mockDeps(opts: {
  llm?: TelegramLlmClient;
  store?: TelegramChatStore;
  provider?: { providerId: string; model: string } | null;
  workspace?: { kind: "assistant" } | { kind: "project"; workspaceId: string } | { kind: "stale" };
}): { deps: TelegramTurnDeps; broadcasts: ChatRecord[] } {
  const broadcasts: ChatRecord[] = [];
  const deps: TelegramTurnDeps = {
    llmClient: opts.llm ?? mockLlm(),
    chatStore: opts.store ?? mockChatStore().store,
    resolveProvider:
      opts.provider === undefined
        ? async () => ({ providerId: "openai", model: "gpt-4o", provider: MOCK_PROVIDER })
        : async () => (opts.provider ? { ...opts.provider, provider: MOCK_PROVIDER } : null),
    resolveWorkspace: async () => opts.workspace ?? { kind: "assistant" },
    preflightBotTurnAuthority: async () => undefined,
    broadcastMetadata: (chat) => {
      broadcasts.push(chat);
    },
  };
  return { deps, broadcasts };
}

test("telegramChatId returns telegram-<userId>", () => {
  assert.equal(telegramChatId(123), "telegram-123");
  assert.equal(telegramChatId(0), "telegram-0");
});

test("telegramChatId namespaces named Telegram profiles without changing the default legacy id", () => {
  assert.equal(telegramChatId(123, undefined, "default"), "telegram-123");
  assert.equal(telegramChatId(123, undefined, "work"), "telegram-work-123");
  assert.notEqual(telegramChatId(123, "workspace-a", "work"), telegramChatId(123, "workspace-a", "notes"));
});

test("workspace Telegram turn starts assistant automation with the selected workspace", async () => {
  let startedParams: { chatId: string; workspaceId?: string; mode?: string } | undefined;
  let interactionSurface: string | undefined;
  const llm = mockLlm(async (streamId, params, owner, options) => {
    startedParams = params;
    interactionSurface = options.interactionSurface;
    owner.send("chat:done", { streamId, content: "done" });
    return true;
  });
  const { deps } = mockDeps({
    llm,
    workspace: { kind: "project", workspaceId: "workspace-a" },
  });
  const chatId = telegramChatId(123, "workspace-a");

  await sendTelegramTurn(deps, chatId, "list files");

  assert.equal(chatId, "telegram-123-workspace-a");
  assert.equal(startedParams?.chatId, chatId);
  assert.equal(startedParams?.workspaceId, "workspace-a");
  assert.equal(startedParams?.mode, "assistant-automation");
  assert.equal(interactionSurface, "telegram");
});

test("stale Telegram workspace errors before generation", async () => {
  let startCalls = 0;
  const llm = mockLlm(async (streamId, _params, owner) => {
    startCalls += 1;
    owner.send("chat:done", { streamId, content: "done" });
    return true;
  });
  const { deps } = mockDeps({ llm, workspace: { kind: "stale" } });

  const result = await sendTelegramTurn(deps, telegramChatId(123, "missing"), "list files");

  assert.deepEqual(result, {
    ok: false,
    content: "",
    error:
      "The Telegram workspace is no longer available. Choose a folder workspace in Aiden Settings.",
  });
  assert.equal(startCalls, 0);
});

test("assistant-only Telegram turn preserves the owner chat and assistant mode", async () => {
  let startedParams: { chatId: string; workspaceId?: string; mode?: string } | undefined;
  let interactionSurface: string | undefined;
  const llm = mockLlm(async (streamId, params, owner, options) => {
    startedParams = params;
    interactionSurface = options.interactionSurface;
    owner.send("chat:done", { streamId, content: "done" });
    return true;
  });
  const { deps } = mockDeps({ llm, workspace: { kind: "assistant" } });
  const chatId = telegramChatId(123);

  await sendTelegramTurn(deps, chatId, "settings help");

  assert.equal(startedParams?.chatId, "telegram-123");
  assert.equal(startedParams?.workspaceId, undefined);
  assert.equal(startedParams?.mode, "assistant-unattended");
  assert.equal(interactionSurface, "telegram");
});

test("bot-bound Telegram turn omits assistant mode while retaining the Pi admission path", async () => {
  let startedParams: { chatId: string; workspaceId?: string; mode?: string } | undefined;
  let botAudienceId: string | undefined;
  let approvalCeiling: Pick<Parameters<TelegramLlmClient["start"]>[3], "allowComputerUse" | "allowSubagents" | "allowMcpTools" | "interactionSurface"> | undefined;
  const llm = mockLlm(async (streamId, params, owner, options) => {
    startedParams = params;
    botAudienceId = options.botAudienceId;
    approvalCeiling = {
      allowComputerUse: options.allowComputerUse,
      allowSubagents: options.allowSubagents,
      allowMcpTools: options.allowMcpTools,
      interactionSurface: options.interactionSurface,
    };
    owner.send("chat:done", { streamId, content: "done" });
    return true;
  });
  const { deps } = mockDeps({ llm, workspace: { kind: "project", workspaceId: "workspace-a" } });
  const binding = {
    botId: "bot-a",
    profile: "work",
    chatId: 100,
    ownerUserId: 123,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-work-bot-a",
  } as const;
  deps.chatStore = mockChatStore({
    id: binding.backingChatId,
    botId: binding.botId,
    workspaceId: binding.backingWorkspaceId,
    providerId: "openai",
    model: "gpt-4o",
    title: "Bot A",
    updatedAt: 1,
  }).store;
  let requestedProvider: string | undefined;
  let requestedModel: string | undefined;
  deps.resolveProvider = async (providerId, model) => {
    requestedProvider = providerId;
    requestedModel = model;
    return { providerId: "openai", model: "gpt-4o", provider: MOCK_PROVIDER };
  };

  const result = await sendTelegramTurn(
    deps,
    binding.backingChatId,
    "bot prompt",
    { kind: "project", workspaceId: "bot-home-a" },
    undefined,
    undefined,
    { binding },
  );

  assert.equal(result.ok, true);
  assert.equal(startedParams?.chatId, binding.backingChatId);
  assert.equal(startedParams?.workspaceId, "bot-home-a");
  assert.equal(startedParams?.mode, undefined);
  assert.equal(botAudienceId, "telegram:work:owner:123");
  assert.deepEqual(approvalCeiling, {
    allowComputerUse: false,
    allowSubagents: false,
    allowMcpTools: false,
    interactionSurface: "telegram",
  });
  assert.equal(requestedProvider, "openai");
  assert.equal(requestedModel, "gpt-4o");
});

test("bot-bound Telegram rejects a non-exact provider resolution before durable append", async () => {
  let beginCalls = 0;
  let startCalls = 0;
  const llm = mockLlm(async () => {
    startCalls += 1;
    return true;
  });
  llm.beginChatTurn = () => {
    beginCalls += 1;
    return lease();
  };
  const binding = {
    botId: "bot-a",
    profile: "work",
    chatId: 100,
    ownerUserId: 123,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-work-bot-a",
  } as const;
  const { store, appended } = mockChatStore({
    id: binding.backingChatId,
    botId: binding.botId,
    workspaceId: binding.backingWorkspaceId,
    providerId: "provider-bot",
    model: "model-bot",
    title: "Bot A",
    updatedAt: 1,
  });
  const { deps } = mockDeps({
    llm,
    store,
    provider: { providerId: "provider-profile", model: "model-profile" },
    workspace: { kind: "project", workspaceId: binding.backingWorkspaceId },
  });

  await assert.rejects(
    sendTelegramTurn(
      deps,
      binding.backingChatId,
      "must not persist",
      { kind: "project", workspaceId: binding.backingWorkspaceId },
      undefined,
      undefined,
      { binding },
    ),
    /no longer resolves exactly/u,
  );
  assert.equal(appended.length, 0);
  assert.equal(beginCalls, 0);
  assert.equal(startCalls, 0);
});

test("bot-bound Telegram preflights protected runtime authority before reserving or appending", async () => {
  let beginCalls = 0;
  let startCalls = 0;
  let preflightRequest: unknown;
  const llm = mockLlm(async () => {
    startCalls += 1;
    return true;
  });
  llm.beginChatTurn = () => {
    beginCalls += 1;
    return lease();
  };
  const binding = {
    botId: "bot-a",
    profile: "work",
    chatId: 100,
    ownerUserId: 123,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-work-bot-a",
  } as const;
  const { store, appended } = mockChatStore({
    id: binding.backingChatId,
    botId: binding.botId,
    workspaceId: binding.backingWorkspaceId,
    providerId: "provider-bot",
    model: "model-bot",
    title: "Bot A",
    updatedAt: 1,
  });
  const { deps } = mockDeps({
    llm,
    store,
    provider: { providerId: "provider-bot", model: "model-bot" },
    workspace: { kind: "project", workspaceId: binding.backingWorkspaceId },
  });
  deps.preflightBotTurnAuthority = async (request) => {
    preflightRequest = request;
    throw new Error("protected Bot policy uses another model");
  };

  await assert.rejects(
    sendTelegramTurn(
      deps,
      binding.backingChatId,
      "must not persist",
      { kind: "project", workspaceId: binding.backingWorkspaceId },
      undefined,
      undefined,
      { binding },
    ),
    /protected Bot policy uses another model/u,
  );
  assert.deepEqual(preflightRequest, {
    audienceId: "telegram:work:owner:123",
    botId: "bot-a",
    chatId: binding.backingChatId,
    providerId: "provider-bot",
    model: "model-bot",
  });
  assert.equal(appended.length, 0);
  assert.equal(beginCalls, 0);
  assert.equal(startCalls, 0);
});

test("createTelegramBackgroundOwner exposes telegram:<streamId> documentId and resolves terminal on chat:done", async () => {
  const { owner, terminal } = createTelegramBackgroundOwner("stream-abc");
  assert.equal(owner.documentId, "telegram:stream-abc");

  owner.send("chat:done", { streamId: "stream-abc", content: "hello" });
  const result = (await terminal) as { content: string };
  assert.equal(result.content, "hello");
});

test("createTelegramBackgroundOwner captures chat:delta events into deltas", () => {
  const { owner, deltas } = createTelegramBackgroundOwner("stream-1");
  owner.send("chat:delta", { delta: "Hello" });
  owner.send("chat:delta", { delta: " " });
  owner.send("chat:delta", { delta: "world" });
  // A delta payload without a `delta` string is ignored.
  owner.send("chat:delta", {});

  assert.deepEqual(deltas, ["Hello", " ", "world"]);
});

test("sendTelegramTurn returns ok with content when start resolves true and terminal has content", async () => {
  const llm = mockLlm(async (streamId, _params, owner) => {
    owner.send("chat:done", { streamId, content: "hello world" });
    return true;
  });
  const { store, appended } = mockChatStore();
  const { deps } = mockDeps({ llm, store });

  const result = await sendTelegramTurn(deps, "telegram-123", "ping");

  assert.deepEqual(result, { ok: true, content: "hello world", error: null });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].role, "user");
  assert.equal(appended[0].content, "ping");
});

test("sendTelegramTurn reports in-progress when beginChatTurn returns null", async () => {
  const llm = mockLlm(undefined, null);
  const { deps } = mockDeps({ llm });

  const result = await sendTelegramTurn(deps, "telegram-123", "ping");

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /in progress/i);
});

test("sendTelegramTurn reports no provider when resolveProvider returns null", async () => {
  const { deps } = mockDeps({ provider: null });

  const result = await sendTelegramTurn(deps, "telegram-123", "ping");

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /provider/i);
});

test("sendTelegramTurn returns error when the terminal is a ChatError", async () => {
  const llm = mockLlm(async (streamId, _params, owner) => {
    owner.send("chat:error", { streamId, message: "boom", content: "partial" });
    return true;
  });
  const { store } = mockChatStore();
  const { deps } = mockDeps({ llm, store });

  const result = await sendTelegramTurn(deps, "telegram-123", "ping");

  assert.equal(result.ok, false);
  assert.equal(result.error, "boom");
  assert.equal(result.content, "partial");
});

test("ensureTelegramChat creates a chat when none exists and reuses an existing one", async () => {
  const createCalls: string[] = [];
  const gets: string[] = [];
  let existing: ChatRecord | null = null;
  const store: TelegramChatStore = {
    async create(input) {
      createCalls.push(input.id);
      existing = { id: input.id, title: input.title, updatedAt: 1 };
      return existing;
    },
    async get(id) {
      gets.push(id);
      return existing;
    },
    async appendMessage(id) {
      return { id, title: "Telegram", updatedAt: 2 };
    },
  };
  const broadcasts: ChatRecord[] = [];
  const deps: TelegramTurnDeps = {
    llmClient: mockLlm(),
    chatStore: store,
    resolveProvider: async () => ({
      providerId: "openai",
      model: "gpt-4o",
      provider: MOCK_PROVIDER,
    }),
    resolveWorkspace: async () => ({ kind: "assistant" }),
    broadcastMetadata: (chat) => {
      broadcasts.push(chat);
    },
  };

  // First call: chat does not exist → create is invoked.
  const first = await ensureTelegramChat(deps, 123, "Telegram Owner", "openai", "gpt-4o");
  assert.equal(first, "telegram-123");
  assert.deepEqual(gets, ["telegram-123"]);
  assert.deepEqual(createCalls, ["telegram-123"]);
  assert.equal(broadcasts.length, 1);

  // Second call: chat now exists → reuse, no new create.
  const second = await ensureTelegramChat(deps, 123, "Telegram Owner", "openai", "gpt-4o");
  assert.equal(second, "telegram-123");
  assert.deepEqual(createCalls, ["telegram-123"]);
  assert.equal(broadcasts.length, 2);
});

test("ensureTelegramChat tags a bot backing chat with botId", async () => {
  let created: { id: string; workspaceId?: string; botId?: string } | undefined;
  const store: TelegramChatStore = {
    async create(input) {
      created = { id: input.id, workspaceId: input.workspaceId, botId: input.botId };
      return { id: input.id, title: input.title, updatedAt: 1, botId: input.botId };
    },
    async get() {
      return null;
    },
    async appendMessage(id) {
      return { id, title: "Telegram", updatedAt: 2 };
    },
  };
  const { deps } = mockDeps({ store });
  const binding = {
    botId: "bot-a",
    profile: "work",
    chatId: 123,
    ownerUserId: 123,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-work-bot-a",
  } as const;

  const chatId = await ensureTelegramChat(
    deps,
    123,
    "Bot A",
    "openai",
    "gpt-4o",
    "bot-home-a",
    "work",
    binding,
  );
  assert.equal(chatId, "telegram-work-bot-a");
  assert.deepEqual(created, {
    id: "telegram-work-bot-a",
    workspaceId: "bot-home-a",
    botId: "bot-a",
  });
});

test("ensureTelegramChat refuses to reuse an untagged or differently tagged bot backing chat", async () => {
  const binding = {
    botId: "bot-a",
    profile: "work",
    chatId: 123,
    ownerUserId: 123,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-a",
    backingChatId: "telegram-work-bot-a",
  } as const;
  const { deps } = mockDeps({
    store: {
      async create(input) {
        return { id: input.id, title: input.title, updatedAt: 1, botId: input.botId };
      },
      async get(id) {
        return { id, title: "Existing", updatedAt: 1 };
      },
      async appendMessage(id) {
        return { id, title: "Existing", updatedAt: 1 };
      },
    },
  });

  await assert.rejects(
    ensureTelegramChat(
      deps,
      123,
      "Bot A",
      "openai",
      "gpt-4o",
      "bot-home-a",
      "work",
      binding,
    ),
    /different bot or workspace binding/u,
  );
});

test("owner.send throws after destroy is called", () => {
  const bg = createTelegramBackgroundOwner("stream-x");
  assert.equal(bg.owner.isDestroyed(), false);

  bg.destroy();
  assert.equal(bg.owner.isDestroyed(), true);
  assert.throws(() => bg.owner.send("chat:done", { content: "late" }), /no longer active/);
});


test("Telegram skill provenance reaches generation while only raw user text is persisted", async () => {
  const chat = mockChatStore();
  const selection = { workspaceId: "project", invocationId: "opaque-skill" };
  const { deps } = mockDeps({ store: chat.store, llm: mockLlm(async (streamId, params, owner, options) => {
    assert.deepEqual(options.telegramSkillInvocation, selection);
    assert.equal(params.messages[0]?.content, "inspect this patch");
    owner.send("chat:done", { streamId, content: "Reviewed" });
    return true;
  }) });
  const result = await sendTelegramTurn(deps, "telegram-test", "inspect this patch",
    { kind: "project", workspaceId: "project" }, undefined, undefined, { skillInvocation: selection });
  assert.equal(result.ok, true);
  assert.deepEqual(chat.appended.map(({ content }) => content), ["inspect this patch"]);
});
