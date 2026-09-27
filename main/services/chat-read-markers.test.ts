import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChatReadMarkerStore, chatReadThroughAt } from "./chat-read-markers.js";
import type { ChatReadMarkersSnapshot } from "../../renderer/shared/chat-row-state.js";

async function tmpDir(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-read-markers-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("history that predates read tracking never lights up as unread", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatReadMarkerStore(() => root, { now: () => 1_000 });
  assert.equal(await store.isUnread({ id: "old", lastAssistantAt: 900 }), false);
  assert.equal(await store.isUnread({ id: "legacy" }), false);
  assert.equal(await store.isUnread({ id: "new", lastAssistantAt: 1_001 }), true);

  // The baseline is durable: a later process must not move it forward and
  // silently swallow output that arrived while the app was closed.
  const reopened = new ChatReadMarkerStore(() => root, { now: () => 5_000 });
  assert.equal((await reopened.snapshot()).baselineAt, 1_000);
  assert.equal(await reopened.isUnread({ id: "new", lastAssistantAt: 1_001 }), true);
});

test("viewing clears unread until newer assistant output arrives", async (t) => {
  const root = await tmpDir(t);
  const published: ChatReadMarkersSnapshot[] = [];
  const store = new ChatReadMarkerStore(() => root, {
    now: () => 100,
    onChange: (snapshot) => published.push(snapshot),
  });

  assert.equal(await store.markRead("chat-a", 500), true);
  assert.equal(await store.isUnread({ id: "chat-a", lastAssistantAt: 500 }), false);
  assert.equal(await store.isUnread({ id: "chat-a", lastAssistantAt: 501 }), true);

  // A slower surface reporting an older view is a no-op, not a regression.
  assert.equal(await store.markRead("chat-a", 300), false);
  assert.equal((await store.snapshot()).readThrough["chat-a"], 500);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.readThrough["chat-a"], 500);

  const persisted = new ChatReadMarkerStore(() => root);
  assert.equal(await persisted.isUnread({ id: "chat-a", lastAssistantAt: 500 }), false);
});

test("unsafe chat ids and timestamps are refused and removal forgets a chat", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatReadMarkerStore(() => root, { now: () => 10 });
  assert.equal(await store.markRead("../escape", 20), false);
  assert.equal(await store.markRead("chat-a", -1), false);
  assert.equal(await store.markRead("chat-a", 1.5), false);
  assert.deepEqual((await store.snapshot()).readThrough, {});

  await store.markRead("chat-a", 20);
  await store.remove("chat-a");
  assert.deepEqual((await store.snapshot()).readThrough, {});
});

test("a corrupt marker file falls back to a fresh baseline instead of failing", async (t) => {
  const root = await tmpDir(t);
  await fs.writeFile(path.join(root, "chat-read-markers.json"), "{not json");
  const store = new ChatReadMarkerStore(() => root, { now: () => 42 });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.baselineAt, 42);
  assert.deepEqual(snapshot.readThrough, {});
});

test("read-through resolves to the viewed message and never past it", () => {
  const chat = {
    messages: [
      { id: "u1", role: "user", content: "hi", createdAt: 10 },
      { id: "a1", role: "assistant", content: "hello", createdAt: 20 },
      { id: "s1", role: "system", content: "note", createdAt: 99 },
      { id: "a2", role: "assistant", content: "more", createdAt: 30 },
    ],
  } as unknown as Parameters<typeof chatReadThroughAt>[0];
  assert.equal(chatReadThroughAt(chat, "a1"), 20);
  assert.equal(chatReadThroughAt(chat), 30);
  assert.equal(chatReadThroughAt(chat, "missing"), null);
  assert.equal(chatReadThroughAt(chat, "s1"), null);
  assert.equal(chatReadThroughAt({ messages: [] }), null);
});

test("equal-timestamp output uses message order and stale views cannot regress it", async (t) => {
  const root = await tmpDir(t);
  const store = new ChatReadMarkerStore(() => root, { now: () => 100 });
  await store.markRead("chat-a", 500, 1);
  assert.equal(
    await store.isUnread({ id: "chat-a", lastAssistantAt: 500, lastAssistantSequence: 2 }),
    true,
  );
  await store.markRead("chat-a", 500, 2);
  assert.equal(await store.markRead("chat-a", 500, 1), false);
  const reopened = new ChatReadMarkerStore(() => root);
  assert.equal(
    await reopened.isUnread({ id: "chat-a", lastAssistantAt: 500, lastAssistantSequence: 2 }),
    false,
  );
  assert.equal(
    await reopened.isUnread({ id: "chat-a", lastAssistantAt: 500, lastAssistantSequence: 3 }),
    true,
  );
});
