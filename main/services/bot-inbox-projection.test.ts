import assert from "node:assert/strict";
import test from "node:test";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import {
  BOT_INBOX_PROJECTION_LIMITS,
  BotInboxProjectionError,
  createBotInboxProjectionService,
  mergeBotInboxActivityPreviews,
  projectBotFavoriteOrder,
  sanitizeBotInboxText,
  type BotInboxBatchItem,
  type BotInboxBatchRequestItem,
} from "./bot-inbox-projection.js";
import type { ChatMeta } from "./types.js";

function bot(
  id: string,
  overrides: Partial<BotDefinition> = {},
): BotDefinition {
  return {
    id,
    revision: `bot_${id}`,
    name: `Bot ${id}`,
    description: `Purpose ${id}`,
    instructions: `Private instructions ${id}`,
    avatar: "spark",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function chat(
  id: string,
  botId: string | undefined,
  updatedAt: number,
  overrides: Partial<ChatMeta> = {},
): ChatMeta {
  return {
    id,
    title: `Title ${id}`,
    workspaceId: `private-workspace-${id}`,
    ...(botId ? { botId } : {}),
    providerId: `private-provider-${id}`,
    model: `private-model-${id}`,
    createdAt: 1,
    updatedAt,
    ...overrides,
  };
}

function fixture(
  input: {
    bots?: BotDefinition[];
    chats?: ChatMeta[];
    previews?: Readonly<Record<string, string | undefined>>;
    activity?: Readonly<Record<string, BotInboxBatchItem["activityState"]>>;
  } = {},
) {
  const bots = input.bots ?? [bot("bot-a"), bot("bot-b")];
  const chats = input.chats ?? [
    chat("chat-a", "bot-a", 30),
    chat("chat-b", "bot-b", 20),
  ];
  const calls = { bots: 0, metadata: 0, batch: 0, requested: [] as string[][] };
  const service = createBotInboxProjectionService({
    listBots: async () => {
      calls.bots += 1;
      return bots;
    },
    listChatMetadata: async () => {
      calls.metadata += 1;
      return chats;
    },
    projectBatch: async (request: readonly BotInboxBatchRequestItem[]) => {
      calls.batch += 1;
      calls.requested.push(request.map((entry) => entry.chatId));
      return request.map((entry): BotInboxBatchItem => {
        const state = input.activity?.[entry.chatId] ?? "idle";
        return state === "waiting_for_approval"
          ? {
              chatId: entry.chatId,
              preview: input.previews?.[entry.chatId],
              activityState: state,
              canRespondToApproval: true,
            }
          : {
              chatId: entry.chatId,
              preview: input.previews?.[entry.chatId],
              activityState: state,
              canRespondToApproval: false,
            };
      });
    },
  });
  return { service, calls };
}

test("projects recent Bot conversations newest-first with one indexed and one bounded batch read", async () => {
  const app = fixture({
    chats: [
      chat("regular-newest", undefined, 100),
      chat("bot-new", "bot-a", 50),
      chat("unknown-bot", "bot-missing", 45),
      chat("bot-old", "bot-b", 40),
    ],
    previews: {
      "bot-new": "Latest visible reply",
      "bot-old": "Older visible reply",
    },
    activity: { "bot-new": "running", "bot-old": "waiting_for_approval" },
  });

  const page = await app.service.list();

  assert.deepEqual(
    page.conversations.map((entry) => entry.chatId),
    ["bot-new", "bot-old"],
  );
  assert.equal(page.conversations[0]?.preview, "Latest visible reply");
  assert.equal(page.conversations[0]?.activityState, "running");
  assert.equal(page.conversations[1]?.activityState, "waiting_for_approval");
  assert.equal(page.conversations[1]?.canRespondToApproval, true);
  assert.deepEqual(app.calls, {
    bots: 1,
    metadata: 1,
    batch: 1,
    requested: [["bot-new", "bot-old"]],
  });
});

test("projects only the deterministic newest canonical chat for each Bot", async () => {
  const app = fixture({
    bots: [bot("bot-a"), bot("bot-b")],
    chats: [
      chat("legacy-a", "bot-a", 40, { createdAt: 20 }),
      chat("canonical-a", "bot-a", 50, { createdAt: 10 }),
      chat("tie-z", "bot-b", 30, { createdAt: 10 }),
      chat("tie-a", "bot-b", 30, { createdAt: 10 }),
    ],
  });

  const page = await app.service.list();

  assert.deepEqual(
    page.conversations.map((entry) => entry.chatId),
    ["canonical-a", "tie-a"],
  );
  assert.deepEqual(app.calls.requested, [["canonical-a", "tie-a"]]);
});

test("normal pagination batches only the selected page and uses a stable keyset cursor", async () => {
  const bots = Array.from({ length: 61 }, (_, index) =>
    bot(`bot-${String(index).padStart(2, "0")}`),
  );
  const chats = bots.map((entry, index) =>
    chat(`chat-${String(index).padStart(2, "0")}`, entry.id, 100 - index),
  );
  const app = fixture({ chats, bots });

  const first = await app.service.list({ limit: 10 });
  assert.equal(first.conversations.length, 10);
  assert.equal(app.calls.requested[0]?.length, 10);
  assert.ok(first.nextCursor);

  const second = await app.service.list({
    limit: 10,
    cursor: first.nextCursor,
  });
  assert.equal(second.conversations.length, 10);
  assert.equal(app.calls.requested[1]?.length, 10);
  assert.equal(
    new Set(
      [...first.conversations, ...second.conversations].map(
        (entry) => entry.chatId,
      ),
    ).size,
    20,
  );
  assert.ok(
    Date.parse(second.conversations[0]!.updatedAt) <
      Date.parse(
        first.conversations[first.conversations.length - 1]!.updatedAt,
      ),
  );
});

test("search uses one bounded precomputed-preview batch and never requests full histories", async () => {
  const bots = Array.from({ length: 250 }, (_, index) =>
    bot(`bot-${String(index).padStart(3, "0")}`),
  );
  const chats = bots.map((entry, index) =>
    chat(`chat-${String(index).padStart(3, "0")}`, entry.id, 1_000 - index),
  );
  const previews = Object.fromEntries(
    chats.map((entry, index) => [
      entry.id,
      index === 199 ? "The unique needle" : "ordinary",
    ]),
  );
  const app = fixture({ chats, bots, previews });

  const page = await app.service.list({ query: "needle", limit: 10 });

  assert.deepEqual(
    page.conversations.map((entry) => entry.chatId),
    ["chat-199"],
  );
  assert.equal(app.calls.batch, 1);
  assert.equal(
    app.calls.requested[0]?.length,
    BOT_INBOX_PROJECTION_LIMITS.searchCandidates,
  );
  assert.ok(
    page.nextCursor,
    "a bounded scan exposes a continuation instead of scanning history",
  );

  const continued = await app.service.list({
    query: "needle",
    limit: 10,
    cursor: page.nextCursor,
  });
  assert.equal(app.calls.batch, 2);
  assert.ok(
    app.calls.requested[1]!.length <=
      BOT_INBOX_PROJECTION_LIMITS.searchCandidates,
  );
  assert.deepEqual(continued.conversations, []);
});

test("search covers safe bot name, purpose, title, and precomputed preview", async () => {
  const bots = [
    bot("bot-name", { name: "Sherlock" }),
    bot("bot-purpose", { description: "Research outbreaks" }),
    bot("bot-title"),
    bot("bot-preview"),
  ];
  const chats = [
    chat("by-name", "bot-name", 40, { title: "One" }),
    chat("by-purpose", "bot-purpose", 30, { title: "Two" }),
    chat("by-title", "bot-title", 20, { title: "Tokyo plan" }),
    chat("by-preview", "bot-preview", 10, { title: "Four" }),
  ];
  const previews = { "by-preview": "Make a latte" };
  const app = fixture({ bots, chats, previews });

  assert.equal(
    (await app.service.list({ query: "sherlock" })).conversations.length,
    1,
  );
  assert.equal(
    (await app.service.list({ query: "outbreak" })).conversations.length,
    1,
  );
  assert.deepEqual(
    (await app.service.list({ query: "tokyo" })).conversations.map(
      (entry) => entry.chatId,
    ),
    ["by-title"],
  );
  assert.deepEqual(
    (await app.service.list({ query: "latte" })).conversations.map(
      (entry) => entry.chatId,
    ),
    ["by-preview"],
  );
});

test("bot filters remain disjoint and a cursor is bound to its exact search scope", async () => {
  const app = fixture({
    chats: [
      chat("a-one", "bot-a", 30),
      chat("b-one", "bot-b", 20),
      chat("regular", undefined, 40),
    ],
  });
  const first = await app.service.list({ botId: "bot-a", limit: 1 });
  assert.deepEqual(
    first.conversations.map((entry) => entry.chatId),
    ["a-one"],
  );
  assert.equal(first.nextCursor, undefined);

  const paged = fixture({
    bots: [bot("bot-a"), bot("bot-b")],
    chats: [chat("a-one", "bot-a", 30), chat("b-one", "bot-b", 20)],
  });
  const page = await paged.service.list({
    query: "title",
    limit: 1,
  });
  assert.ok(page.nextCursor);
  await assert.rejects(
    paged.service.list({
      query: "different",
      cursor: page.nextCursor,
    }),
    BotInboxProjectionError,
  );
  await assert.rejects(
    paged.service.list({
      botId: "bot-b",
      query: "title",
      cursor: page.nextCursor,
    }),
    BotInboxProjectionError,
  );
});

test("ambient text projection redacts paths, links, and common credentials", async () => {
  const secret = "sk-1234567890abcdef";
  const source = `Saved /Users/person/.aiden/bots/home/private.txt at https://user:pass@example.test?q=secret API_KEY=${secret}`;
  const sanitized = sanitizeBotInboxText(source, 500);
  assert.equal(sanitized.includes("/Users"), false);
  assert.equal(sanitized.includes("example.test"), false);
  assert.equal(sanitized.includes(secret), false);
  assert.match(sanitized, /\[file\]/u);
  assert.match(sanitized, /\[link\]/u);
  assert.match(sanitized, /\[private\]/u);

  const app = fixture({
    bots: [bot("bot-a")],
    chats: [chat("chat-a", "bot-a", 10, { title: source })],
    previews: { "chat-a": `${source} private tool result` },
  });
  const page = await app.service.list();
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes("private-workspace"), false);
  assert.equal(serialized.includes("private-provider"), false);
  assert.equal(serialized.includes("private-model"), false);
  assert.equal(serialized.includes("Private instructions"), false);
  assert.equal(serialized.includes(secret), false);
});

test("result strings, response bytes, query, cursor, index, and batch work stay bounded", async () => {
  const chats = Array.from({ length: 50 }, (_, index) =>
    chat(`chat-${index}`, "bot-a", 100 - index, { title: "🧪".repeat(2_000) }),
  );
  const app = fixture({
    bots: [bot("bot-a")],
    chats,
    previews: Object.fromEntries(
      chats.map((entry) => [entry.id, "🧪".repeat(1_000)]),
    ),
  });
  const page = await app.service.list({ limit: 50 });
  assert.ok(page.conversations.length > 0);
  assert.ok(
    page.conversations.every(
      (entry) => Array.from(entry.title).length <= 1_024,
    ),
  );
  assert.ok(
    page.conversations.every(
      (entry) => Array.from(entry.preview ?? "").length <= 500,
    ),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(page), "utf8") <=
      BOT_INBOX_PROJECTION_LIMITS.responseBytes,
  );

  await assert.rejects(
    app.service.list({ query: "x".repeat(201) }),
    /search is invalid/u,
  );
  await assert.rejects(
    app.service.list({ cursor: "x".repeat(129) }),
    /cursor is invalid/u,
  );
  const tooLarge = fixture({
    chats: Array.from(
      { length: BOT_INBOX_PROJECTION_LIMITS.indexEntries + 1 },
      (_, index) => chat(`chat-${index}`, "bot-a", index + 1),
    ),
  });
  await assert.rejects(tooLarge.service.list(), /too large/u);
  assert.equal(tooLarge.calls.batch, 0);
});

test("batch output is exact, bounded to requested ids, and must include authoritative activity", async () => {
  const base = {
    listBots: async () => [bot("bot-a")],
    listChatMetadata: async () => [chat("chat-a", "bot-a", 10)],
  };
  await assert.rejects(
    createBotInboxProjectionService({
      ...base,
      projectBatch: async () => [],
    }).list(),
    BotInboxProjectionError,
  );
  await assert.rejects(
    createBotInboxProjectionService({
      ...base,
      projectBatch: async () => [
        {
          chatId: "different",
          activityState: "idle",
          canRespondToApproval: false,
        },
      ],
    }).list(),
    BotInboxProjectionError,
  );
  await assert.rejects(
    createBotInboxProjectionService({
      ...base,
      projectBatch: async () => [
        {
          chatId: "chat-a",
          activityState: "private_runtime_state" as never,
          canRespondToApproval: false,
          internalPath: "/private/path",
        } as BotInboxBatchItem,
      ],
    }).list(),
    BotInboxProjectionError,
  );
  await assert.rejects(
    createBotInboxProjectionService({
      ...base,
      projectBatch: async () => {
        throw new Error("/Users/person/.aiden/private/state.json");
      },
    }).list(),
    (error: unknown) =>
      error instanceof BotInboxProjectionError &&
      error.message === "The Bot inbox could not be projected safely.",
  );
});

test("favorite projection preserves order and excludes archived, unknown, duplicate, and excess ids", () => {
  const bots = [
    bot("one"),
    bot("two"),
    bot("archived", { archivedAt: 10 }),
    ...Array.from({ length: 30 }, (_, index) => bot(`extra-${index}`)),
  ];
  const projected = projectBotFavoriteOrder(
    [
      "two",
      "unknown",
      "archived",
      "two",
      "one",
      ...Array.from({ length: 30 }, (_, index) => `extra-${index}`),
    ],
    bots,
  );
  assert.deepEqual(projected.slice(0, 2), ["two", "one"]);
  assert.equal(projected.length, BOT_INBOX_PROJECTION_LIMITS.favoriteCount);
  assert.equal(new Set(projected).size, projected.length);
});

test("production batch composition joins indexed previews by chat identity", () => {
  assert.deepEqual(
    mergeBotInboxActivityPreviews(
      [
        { chatId: "chat-a", botId: "bot-a", updatedAt: 2, preview: "Latest answer" },
        { chatId: "chat-b", botId: "bot-b", updatedAt: 1 },
      ],
      [
        { chatId: "chat-b", activityState: "idle", canRespondToApproval: false },
        { chatId: "chat-a", activityState: "running", canRespondToApproval: false },
      ],
    ),
    [
      { chatId: "chat-b", activityState: "idle", canRespondToApproval: false },
      {
        chatId: "chat-a",
        activityState: "running",
        canRespondToApproval: false,
        preview: "Latest answer",
      },
    ],
  );
});
