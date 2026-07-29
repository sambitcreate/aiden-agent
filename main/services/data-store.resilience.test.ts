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

// The companion to the pin above: load() never re-reads, so reload() is the only
// way an external edit becomes visible. Both halves must change together.
test("DataStore.reload re-reads disk and reports whether the contents changed", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-reload-");
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ count: 7 }), "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  assert.equal((await store.load()).count, 7);

  await fs.writeFile(file, JSON.stringify({ count: 999 }), "utf-8");
  assert.equal(await store.reload(), true);
  assert.equal((await store.load()).count, 999);
  assert.equal(await store.reload(), false, "a second reload has nothing new to report");
});

// PINS content comparison over an mtime/size stat gate. Two different hand-edits
// can share a byte length, and coarse mtime resolution (network shares, older
// filesystems) can place both inside one tick. A stat gate drops the second edit
// silently — exactly the case reload() exists to catch.
test("DataStore.reload sees an edit that shares the previous size and mtime", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-same-size-");
  const file = path.join(dir, "config.json");
  const store = new DataStore<{ id: string }>("config.json", { id: "" }, () => dir);

  await fs.writeFile(file, JSON.stringify({ id: "aaa" }), "utf-8");
  assert.equal((await store.load()).id, "aaa");
  const { mtime, atime, size } = await fs.stat(file);

  // Same length, different content, and the timestamp forced back to what the
  // store already observed.
  await fs.writeFile(file, JSON.stringify({ id: "bbb" }), "utf-8");
  await fs.utimes(file, atime, mtime);
  assert.equal((await fs.stat(file)).size, size, "the two edits really are the same size");

  assert.equal(await store.reload(), true);
  assert.equal((await store.load()).id, "bbb");
});

test("DataStore preserves an unparseable file before overwriting it when asked", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-keep-");
  const file = path.join(dir, "config.json");
  const broken = '{ "count": oops }';
  await fs.writeFile(file, broken, "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    preserveCorruptFile: true,
  });

  assert.deepEqual(await store.load(), { count: 0 }, "still falls back to defaults");
  await store.save({ count: 5 });

  const rescued = (await fs.readdir(dir)).filter((name) => name.includes(".invalid-"));
  assert.equal(rescued.length, 1);
  assert.equal(await fs.readFile(path.join(dir, rescued[0]), "utf-8"), broken);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf-8")), { count: 5 });
});

test("DataStore leaves no rescue copy for a regenerable cache", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-drop-");
  await fs.writeFile(path.join(dir, "config.json"), "{ nope", "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);

  await store.save({ count: 5 });

  assert.deepEqual(await fs.readdir(dir), ["config.json"], "opt-in only; no litter by default");
});

test("DataStore only rescues the corrupt file once, not on every later write", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-corrupt-once-");
  await fs.writeFile(path.join(dir, "config.json"), "{ nope", "utf-8");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir, {
    preserveCorruptFile: true,
  });

  await store.save({ count: 1 });
  await store.save({ count: 2 });
  await store.update((draft) => void (draft.count += 1));

  const rescued = (await fs.readdir(dir)).filter((name) => name.includes(".invalid-"));
  assert.equal(rescued.length, 1);
});

test("DataStore.reload on a missing file yields the default value", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-reload-gone-");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  await store.save({ count: 5 });

  await fs.rm(path.join(dir, "config.json"));
  assert.equal(await store.reload(), true);
  assert.equal((await store.load()).count, 0);
});

// PINS the atomic-write contract. An in-place write can leave a truncated file if
// the process dies mid-write, which is unacceptable for a config the user edits
// by hand rather than a cache the app can regenerate.
test("DataStore.save replaces the file by rename and leaves no staging file", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-atomic-");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  await store.save({ count: 1 });
  await store.save({ count: 2 });

  assert.deepEqual(await fs.readdir(dir), ["config.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")), {
    count: 2,
  });
});

test("DataStore.save leaves no staging file behind when the write is rejected", async (t) => {
  const dir = await tmpDir(t, "aiden-ds-atomic-fail-");
  const store = new DataStore<{ count: number }>("config.json", { count: 0 }, () => dir);
  await store.save({ count: 1 });

  await assert.rejects(() => store.save({ count: 2 }, () => false));
  assert.deepEqual(await fs.readdir(dir), ["config.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")), {
    count: 1,
  });
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
    providerId: undefined,
    model: undefined,
  };
  await fs.writeFile(
    path.join(dir, `${valid.id}.json`),
    JSON.stringify({ ...valid, messages: [] }),
    "utf-8",
  );
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
