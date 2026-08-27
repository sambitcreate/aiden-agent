import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";

test("clone and fork copy visible linear history with fresh identities", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-copy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({
    title: "Visible session",
    workspaceId: "workspace-copy",
    providerId: "provider-copy",
    model: "model-copy",
  });
  await store.appendMessage(chat.id, { role: "system", content: "PRIVATE SYSTEM STATE" });
  await store.appendMessage(chat.id, {
    role: "user",
    content: "First request",
    skill: { version: 1, name: "Review", source: "workspace" },
    attachments: [{
      id: "attachment-one",
      name: "note.txt",
      mimeType: "text/plain",
      kind: "text",
      size: 4,
      text: "note",
    }],
  });
  const firstTurn = await store.appendMessage(chat.id, {
    role: "assistant",
    content: "First response",
    reasoning: "PRIVATE REASONING",
    providerFailure: {
      version: 1,
      category: "network",
      attempts: 2,
      retryExhausted: true,
    },
  });
  await store.appendMessage(chat.id, { role: "user", content: "Second request" });
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Second response",
    reasoning: "MORE PRIVATE REASONING",
  });
  const source = await store.get(chat.id);
  assert.ok(source);
  const firstAssistant = firstTurn.messages.find((message) => message.role === "assistant");
  assert.ok(firstAssistant);

  const clone = await store.copyVisibleHistory({ sourceChatId: chat.id });
  const fork = await store.copyVisibleHistory({
    sourceChatId: chat.id,
    expectedWorkspaceId: "workspace-copy",
    throughAssistantMessageId: firstAssistant.id,
  });
  assert.deepEqual(clone.messages.map(({ role, content }) => [role, content]), [
    ["user", "First request"],
    ["assistant", "First response"],
    ["user", "Second request"],
    ["assistant", "Second response"],
  ]);
  assert.deepEqual(fork.messages.map(({ role, content }) => [role, content]), [
    ["user", "First request"],
    ["assistant", "First response"],
  ]);
  assert.equal(clone.workspaceId, "workspace-copy");
  assert.equal(clone.providerId, "provider-copy");
  assert.equal(clone.model, "model-copy");
  assert.equal(
    clone.messages.some((message) => source.messages.some((entry) => entry.id === message.id)),
    false,
  );
  assert.ok(clone.messages.every((message) => message.reasoning === undefined));
  assert.ok(clone.messages.every((message) => message.timeline === undefined));
  assert.ok(clone.messages.every((message) => message.subagents === undefined));
  assert.deepEqual(clone.messages[1]?.providerFailure, {
    version: 1,
    category: "network",
    attempts: 2,
    retryExhausted: true,
  });
  assert.deepEqual(fork.messages[1]?.providerFailure, clone.messages[1]?.providerFailure);
  const restarted = createChatStore(async () => directory);
  assert.deepEqual(
    (await restarted.get(clone.id))?.messages[1]?.providerFailure,
    clone.messages[1]?.providerFailure,
  );
  assert.deepEqual(clone.messages[0]?.skill, {
    version: 1,
    name: "Review",
    source: "workspace",
  });
  assert.equal(clone.messages[0]?.attachments?.[0]?.name, "note.txt");
  await assert.rejects(
    store.copyVisibleHistory({
      sourceChatId: chat.id,
      throughAssistantMessageId: source.messages.find((message) => message.role === "user")?.id,
    }),
    /completed assistant turn/iu,
  );
  await assert.rejects(
    store.copyVisibleHistory({
      sourceChatId: chat.id,
      expectedWorkspaceId: "stale-workspace",
    }),
    /workspace changed/iu,
  );
});

test("bulk copies use collision-resistant identities even when Math.random repeats", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-copy-ids-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Bulk copy", workspaceId: "workspace-copy" });
  const storedPath = path.join(directory, `${chat.id}.json`);
  const stored = JSON.parse(await fs.readFile(storedPath, "utf8")) as typeof chat;
  stored.messages = Array.from({ length: 10_000 }, (_, index) => ({
    id: `source-${index}`,
    role: "user" as const,
    content: "",
    createdAt: index,
  }));
  await fs.writeFile(storedPath, JSON.stringify(stored), "utf8");

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const copied = await store.copyVisibleHistory({ sourceChatId: chat.id });
    const copiedIds = copied.messages.map((message) => message.id);
    assert.equal(copiedIds.length, 10_000);
    assert.equal(new Set(copiedIds).size, copiedIds.length);
    assert.ok(copiedIds.every((id) => !id.startsWith("source-")));
    assert.notEqual(copied.id, chat.id);
  } finally {
    Math.random = originalRandom;
  }
});

test("dependent copy preparation fails before the target chat is installed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-copy-prepare-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const source = await store.create({ title: "Prepared copy", workspaceId: "workspace-copy" });
  await store.appendMessage(source.id, { role: "user", content: "Copy me" });
  const targetChatId = "prepared-target";
  let preparedChatId: string | undefined;

  await assert.rejects(
    store.copyVisibleHistory({
      sourceChatId: source.id,
      targetChatId,
      beforeInstall: (copy) => {
        preparedChatId = copy.id;
        throw new Error("artifact preparation failed");
      },
    }),
    /artifact preparation failed/iu,
  );

  assert.equal(preparedChatId, targetChatId);
  assert.equal(await store.get(targetChatId), null);
  assert.equal((await store.list()).some((chat) => chat.id === targetChatId), false);
});

test("copy rejects malformed visible fields and unbounded retained metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-copy-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Invalid copy", workspaceId: "workspace-copy" });
  const storedPath = path.join(directory, `${chat.id}.json`);
  const stored = JSON.parse(await fs.readFile(storedPath, "utf8")) as Record<string, unknown>;
  stored.messages = [{
    id: "bad",
    role: "user",
    content: "visible",
    createdAt: { reasoning: "PRIVATE" },
  }];
  await fs.writeFile(storedPath, JSON.stringify(stored), "utf8");
  await assert.rejects(
    store.copyVisibleHistory({ sourceChatId: chat.id }),
    /timestamp/iu,
  );

  stored.messages = [];
  stored.providerId = "p".repeat(2_048);
  await fs.writeFile(storedPath, JSON.stringify(stored), "utf8");
  await assert.rejects(
    store.copyVisibleHistory({ sourceChatId: chat.id }),
    /provider identifier/iu,
  );
});
