import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { ChatForkError, type ChatForkErrorCode } from "./chat-fork-error.js";
import {
  createChatForkService,
  type ChatForkCaller,
  type ChatForkServiceDependencies,
} from "./chat-fork-service.js";
import { createChatStore } from "./chat-store-core.js";
import type { Chat } from "./types.js";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-fork-service-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Parser", workspaceId: "workspace-fork" });
  await store.appendMessage(chat.id, { role: "user", content: "Why does it fail?" });
  await store.appendMessage(chat.id, { role: "assistant", content: "A missing token." });
  await store.appendMessage(chat.id, { role: "user", content: "Fix it." });
  const source = await store.appendMessage(chat.id, { role: "assistant", content: "Fixed." });
  const [firstPrompt, firstReply, secondPrompt, secondReply] = source.messages.map(({ id }) => id);
  return {
    store,
    source,
    ids: { firstPrompt: firstPrompt!, firstReply: firstReply!, secondPrompt: secondPrompt!, secondReply: secondReply! },
  };
}

function service(
  store: ReturnType<typeof createChatStore>,
  overrides: Partial<ChatForkServiceDependencies> = {},
) {
  return createChatForkService({
    chatStore: store,
    beginChatCopy: () => () => undefined,
    workspaceExists: async () => true,
    ...overrides,
  });
}

const caller: ChatForkCaller = {
  admitWorkspace: () => ({ isAborted: () => false, release: () => undefined }),
};

async function rejectsWith(promise: Promise<unknown>, code: ChatForkErrorCode) {
  await assert.rejects(promise, (error) => error instanceof ChatForkError && error.code === code);
}

test("a fork is published once and starts its summary", async (t) => {
  const { store, source, ids } = await fixture(t);
  const published: Chat[] = [];
  const summaries: string[] = [];
  const forks = service(store, {
    published: (chat) => published.push(chat),
    startSummary: (chatId) => summaries.push(chatId),
  });

  const fork = await forks.fork(
    { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" }, summary: {} },
    caller,
  );

  assert.deepEqual(fork.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
  assert.equal(fork.forkedFrom?.summary?.state, "pending");
  assert.deepEqual(published.map(({ id }) => id), [fork.id]);
  assert.deepEqual(summaries, [fork.id]);
});

test("fork failures carry a code a remote client can act on", async (t) => {
  const { store, source, ids } = await fixture(t);
  const forks = service(store, { startSummary: () => undefined });
  const fork = (forkAt: { messageId: string; position: "after" | "before" }, summary?: object) =>
    forks.fork({ chatId: source.id, forkAt, ...(summary ? { summary } : {}) }, caller);

  await rejectsWith(forks.fork({ chatId: "missing-chat" }, caller), "not_found");
  await rejectsWith(fork({ messageId: "missing-message", position: "after" }), "message_not_found");
  // A prompt is not a settled reply, and nothing comes before the first prompt.
  await rejectsWith(fork({ messageId: ids.firstPrompt, position: "after" }), "ineligible");
  await rejectsWith(fork({ messageId: ids.firstPrompt, position: "before" }), "ineligible");
  // Nothing follows the last reply, so there is nothing to summarize.
  await rejectsWith(fork({ messageId: ids.secondReply, position: "after" }, {}), "ineligible");
  assert.equal((await store.list()).length, 1);
});

test("a summary needs a host that can summarize", async (t) => {
  const { store, source, ids } = await fixture(t);
  await rejectsWith(
    service(store).fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" }, summary: {} },
      caller,
    ),
    "unavailable",
  );
});

test("only one copy runs at a time and a busy source is refused", async (t) => {
  const { store, source } = await fixture(t);
  await rejectsWith(service(store, { beginChatCopy: () => null }).fork({ chatId: source.id }, caller), "busy");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const forks = service(store, {
    workspaceExists: async () => {
      await gate;
      return true;
    },
  });
  const first = forks.fork({ chatId: source.id }, caller);
  await rejectsWith(forks.fork({ chatId: source.id }, caller), "busy");
  release();
  await first;
  // The finished copy frees the service for the next one.
  await forks.fork({ chatId: source.id }, caller);
});

test("a chat with unrecovered artifacts is not copied until they are resolved", async (t) => {
  const { store, source } = await fixture(t);
  let blocked: string | undefined = "Recover the visual artifact first.";
  const forks = service(store, { blockedReason: async () => blocked });

  await assert.rejects(
    forks.fork({ chatId: source.id }, caller),
    (error) =>
      error instanceof ChatForkError &&
      error.code === "unavailable" &&
      error.message === "Recover the visual artifact first.",
  );
  assert.equal((await store.list()).length, 1);

  blocked = undefined;
  await forks.fork({ chatId: source.id }, caller);
  assert.equal((await store.list()).length, 2);
});

test("a source that changed since the caller saw it is not forked", async (t) => {
  const { store, source, ids } = await fixture(t);
  const forks = service(store);
  let checks = 0;
  const stale = new Error("stale");
  await assert.rejects(
    forks.fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" } },
      {
        ...caller,
        assertSource: () => {
          checks += 1;
          // The pre-check passes; the source changes before the store locks it.
          if (checks > 1) throw stale;
        },
      },
    ),
    (error) => error === stale,
  );
  assert.equal((await store.list()).length, 1);
});

test("a workspace change aborts the fork and discards its prepared journal", async (t) => {
  const { store, source, ids } = await fixture(t);
  let aborted = false;
  const deleted: string[] = [];
  const forks = service(store, {
    newChatId: () => "fork-target",
    journal: {
      forkChat: async () => {
        aborted = true;
        return true;
      },
      deleteChat: async (chatId) => {
        deleted.push(chatId);
      },
    },
  });

  await rejectsWith(
    forks.fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" } },
      { admitWorkspace: () => ({ isAborted: () => aborted, release: () => undefined }) },
    ),
    "busy",
  );
  assert.deepEqual(deleted, ["fork-target"]);
  assert.equal(await store.get("fork-target"), null);
});

test("a journal that cannot be carried degrades the fork instead of failing it", async (t) => {
  const { store, source, ids } = await fixture(t);
  const degraded: unknown[] = [];
  const failure = new Error("journal unavailable");
  const fork = await service(store, {
    journal: {
      forkChat: async () => {
        throw failure;
      },
      deleteChat: async () => undefined,
    },
    reportDegraded: (error) => degraded.push(error),
  }).fork({ chatId: source.id, forkAt: { messageId: ids.secondPrompt, position: "before" } }, caller);

  assert.deepEqual(fork.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
  assert.deepEqual(degraded, [failure]);
});

test("Bot chats fork only through a caller that can copy them", async (t) => {
  const { store } = await fixture(t);
  const bot = await store.create({ title: "Bot", workspaceId: "workspace-fork", botId: "bot-one" });
  await store.appendMessage(bot.id, { role: "user", content: "Hello" });
  await rejectsWith(service(store).fork({ chatId: bot.id }, caller), "not_found");

  const copy = { ...bot, id: "bot-copy" };
  const published: string[] = [];
  const copied = await service(store, { published: (chat) => published.push(chat.id) }).fork(
    { chatId: bot.id },
    { ...caller, copyBotChat: async () => copy },
  );
  assert.equal(copied, copy);
  assert.deepEqual(published, ["bot-copy"]);
});

test("a host whose turns read only the journal refuses a fork it cannot journal", async (t) => {
  const { store, source, ids } = await fixture(t);
  const degraded: unknown[] = [];
  const deleted: string[] = [];
  let forkChat: () => Promise<boolean> = async () => {
    throw new Error("rename failed");
  };
  const forks = service(store, {
    newChatId: () => "fork-target",
    journalRequired: true,
    journal: {
      forkChat: () => forkChat(),
      deleteChat: async (chatId) => {
        deleted.push(chatId);
      },
    },
    reportDegraded: (error) => degraded.push(error),
  });
  const fork = () =>
    forks.fork({ chatId: source.id, forkAt: { messageId: ids.secondPrompt, position: "before" } }, caller);

  await rejectsWith(fork(), "unavailable");
  // A partly written journal is discarded with the fork it was for.
  assert.deepEqual(deleted, ["fork-target"]);
  forkChat = async () => false;
  await rejectsWith(fork(), "unavailable");
  assert.deepEqual((await store.list()).map(({ id }) => id), [source.id]);
  assert.deepEqual(degraded, []);

  forkChat = async () => true;
  const forked = await fork();
  assert.deepEqual(forked.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
});

test("a caller can refuse the copy before it is installed", async (t) => {
  const { store, source, ids } = await fixture(t);
  const refused = new Error("too large to send");
  const summaries: string[] = [];
  await assert.rejects(
    service(store, { startSummary: (chatId) => summaries.push(chatId) }).fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" }, summary: {} },
      {
        ...caller,
        assertInstallable: (chat) => {
          assert.deepEqual(chat.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
          throw refused;
        },
      },
    ),
    (error) => error === refused,
  );
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(summaries, []);
});

test("feature-owned chats are ineligible for copy and fork", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-fork-owned-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const owned = await store.create({ owner: { kind: "design-project", projectId: "project-1" } });
  await store.appendMessage(owned.id, { role: "user", content: "A pricing page" });
  const reply = await store.appendMessage(owned.id, { role: "assistant", content: "Here it is." });
  const published: Chat[] = [];
  const admitted: string[] = [];
  const recordingCaller: ChatForkCaller = {
    admitWorkspace: (workspaceId) => {
      admitted.push(workspaceId);
      return { isAborted: () => false, release: () => undefined };
    },
  };
  const forks = service(store, { published: (chat) => published.push(chat), startSummary: () => undefined });

  await rejectsWith(forks.fork({ chatId: owned.id }, recordingCaller), "ineligible");
  await rejectsWith(
    forks.fork(
      { chatId: owned.id, forkAt: { messageId: reply.messages[1]!.id, position: "after" } },
      recordingCaller,
    ),
    "ineligible",
  );
  // Refused before any workspace admission: an owned chat never borrows the
  // default workspace's mutation gate.
  assert.deepEqual(admitted, []);
  assert.deepEqual(published, []);
  assert.equal((await store.list()).length, 1);
});
