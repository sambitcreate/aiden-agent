// Resilience / corruption-recovery tests for the on-disk stores.
//
// These PIN current behavior: a corrupt or missing JSON file silently falls
// back to the default value rather than throwing or crashing the app. This is
// the regression sentinel that makes a future schema-version / migration change
// safe to introduce and review — if the fallback semantics change, these tests
// must change in lockstep.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import { createChatStore } from "./chat-store-core.js";

async function tmpDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// ── DataStore ───────────────────────────────────────────────────────────────

test("DataStore.load returns the default value when the file is missing", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-missing-");
  const store = new DataStore("absent.json", { count: 0 }, () => dir);
  assert.deepEqual(await store.load(), { count: 0 });
});

test("DataStore.load returns the default value when the file is corrupt JSON", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-");
  await fs.writeFile(path.join(dir, "config.json"), "{not valid json", "utf-8");
  const store = new DataStore("config.json", { count: 99 }, () => dir);
  assert.deepEqual(await store.load(), { count: 99 });
});

test("DataStore.load caches: a second load does not re-read disk", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-cache-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 7 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  const first = await store.load();
  assert.equal(first.count, 7);
  // Mutate the file after the first load; the cached value must win.
  await fs.writeFile(file, JSON.stringify({ count: 999 }), "utf-8");
  const second = await store.load();
  assert.equal(second.count, 7);
});

test("DataStore.update throws when isCurrent() reports the document is stale", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-stale-");
  const store = new DataStore<{ n: number }>("state.json", { n: 0 }, () => dir);
  await store.load();
  await assert.rejects(
    () =>
      store.update(
        (draft) => void (draft.n += 1),
        () => false,
      ),
    /renderer document is no longer active/i,
  );
});

test("DataStore.update serializes concurrent transactions in arrival order", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-serial-");
  const store = new DataStore<{ log: string[] }>("state.json", { log: [] }, () => dir);

  // Interleave updates; each blocks on its own deferred so ordering is forced.
  const order: string[] = [];
  function gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  }
  const g1 = gate();
  const g2 = gate();
  const g3 = gate();

  const u1 = store.update(async (draft) => {
    order.push("u1-start");
    await g1.promise;
    draft.log.push("a");
    order.push("u1-end");
  });
  const u2 = store.update(async (draft) => {
    order.push("u2-start");
    await g2.promise;
    draft.log.push("b");
    order.push("u2-end");
  });
  const u3 = store.update(async (draft) => {
    order.push("u3-start");
    await g3.promise;
    draft.log.push("c");
    order.push("u3-end");
  });

  // Release in order.
  g1.release();
  await u1;
  g2.release();
  await u2;
  g3.release();
  await u3;

  assert.deepEqual(order, ["u1-start", "u1-end", "u2-start", "u2-end", "u3-start", "u3-end"]);
  assert.deepEqual((await store.load()).log, ["a", "b", "c"]);
});

// ── Chat store (chat-store-core) ────────────────────────────────────────────

test("chat store: list() returns [] when index.json is corrupt", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-corrupt-index-");
  await fs.writeFile(path.join(dir, "index.json"), "[broken,}", "utf-8");
  const store = createChatStore(async () => dir);
  assert.deepEqual(await store.list(), []);
});

test("chat store: list() returns [] when index.json is valid JSON with the wrong root shape", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-invalid-index-shape-");
  for (const value of [{}, null, "not-an-array"]) {
    await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(value), "utf-8");
    const store = createChatStore(async () => dir);
    assert.deepEqual(await store.list(), []);
  }
});

test("chat store: list() drops malformed index entries while preserving valid chats", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-invalid-index-entry-");
  const valid = {
    id: "valid",
    title: "Valid",
    createdAt: 1,
    updatedAt: 2,
    workspaceId: "default",
  };
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify([valid, null, {}, { ...valid, id: "" }, { ...valid, updatedAt: "later" }]),
    "utf-8",
  );
  const store = createChatStore(async () => dir);
  assert.deepEqual(await store.list(), [valid]);
});

test("chat store: list() returns [] when index.json is missing", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-missing-index-");
  const store = createChatStore(async () => dir);
  assert.deepEqual(await store.list(), []);
});

test("chat store: get() returns null for a chat file that fails to parse", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-corrupt-chat-");
  // A valid index pointing at a chat file that is corrupt JSON.
  const chatId = "deadbeef";
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify([
      { id: chatId, title: "Ghost", createdAt: 1, updatedAt: 1, workspaceId: "default" },
    ]),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, `${chatId}.json`), "{not json", "utf-8");
  const store = createChatStore(async () => dir);
  assert.equal(await store.get(chatId), null);
});

test("chat store: a chat file with unknown extra fields still loads (forward-compat)", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-forward-");
  const store = createChatStore(async () => dir);
  const created = await store.create({ workspaceId: "default" });
  await store.appendMessage(created.id, { role: "user", content: "hi" });

  // Inject a future-shape field into the chat file directly, then reload.
  const file = path.join(dir, `${created.id}.json`);
  const raw = JSON.parse(await fs.readFile(file, "utf-8"));
  raw.futureField = { anything: true };
  raw.messages[0].futureMessageField = 42;
  await fs.writeFile(file, JSON.stringify(raw), "utf-8");

  const reloaded = await store.get(created.id);
  assert.equal(reloaded?.id, created.id);
  assert.equal(reloaded?.messages[0].content, "hi");
});

test("chat store: a chat message missing optional fields loads with safe defaults", async (t) => {
  const dir = await tmpDir(t, "aiden-chat-minimal-");
  const store = createChatStore(async () => dir);
  const created = await store.create({ workspaceId: "default" });

  // Write a minimal chat file with only the required message fields (no
  // reasoning/timeline/model — the sanitization in readChat must not throw).
  const minimal = {
    id: created.id,
    title: "Minimal",
    createdAt: 1,
    updatedAt: 1,
    workspaceId: "default",
    messages: [
      { id: "m1", role: "assistant", content: "ok", createdAt: 1 },
      { id: "m2", role: "user", content: "hey", createdAt: 2 },
    ],
  };
  await fs.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify([
      {
        id: created.id,
        title: "Minimal",
        createdAt: 1,
        updatedAt: 1,
        workspaceId: "default",
      },
    ]),
    "utf-8",
  );
  await fs.writeFile(path.join(dir, `${created.id}.json`), JSON.stringify(minimal), "utf-8");

  const reloaded = await store.get(created.id);
  assert.equal(reloaded?.messages.length, 2);
  // The assistant message keeps an undefined reasoning (not thrown); the user
  // message has reasoning stripped to undefined per readChat sanitization.
  assert.equal(reloaded?.messages[0].reasoning, undefined);
  assert.equal(reloaded?.messages[1].reasoning, undefined);
});
