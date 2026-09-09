import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChatStore } from "./chat-store-core.js";
import { isEmptyChatMigrationState, isLegacyEmptyWorkspaceChat, migrateEmptyWorkspaceChats, type EmptyChatMigrationState } from "./empty-chat-migration.js";
import type { Chat } from "./types.js";

const empty = (id: string, overrides: Partial<Chat> = {}): Chat => ({
  id, title: "New chat", workspaceId: "default", createdAt: 1, updatedAt: 1, messages: [], ...overrides,
});
const eligible = async (chat: Chat) => isLegacyEmptyWorkspaceChat(chat, new Set(["default", "worktree"]), new Set(["scheduled"]));
function harness(chats: Chat[]) {
  const records = new Map(chats.map((chat) => [chat.id, chat]));
  let state: EmptyChatMigrationState = { version: 1, pending: null, complete: false };
  const removed: string[] = [];
  const deps = {
    load: async () => structuredClone(state),
    save: async (next: EmptyChatMigrationState) => { state = structuredClone(next); },
    list: async () => [...records.values()],
    get: async (id: string) => records.get(id) ?? null,
    eligible,
    remove: async (id: string, assertCurrent: (chat: Chat) => Promise<void>) => {
      await assertCurrent(records.get(id)!);
      records.delete(id);
      removed.push(id);
    },
  };
  return { deps, records, removed, state: () => state };
}

test("only zero-message ordinary workspace chats qualify, regardless of title", async () => {
  const h = harness([
    empty("blank"), empty("renamed", { title: "User title" }), empty("legacy", { workspaceId: undefined }),
    empty("tree", { workspaceId: "worktree" }),
    empty("bot", { botId: "bot-1" }), empty("assistant", { workspaceId: "assistant" }),
    empty("telegram-123-default"), empty("assistant-live:123", { workspaceId: "assistant" }),
    empty("unknown", { workspaceId: "missing" }), empty("scheduled"),
    empty("message", { messages: [{ id: "m", role: "user", content: "", createdAt: 1 }] }),
    empty("assistant-message", { messages: [{ id: "m", role: "assistant", content: "hello", createdAt: 1 }] }),
  ]);
  assert.equal(await migrateEmptyWorkspaceChats(h.deps), 4);
  assert.deepEqual(h.removed, ["blank", "renamed", "legacy", "tree"]);
  assert.deepEqual(h.state(), { version: 1, pending: [], complete: true });
  h.records.set("newer-empty", empty("newer-empty"));
  assert.equal(await migrateEmptyWorkspaceChats(h.deps), 0);
  assert.ok(h.records.has("newer-empty"));
});

test("partial deletion resumes only original snapshot, rechecking nonempty chats", async () => {
  const h = harness([empty("one"), empty("two"), empty("three")]);
  const remove = h.deps.remove;
  let failed = false;
  h.deps.remove = async (id, check) => {
    if (id === "two" && !failed) { failed = true; throw new Error("disk unavailable"); }
    await remove(id, check);
  };
  await assert.rejects(migrateEmptyWorkspaceChats(h.deps), /disk unavailable/u);
  assert.deepEqual(h.state().pending?.map((candidate) => candidate.id), ["two", "three"]);
  h.records.set("newer", empty("newer"));
  h.records.get("three")!.messages.push({ id: "m", role: "user", content: "sent", createdAt: 2 });
  assert.equal(await migrateEmptyWorkspaceChats(h.deps), 1);
  assert.deepEqual(h.removed, ["one", "two"]);
  assert.ok(h.records.has("newer"));
  assert.ok(h.records.has("three"));
});

test("failure saving initial snapshot deletes nothing; failure recording deletion is retryable", async () => {
  const h = harness([empty("one")]);
  const save = h.deps.save;
  h.deps.save = async () => { throw new Error("receipt unavailable"); };
  await assert.rejects(migrateEmptyWorkspaceChats(h.deps), /snapshot could not be saved/u);
  assert.deepEqual(h.removed, []);
  let writes = 0;
  h.deps.save = async (next) => { if (++writes === 2) throw new Error("receipt unavailable"); await save(next); };
  await assert.rejects(migrateEmptyWorkspaceChats(h.deps), /receipt unavailable/u);
  assert.deepEqual(h.removed, ["one"]);
  h.deps.save = save;
  assert.equal(await migrateEmptyWorkspaceChats(h.deps), 0);
  assert.equal(h.state().complete, true);
});

test("corrupt and incomplete migration receipts fail closed", () => {
  for (const state of [null, {}, { version: 2, pending: [], complete: true },
    { version: 1, pending: ["../chat"], complete: false },
    { version: 1, pending: ["a", "a"], complete: false },
    { version: 1, pending: ["a"], complete: true },
    { version: 1, pending: null, complete: true }]) {
    assert.equal(isEmptyChatMigrationState(state), false);
  }
});

test("real chat files and summary rows are deleted while corrupt and populated payloads survive restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-empty-migration-"));
  try {
    const store = createChatStore(async () => root);
    await store.create({ id: "empty", workspaceId: "default" });
    await store.create({ id: "corrupt", workspaceId: "default" });
    await store.create({ id: "populated", workspaceId: "default" });
    await store.appendMessage("populated", { role: "user", content: "hello" });
    await fs.writeFile(path.join(root, "corrupt.json"), "{broken");
    const h = harness([]);
    assert.equal(await migrateEmptyWorkspaceChats({ ...h.deps,
      list: () => store.list(), get: (id) => store.get(id),
      remove: (id, check) => store.remove(id, async (chat) => { if (chat) await check(chat); }),
    }), 1);
    await assert.rejects(fs.stat(path.join(root, "empty.json")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(root, "corrupt.json"), "utf8"), "{broken");
    const reopened = createChatStore(async () => root);
    assert.equal((await reopened.get("populated"))?.messages[0]?.content, "hello");
    assert.ok(!(await reopened.listSummaryMetadata()).some((chat) => chat.id === "empty"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test("resume preserves a replacement chat reusing a candidate ID", async () => {
  const h = harness([empty("reused")]);
  const remove = h.deps.remove;
  h.deps.remove = async () => { throw new Error("interrupted"); };
  await assert.rejects(migrateEmptyWorkspaceChats(h.deps), /interrupted/u);
  h.records.set("reused", empty("reused", { createdAt: 2, updatedAt: 2 }));
  h.deps.remove = remove;
  assert.equal(await migrateEmptyWorkspaceChats(h.deps), 0);
  assert.ok(h.records.has("reused"));
  assert.equal(h.state().complete, true);
});
