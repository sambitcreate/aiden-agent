import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";

test("bot chats are durable chats excluded only from regular lists", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-bot-chats-"));
  try {
    const store = createChatStore(async () => root);
    const regular = await store.create({ workspaceId: "workspace-1" });
    const bot = await store.create({ workspaceId: "workspace-1", botId: "bot-1" });
    assert.deepEqual((await store.list()).map((chat) => chat.id).sort(), [bot.id, regular.id].sort());
    assert.deepEqual((await store.listRegular("workspace-1")).map((chat) => chat.id), [regular.id]);
    assert.deepEqual((await store.listByBot("bot-1")).map((chat) => chat.id), [bot.id]);
    assert.equal((await store.get(bot.id))?.botId, "bot-1");
    assert.equal((await store.copyVisibleHistory({ sourceChatId: bot.id })).botId, "bot-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
