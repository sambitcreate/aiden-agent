import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";

async function testStore(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return createChatStore(async () => directory);
}

test("seeds only the first user message and preserves a manual rename", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ workspaceId: "workspace" });
  const seeded = await store.appendMessage(
    chat.id,
    { role: "user", content: "Investigate reconnect failures after restart" },
    { autoTitle: true, providerId: "openai", model: "gpt-test" },
  );
  assert.equal(seeded.title, "Investigate reconnect failures after restart");

  await store.rename(chat.id, "Keep my title");
  const replaced = await store.replaceAutoTitle(
    chat.id,
    seeded.title,
    "Reconnect failure investigation",
  );
  assert.equal(replaced, null);
  assert.equal((await store.get(chat.id))?.title, "Keep my title");
});

test("serializes assistant persistence with a background title update", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({});
  const seeded = await store.appendMessage(
    chat.id,
    { role: "user", content: "Improve the title flow" },
    { autoTitle: true },
  );

  await Promise.all([
    store.appendMessage(chat.id, { role: "assistant", content: "I can help with that." }),
    store.replaceAutoTitle(chat.id, seeded.title, "Improve Chat Title Flow"),
  ]);

  const updated = await store.get(chat.id);
  assert.equal(updated?.title, "Improve Chat Title Flow");
  assert.deepEqual(
    updated?.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("persists reasoning only on assistant messages", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({});
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Final answer.",
    reasoning: "Compare the available options.",
  });
  await store.appendMessage(chat.id, {
    role: "user",
    content: "A renderer cannot attach reasoning here.",
    reasoning: "Spoofed reasoning",
  });

  const updated = await store.get(chat.id);
  assert.equal(updated?.messages[0]?.reasoning, "Compare the available options.");
  assert.equal(updated?.messages[1]?.reasoning, undefined);
});

test("persists safe assistant milestones and drops invalid timeline data", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({});
  const timeline: GenerationTimeline = {
    version: 2,
    generationId: "generation-1",
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    steps: [
      {
        id: "tool-1",
        order: 0,
        kind: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        label: "Read file",
        status: "completed",
        startedAt: 11,
        updatedAt: 12,
        finishedAt: 12,
        target: "src/index.ts",
      },
    ],
  };

  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Done.",
    timeline,
  });
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Unsafe data is ignored.",
    timeline: {
      ...timeline,
      steps: [{ ...timeline.steps[0], target: "/Users/person/private.txt" }],
    } as GenerationTimeline,
  });
  await store.appendMessage(chat.id, {
    role: "user",
    content: "A renderer cannot attach milestones here.",
    timeline,
  });

  const updated = await store.get(chat.id);
  assert.deepEqual(updated?.messages[0]?.timeline, timeline);
  assert.equal(updated?.messages[1]?.timeline, undefined);
  assert.equal(updated?.messages[2]?.timeline, undefined);
});

test("drops a timeline injected into a stored non-assistant message", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-store-tampered-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({});
  const timeline: GenerationTimeline = {
    version: 2,
    generationId: "generation-1",
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    steps: [],
  };
  await fs.writeFile(
    path.join(directory, `${chat.id}.json`),
    JSON.stringify({
      ...chat,
      messages: [
        {
          id: "tampered-user",
          role: "user",
          content: "Hello",
          createdAt: 10,
          timeline,
        },
      ],
    }),
    "utf-8",
  );

  assert.equal((await store.get(chat.id))?.messages[0]?.timeline, undefined);
});

test("an explicit generated rename preserves a newer manual title", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ title: "Original title" });

  await store.rename(chat.id, "Manual title wins");
  const replaced = await store.replaceTitleIfUnchanged(
    chat.id,
    "Original title",
    "Generated Apple title",
  );

  assert.equal(replaced, null);
  assert.equal((await store.get(chat.id))?.title, "Manual title wins");
});

test("preserves every index entry during concurrent chat creation", async (t) => {
  const store = await testStore(t);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) => store.create({ title: `Chat ${index}` })),
  );
  const chats = await store.list();
  assert.equal(chats.length, 12);
  assert.equal(new Set(chats.map((chat) => chat.id)).size, 12);
});

test("loads legacy Gemini chat identities through the native Google provider", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-google-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chat = {
    id: "legacy-chat",
    title: "Legacy Gemini",
    workspaceId: "default",
    providerId: "gemini",
    model: "gemini-2.5-pro",
    createdAt: 10,
    updatedAt: 20,
    messages: [],
  };
  await fs.writeFile(path.join(directory, "index.json"), JSON.stringify([chat]), "utf-8");
  await fs.writeFile(path.join(directory, "legacy-chat.json"), JSON.stringify(chat), "utf-8");
  const store = createChatStore(async () => directory);

  assert.equal((await store.list())[0]?.providerId, "google");
  assert.equal((await store.get("legacy-chat"))?.providerId, "google");
});

test("moves an empty chat between workspace lists", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ workspaceId: "first" });

  const moved = await store.moveEmptyChatToWorkspace(chat.id, "second");

  assert.equal(moved.workspaceId, "second");
  assert.equal((await store.list("first")).length, 0);
  assert.deepEqual(
    (await store.list("second")).map((entry) => entry.id),
    [chat.id],
  );
});

test("does not move a chat after its conversation has started", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ workspaceId: "first" });
  await store.appendMessage(chat.id, { role: "user", content: "Keep this chat here" });

  await assert.rejects(
    store.moveEmptyChatToWorkspace(chat.id, "second"),
    /Only a new chat can change workspaces/,
  );
  assert.equal((await store.get(chat.id))?.workspaceId, "first");
});

test("persists Computer Use per chat without reordering the chat index", async (t) => {
  const store = await testStore(t);
  const older = await store.create({ title: "Older" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newer = await store.create({ title: "Newer" });

  const enabled = await store.setComputerUseEnabled(older.id, true);
  assert.equal(enabled.computerUseEnabled, true);
  assert.equal((await store.get(older.id))?.computerUseEnabled, true);
  assert.deepEqual(
    (await store.list()).map((chat) => chat.id),
    [newer.id, older.id],
  );

  const disabled = await store.setComputerUseEnabled(older.id, false);
  assert.equal(disabled.computerUseEnabled, false);
});

test("a stale renderer guard cannot persist a per-chat Computer Use opt-in", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ title: "Guarded" });

  await assert.rejects(
    store.setComputerUseEnabled(chat.id, true, () => false),
    /no longer active/u,
  );
  assert.equal((await store.get(chat.id))?.computerUseEnabled, undefined);
});

test("a renderer replaced while a per-chat opt-in is staged cannot commit it", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ title: "Guarded during write" });
  let checks = 0;

  await assert.rejects(
    store.setComputerUseEnabled(chat.id, true, () => {
      checks += 1;
      return checks === 1;
    }),
    /no longer active/u,
  );
  assert.equal(checks, 2);
  assert.equal((await store.get(chat.id))?.computerUseEnabled, undefined);
});
