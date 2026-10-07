import assert from "node:assert/strict";
import test from "node:test";
import { registerPeerIntentHandlers } from "./peer-intents.js";
import { PeerIntentStore, type BoundIntent } from "../services/peer-intent-store.js";
test("saved-request IPC rejects inactive senders and recovers only the requested host/chat", async () => {
  const handlers = new Map<string, (event: boolean, ...args: unknown[]) => unknown>();
  let disk: BoundIntent[] = [];
  const store = new PeerIntentStore({ load: async () => disk, save: async value => { disk = value; } }, async () => "device");
  registerPeerIntentHandlers({ handle: (channel, handler) => handlers.set(channel, handler), active: (active: boolean) => {
    if (!active) throw new Error("Inactive document");
  }, store: () => store });
  const invoke = (channel: string, active: boolean, ...args: unknown[]) => handlers.get(channel)!(active, ...args);
  const saved = { hostId: "host_1", chatId: "chat_1", idempotencyKey: "request_123", createdAt: Date.now(), request: { kind: "send", input: { text: "Saved before network", idempotencyKey: "request_123" } } };
  assert.throws(() => invoke("remote:peerIntentsPut", false, saved), /Inactive/);
  await invoke("remote:peerIntentsPut", true, saved);
  assert.deepEqual(await invoke("remote:peerIntentsList", true, "host_2", "chat_1"), []);
  assert.equal((await invoke("remote:peerIntentsList", true, "host_1", "chat_1") as unknown[]).length, 1);
  await invoke("remote:peerIntentsRemove", true, "host_1", "chat_1", "request_123");
  assert.deepEqual(await invoke("remote:peerIntentsList", true, "host_1", "chat_1"), []);
});
