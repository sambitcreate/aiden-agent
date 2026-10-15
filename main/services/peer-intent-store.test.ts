import assert from "node:assert/strict";
import test from "node:test";
import { PeerIntentStore, type BoundIntent } from "./peer-intent-store.js";
import type { SavedChatIntent } from "../../renderer/shared/chat-intent.js";
const intent: SavedChatIntent = { hostId: "host_1", chatId: "chat_1", idempotencyKey: "request_123", createdAt: 1_800_000_000_000,
  request: { kind: "send", input: { text: "Hello", idempotencyKey: "request_123" } } };

test("saved requests isolate chats and pairings and refuse mutation of an existing attempt", async () => {
  let rows: BoundIntent[] = [];
  let identity: string | null = "device_1";
  const store = new PeerIntentStore({ load: async () => structuredClone(rows), save: async value => { rows = structuredClone(value); } }, async () => identity);
  await store.put(intent);
  assert.equal((await store.list("host_1", "chat_1"))[0]?.request.kind, "send");
  assert.deepEqual(await store.list("host_1", "chat_2"), []);
  await assert.rejects(store.put({ ...intent, createdAt: intent.createdAt + 1 }), /cannot be changed/);
  identity = "device_2";
  assert.deepEqual(await store.list("host_1", "chat_1"), []);
  assert.equal(rows.length, 0);
  identity = null;
  await assert.rejects(store.put(intent), /Pair this computer/);
});

test("concurrent saves preserve both attempts and a failed write preserves prior recovery state", async () => {
  let rows: BoundIntent[] = [];
  let fail = false;
  const store = new PeerIntentStore({ load: async () => structuredClone(rows), save: async value => {
    if (fail) throw new Error("Disk full");
    rows = structuredClone(value);
  } }, async () => "device_1");
  await Promise.all([store.put(intent), store.put({ ...intent, chatId: "chat_2" })]);
  assert.equal(rows.length, 2);
  fail = true;
  await assert.rejects(store.remove("host_1", "chat_1", "request_123"), /Disk full/);
  assert.equal((await store.list("host_1", "chat_1")).length, 1);
});

test("network admission binds the exact saved request and rejects altered text or target", async () => {
  let rows: BoundIntent[] = [];
  const store = new PeerIntentStore({ load: async () => structuredClone(rows), save: async value => { rows = structuredClone(value); } }, async () => "device_1");
  const saved = { ...intent, createdAt: Date.now() };
  await store.put(saved);
  assert.equal(await store.admissionIdentity("host_1", { operation: "send", resourceId: "chat_1", body: { text: "Hello" }, idempotencyKey: "request_123" }), "device_1");
  await assert.rejects(store.admissionIdentity("host_1", { operation: "send", resourceId: "chat_1", body: { text: "A different message" }, idempotencyKey: "request_123" }), /cannot be changed/);
  await assert.rejects(store.admissionIdentity("host_1", { operation: "send", resourceId: "chat_2", body: { text: "Hello" }, idempotencyKey: "request_123" }), /cannot be changed/);
  assert.equal((await store.list("host_1", "chat_1")).length, 1, "failed admission preserves the original uncertainty");
});
