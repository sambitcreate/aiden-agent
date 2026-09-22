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
    const copied = await store.copyVisibleHistory({
      sourceChatId: bot.id,
      targetChatId: "bot-chat-copy-1",
      expectedWorkspaceId: "workspace-1",
      targetWorkspaceId: "managed-home-1",
    });
    assert.equal(copied.id, "bot-chat-copy-1");
    assert.equal(copied.botId, "bot-1");
    assert.equal(copied.workspaceId, "managed-home-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a main-owned Bot opening greeting is copied once into a new chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-bot-greeting-"));
  try {
    const store = createChatStore(async () => root);
    const chat = await store.create({
      workspaceId: "managed-home-1",
      botId: "bot-1",
      title: "Researcher",
      initialAssistantMessage: "  What should we explore?  ",
    });
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0]?.role, "assistant");
    assert.equal(chat.messages[0]?.content, "What should we explore?");
    const persisted = await store.get(chat.id);
    assert.equal(persisted?.messages[0]?.content, "What should we explore?");
    await assert.rejects(
      store.create({
        workspaceId: "managed-home-1",
        botId: "bot-1",
        initialAssistantMessage: "bad-\ud800-tail",
      }),
      /Invalid initial Bot greeting/u,
    );
    assert.equal((await store.listByBot("bot-1")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bot list metadata maintains only one bounded visible-message preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-bot-preview-"));
  try {
    const store = createChatStore(async () => root);
    const chat = await store.create({
      workspaceId: "managed-home-1",
      botId: "bot-1",
      initialAssistantMessage: "How can I help?",
    });
    assert.equal((await store.listByBot("bot-1"))[0]?.preview, "How can I help?");

    await store.appendMessage(chat.id, {
      role: "user",
      content: `latest ${"x".repeat(3_000)}`,
    });
    const metadata = (await store.listByBot("bot-1"))[0];
    assert.equal(metadata?.preview?.startsWith("latest "), true);
    assert.equal(Array.from(metadata?.preview ?? "").length, 500);
    assert.equal("messages" in (metadata ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
