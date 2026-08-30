import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChatActivityRegistry } from "./chat-activity-core.js";

test("chat activity publishes only visible per-chat transitions", () => {
  const snapshots: ReturnType<ChatActivityRegistry["snapshot"]>[] = [];
  const registry = new ChatActivityRegistry((snapshot) => snapshots.push(snapshot));

  registry.begin("stream-a", "chat-a");
  registry.begin("stream-a", "chat-a");
  registry.begin("stream-b", "chat-a");
  registry.settle("stream-a");
  registry.settle("missing");

  assert.deepEqual(snapshots, [{ revision: 1, activeChatIds: ["chat-a"] }]);
  assert.deepEqual(registry.snapshot(), { revision: 1, activeChatIds: ["chat-a"] });

  registry.settle("stream-b");
  assert.deepEqual(snapshots[snapshots.length - 1], { revision: 2, activeChatIds: [] });
});

test("reusing a stream id settles its old chat before activating the new chat", () => {
  const snapshots: ReturnType<ChatActivityRegistry["snapshot"]>[] = [];
  const registry = new ChatActivityRegistry((snapshot) => snapshots.push(snapshot));

  registry.begin("stream-a", "chat-a");
  registry.begin("stream-a", "chat-b");

  assert.deepEqual(snapshots, [
    { revision: 1, activeChatIds: ["chat-a"] },
    { revision: 2, activeChatIds: [] },
    { revision: 3, activeChatIds: ["chat-b"] },
  ]);
});

test("activity snapshots never silently omit concurrently active chats", () => {
  const registry = new ChatActivityRegistry(() => undefined);

  for (let index = 0; index < 257; index += 1) {
    registry.begin(`stream-${index}`, `chat-${index}`);
  }

  const snapshot = registry.snapshot();
  assert.equal(snapshot.activeChatIds.length, 257);
  assert.equal(snapshot.activeChatIds[256], "chat-256");
});

test("generation ownership wires activity start, settlement, and reload snapshot", () => {
  const llm = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const handlers = readFileSync(new URL("../handlers/chats.ts", import.meta.url), "utf8");
  const settlement = llm.slice(
    llm.indexOf("function broadcastChatSettled"),
    llm.indexOf("function ownerForStream"),
  );

  assert.match(
    llm,
    /initializing\.set\(streamId, initialization\);\s*chatActivityRegistry\.begin\(streamId, params\.chatId\);/u,
  );
  assert.match(settlement, /chatActivityRegistry\.settle\(streamId\);/u);
  assert.match(settlement, /ipcMain\.broadcast\("chats:settled"/u);
  assert.equal(
    (llm.match(/broadcastChatSettled\(\s*streamId,\s*params\.chatId,/gu) ?? []).length,
    7,
  );
  assert.match(
    handlers,
    /ipcMain\.handle\(\s*"chats:activitySnapshot",\s*\(\)\s*=>\s*chatActivityRegistry\.snapshot\(\),?\s*\)/u,
  );
});
