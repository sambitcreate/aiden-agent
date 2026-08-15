import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  ChatCreateReconciliationRequiredError,
  createChatStore,
} from "./chat-store-core.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type { SubagentMessageReferenceV1 } from "../../renderer/shared/subagent-runs.js";

async function testStore(t: test.TestContext) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-store-"),
  );
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
    store.appendMessage(chat.id, {
      role: "assistant",
      content: "I can help with that.",
    }),
    store.replaceAutoTitle(chat.id, seeded.title, "Improve Chat Title Flow"),
  ]);

  const updated = await store.get(chat.id);
  assert.equal(updated?.title, "Improve Chat Title Flow");
  assert.deepEqual(
    updated?.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("persists canonical Pi assistant provenance across restart and visible-history copy", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-pi-provenance-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = createChatStore(async () => directory);
  const chat = await first.create({ providerId: "google", model: "new-model" });
  await first.appendMessage(chat.id, {
    role: "user",
    content: "Remember provider history",
  });
  const saved = await first.appendMessage(chat.id, {
    role: "assistant",
    content: "Historical answer",
    model: "claude-old",
    reasoning: "Historical reasoning",
    pi: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Historical reasoning" },
        { type: "text", text: "Historical answer" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-old",
      responseId: "response-old",
      usage: {
        input: 8,
        output: 4,
        cacheRead: 1,
        cacheWrite: 2,
        cacheWrite1h: 1,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 20,
    },
  });
  const assistantId = saved.messages[saved.messages.length - 1]!.id;

  const restarted = createChatStore(async () => directory);
  const restored = await restarted.get(chat.id);
  assert.equal(restored?.messages[1]?.pi?.provider, "anthropic");
  assert.equal(restored?.messages[1]?.pi?.api, "anthropic-messages");
  assert.equal(restored?.messages[1]?.pi?.responseId, "response-old");
  const copied = await restarted.copyVisibleHistory({
    sourceChatId: chat.id,
    throughAssistantMessageId: assistantId,
  });
  assert.equal(copied.messages[1]?.pi?.model, "claude-old");
  assert.equal(copied.messages[1]?.reasoning, "Historical reasoning");
});

test("chat payload writes are atomic when staged-file sync fails", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-sync-failure-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let rejectPayloadSync = false;
  const store = createChatStore(async () => directory, undefined, {
    syncFile: async (target) => {
      if (rejectPayloadSync && target.endsWith(".chat-write.tmp")) {
        throw new Error("injected payload sync failure");
      }
    },
    syncDirectory: async () => undefined,
  });
  const chat = await store.create({ title: "Atomic payload" });
  const payload = path.join(directory, `${chat.id}.json`);
  const before = await fs.readFile(payload, "utf-8");

  rejectPayloadSync = true;
  await assert.rejects(
    store.appendMessage(chat.id, {
      role: "assistant",
      content: "must not install",
    }),
    /injected payload sync failure/u,
  );
  rejectPayloadSync = false;

  assert.equal(await fs.readFile(payload, "utf-8"), before);
  assert.equal((await store.get(chat.id))?.messages.length, 0);
  assert.equal(
    (await fs.readdir(directory)).some((entry) =>
      entry.endsWith(".chat-write.tmp"),
    ),
    false,
  );
});

test("post-rename directory sync failure never publishes a partial chat or advances the index", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-dir-sync-failure-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let rejectDirectorySyncAt: number | undefined;
  let directorySyncs = 0;
  const store = createChatStore(async () => directory, undefined, {
    syncFile: async () => undefined,
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === rejectDirectorySyncAt) {
        throw new Error("injected directory sync failure");
      }
    },
  });
  const chat = await store.create({ title: "Durable assistant reference" });
  const indexBefore = await fs.readFile(
    path.join(directory, "index.json"),
    "utf-8",
  );

  // The intent creation has its own durability barrier. Fail the following
  // payload-rename barrier so the installed payload must be reconciled.
  rejectDirectorySyncAt = directorySyncs + 2;
  await assert.rejects(
    store.appendMessage(chat.id, {
      role: "assistant",
      content: "whole message",
      subagents: {
        version: 1,
        generationId: "generation-durable",
        runIds: ["run-durable"],
        total: 1,
        completed: 1,
        failed: 0,
        timedOut: 0,
        interrupted: 0,
      },
    }),
    /injected directory sync failure/u,
  );
  rejectDirectorySyncAt = undefined;

  const installed = JSON.parse(
    await fs.readFile(path.join(directory, `${chat.id}.json`), "utf-8"),
  ) as {
    messages: Array<{ content: string; subagents?: { runIds: string[] } }>;
  };
  assert.equal(installed.messages.length, 1);
  assert.equal(installed.messages[0]?.content, "whole message");
  assert.deepEqual(installed.messages[0]?.subagents?.runIds, ["run-durable"]);
  assert.equal(
    await fs.readFile(path.join(directory, "index.json"), "utf-8"),
    indexBefore,
  );
  assert.equal(
    (await fs.readdir(directory)).some((entry) =>
      entry.endsWith(".chat-write.tmp"),
    ),
    false,
  );
  const syncsBeforeRetry = directorySyncs;
  assert.equal(
    (await store.get(chat.id))?.messages[0]?.content,
    "whole message",
  );
  assert.ok(directorySyncs > syncsBeforeRetry);
});

test("chat payloads use owner-only mode and leave no staging files", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-payload-mode-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Private payload" });
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "persisted",
  });

  assert.equal(
    (await fs.stat(path.join(directory, `${chat.id}.json`))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await fs.readdir(directory)).some((entry) =>
      entry.endsWith(".chat-write.tmp"),
    ),
    false,
  );
});

test("create reconciles a newly installed payload after a transient index installation failure", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-create-recovery-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let remainingIndexFailures = 1;
  const interrupted = createChatStore(async () => directory, undefined, {
    syncDirectory: async () => undefined,
    syncFile: async (target) => {
      if (remainingIndexFailures > 0 && target.endsWith(".index-write.tmp")) {
        remainingIndexFailures -= 1;
        throw new Error("injected index installation failure");
      }
    },
  });
  const created = await interrupted.create({ title: "Recovered create" });
  const listed = await interrupted.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);
  assert.equal(listed[0]?.title, "Recovered create");
  assert.equal(
    (await fs.readdir(directory)).some((entry) => entry.endsWith(".pending")),
    false,
  );
});

test("create reconciles a payload installed before a transient directory-sync failure", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-create-payload-recovery-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let directorySyncs = 0;
  let rejectAt = 2;
  const store = createChatStore(async () => directory, undefined, {
    syncFile: async () => undefined,
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === rejectAt) {
        rejectAt = -1;
        throw new Error("injected payload directory sync failure");
      }
    },
  });

  const created = await store.create({ title: "Recovered payload create" });
  assert.equal((await store.get(created.id))?.id, created.id);
  assert.equal((await store.list())[0]?.id, created.id);
  assert.equal(
    (await fs.readdir(directory)).some((entry) => entry.endsWith(".pending")),
    false,
  );
});

test("create reports a private reconciliation error when installed metadata cannot be repaired", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-create-indeterminate-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory, undefined, {
    syncDirectory: async () => undefined,
    syncFile: async (target) => {
      if (target.endsWith(".index-write.tmp")) {
        throw new Error("persistent index installation failure");
      }
    },
  });

  await assert.rejects(
    store.create({ title: "Indeterminate create" }),
    (error: unknown) => error instanceof ChatCreateReconciliationRequiredError,
  );
  assert.equal(
    (await fs.readdir(directory)).some((entry) => entry.endsWith(".pending")),
    true,
  );
});

test("transaction intent reconciles title metadata after payload commit", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-title-recovery-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let failIndexSync = false;
  const interrupted = createChatStore(async () => directory, undefined, {
    syncDirectory: async () => undefined,
    syncFile: async (target) => {
      if (failIndexSync && target.endsWith(".index-write.tmp")) {
        throw new Error("injected title index failure");
      }
    },
  });
  const chat = await interrupted.create({ title: "Before rename" });
  failIndexSync = true;
  await assert.rejects(
    interrupted.rename(chat.id, "After rename"),
    /injected title index failure/u,
  );

  const restarted = createChatStore(async () => directory);
  const listed = await restarted.list();
  assert.equal(
    listed.find((entry) => entry.id === chat.id)?.title,
    "After rename",
  );
  assert.equal((await restarted.get(chat.id))?.title, "After rename");
});

test("transaction intent preserves assistant subagent references and index time", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-reference-recovery-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let failIndexSync = false;
  const interrupted = createChatStore(async () => directory, undefined, {
    syncDirectory: async () => undefined,
    syncFile: async (target) => {
      if (failIndexSync && target.endsWith(".index-write.tmp")) {
        throw new Error("injected reference index failure");
      }
    },
  });
  const chat = await interrupted.create({ title: "Reference recovery" });
  const subagents: SubagentMessageReferenceV1 = {
    version: 1,
    generationId: "generation-recovery",
    runIds: ["run-recovery"],
    total: 1,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
  failIndexSync = true;
  await assert.rejects(
    interrupted.appendMessage(chat.id, {
      role: "assistant",
      content: "Recovered assistant",
      subagents,
    }),
    /injected reference index failure/u,
  );

  const restarted = createChatStore(async () => directory);
  const persisted = await restarted.get(chat.id);
  const listed = await restarted.list();
  assert.deepEqual(persisted?.messages[0]?.subagents, subagents);
  assert.equal(
    listed.find((entry) => entry.id === chat.id)?.updatedAt,
    persisted?.updatedAt,
  );
  assert.equal(
    (await fs.readdir(directory)).some((entry) => entry.endsWith(".pending")),
    false,
  );
});

test("transaction intent removes same-id metadata for a mismatched payload before clearing", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-transaction-mismatch-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Mismatched pending payload" });
  const transaction = path.join(
    directory,
    `.chat-transaction.${chat.id}.pending`,
  );
  await fs.writeFile(
    path.join(directory, `${chat.id}.json`),
    JSON.stringify({ ...chat, id: "different-chat-id" }),
    "utf-8",
  );
  await fs.writeFile(transaction, "1\n", { encoding: "utf-8", mode: 0o600 });

  const restarted = createChatStore(async () => directory);
  assert.deepEqual(await restarted.list(), []);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf-8")),
    [],
  );
  await assert.rejects(fs.access(transaction));
});

test("transaction reconciliation preserves its marker and index on operational payload reads", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-transaction-io-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const initial = createChatStore(async () => directory);
  const chat = await initial.create({ title: "Retry pending payload read" });
  const payload = path.join(directory, `${chat.id}.json`);
  const transaction = path.join(
    directory,
    `.chat-transaction.${chat.id}.pending`,
  );
  await fs.writeFile(transaction, "1\n", { encoding: "utf-8", mode: 0o600 });
  const indexBefore = await fs.readFile(
    path.join(directory, "index.json"),
    "utf-8",
  );
  let failPayloadRead = true;
  const restarted = createChatStore(async () => directory, undefined, {
    readFile: async (target) => {
      if (failPayloadRead && target === payload) {
        const error = new Error(
          "injected transaction payload read failure",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return fs.readFile(target, "utf-8");
    },
  });

  await assert.rejects(restarted.list(), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "EIO";
  });
  assert.equal(
    await fs.readFile(path.join(directory, "index.json"), "utf-8"),
    indexBefore,
  );
  await fs.access(transaction);

  failPayloadRead = false;
  assert.deepEqual(
    (await restarted.list()).map((entry) => entry.id),
    [chat.id],
  );
  await assert.rejects(fs.access(transaction));
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
  assert.equal(
    updated?.messages[0]?.reasoning,
    "Compare the available options.",
  );
  assert.equal(updated?.messages[1]?.reasoning, undefined);
});

test("persists only normalized user skill provenance", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({});
  await store.appendMessage(chat.id, {
    role: "user",
    content: "Review this.",
    skill: { version: 1, name: "Review", source: "workspace" },
  });
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Done.",
    skill: { version: 1, name: "Spoofed", source: "global" },
  });
  await store.appendMessage(chat.id, {
    role: "user",
    content: "Malformed marker.",
    skill: { version: 1, name: "Bad\nName", source: "configured" },
  });
  const updated = await store.get(chat.id);
  assert.deepEqual(updated?.messages[0]?.skill, {
    version: 1,
    name: "Review",
    source: "workspace",
  });
  assert.equal(updated?.messages[1]?.skill, undefined);
  assert.equal(updated?.messages[2]?.skill, undefined);
});

test("renderer ownership is checked again at the atomic append commit", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-owner-guard-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let current = true;
  const store = createChatStore(async () => directory, undefined, {
    syncFile: async (target) => {
      if (target.endsWith(".chat-write.tmp")) current = false;
    },
    syncDirectory: async () => undefined,
  });
  const chat = await store.create({});
  current = true;
  await assert.rejects(
    store.appendMessage(
      chat.id,
      { role: "user", content: "Must not commit" },
      { isCurrent: () => current },
    ),
    /no longer active/iu,
  );
  current = true;
  assert.deepEqual((await store.get(chat.id))?.messages, []);
});

test("chat creation rechecks renderer authority at its atomic commit", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-create-owner-guard-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let current = true;
  const store = createChatStore(async () => directory, undefined, {
    syncFile: async (target) => {
      if (target.endsWith(".chat-write.tmp")) current = false;
    },
    syncDirectory: async () => undefined,
  });
  await assert.rejects(
    store.create({
      title: "Must not commit",
      assertCurrent: () => {
        if (!current)
          throw new Error("The renderer document is no longer active.");
      },
    }),
    /no longer active/iu,
  );
  assert.deepEqual(await store.list(), []);
});

test("persists only strict bounded subagent references on assistant messages", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({});
  const subagents: SubagentMessageReferenceV1 = {
    version: 1,
    generationId: "generation-1",
    runIds: ["run-1"],
    total: 1,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Reviewed.",
    subagents,
  });
  await store.appendMessage(chat.id, {
    role: "user",
    content: "A renderer cannot attach child history here.",
    subagents,
  });
  await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Malformed.",
    subagents: { ...subagents, completed: 0 },
  });
  const privateIds = [
    "sk-abcdefghijklmno",
    "c2stYWJjZGVmZ2hpamtsbW5v",
    "ONVS2YLCMNSGKZTHNBUWU23MNVXG6",
    "run-c2stYWJjZGVmZ2hpamtsbW5v-suffix",
  ];
  for (const privateId of privateIds) {
    await store.appendMessage(chat.id, {
      role: "assistant",
      content: "Private generation identifier.",
      subagents: { ...subagents, generationId: privateId },
    });
    await store.appendMessage(chat.id, {
      role: "assistant",
      content: "Private run identifier.",
      subagents: { ...subagents, runIds: [privateId] },
    });
  }

  const updated = await store.get(chat.id);
  assert.deepEqual(updated?.messages[0]?.subagents, subagents);
  assert.equal(updated?.messages[1]?.subagents, undefined);
  assert.equal(updated?.messages[2]?.subagents, undefined);
  for (const message of updated?.messages.slice(3) ?? []) {
    assert.equal(message.subagents, undefined);
  }
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
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-store-tampered-"),
  );
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
          instructions: "PRIVATE INSTRUCTIONS",
          path: "/private/SKILL.md",
          skill: {
            version: 1,
            name: "Review",
            source: "workspace",
            invocationId: "private",
          },
          attachments: [
            {
              id: "attachment-1",
              name: "note.txt",
              mimeType: "text/plain",
              kind: "text",
              size: 4,
              text: "note",
              path: "/private/note.txt",
              instructions: "PRIVATE ATTACHMENT FIELD",
            },
          ],
        },
      ],
    }),
    "utf-8",
  );

  const loaded = (await store.get(chat.id))?.messages[0];
  assert.equal(loaded?.timeline, undefined);
  assert.equal(loaded?.skill, undefined);
  assert.equal(
    "instructions" in (loaded as unknown as Record<string, unknown>),
    false,
  );
  assert.equal("path" in (loaded as unknown as Record<string, unknown>), false);
  assert.deepEqual(loaded?.attachments, [
    {
      id: "attachment-1",
      name: "note.txt",
      mimeType: "text/plain",
      kind: "text",
      size: 4,
      text: "note",
    },
  ]);
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
    Array.from({ length: 12 }, (_, index) =>
      store.create({ title: `Chat ${index}` }),
    ),
  );
  const chats = await store.list();
  assert.equal(chats.length, 12);
  assert.equal(new Set(chats.map((chat) => chat.id)).size, 12);
});

test("removes an indexed chat even when its payload is corrupt", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-corrupt-remove-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Corrupt payload" });
  const payload = path.join(directory, `${chat.id}.json`);
  await fs.writeFile(payload, "{not-json", "utf-8");

  assert.equal(await store.get(chat.id), null);
  await store.remove(chat.id);

  await assert.rejects(fs.access(payload));
  assert.equal(
    (await store.list()).some((entry) => entry.id === chat.id),
    false,
  );
});

test("rejects a valid chat payload whose identity differs from its storage key", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-mismatched-id-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Storage-bound chat" });
  await fs.writeFile(
    path.join(directory, `${chat.id}.json`),
    JSON.stringify({ ...chat, id: "different-chat-id" }),
    "utf-8",
  );

  assert.equal(await store.get(chat.id), null);
});

test("quarantines a corrupt index and reconstructs surviving chats during deletion", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-corrupt-index-remove-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const removed = await store.create({ title: "Remove me" });
  const survivor = await store.create({ title: "Keep me" });
  await fs.writeFile(
    path.join(directory, "index.json"),
    '[{"id":"truncated"',
    "utf-8",
  );

  await store.remove(removed.id);

  await assert.rejects(fs.access(path.join(directory, `${removed.id}.json`)));
  assert.deepEqual(
    (await store.list()).map((entry) => entry.id),
    [survivor.id],
  );
  const entries = await fs.readdir(directory);
  assert.equal(
    entries.some((entry) => /^\.index\.json\..+\.corrupt$/u.test(entry)),
    true,
  );
  assert.equal(
    entries.some((entry) => /\.(?:chat-delete|index-write)\.tmp$/u.test(entry)),
    false,
  );

  const restarted = createChatStore(async () => directory);
  assert.deepEqual(
    (await restarted.list()).map((entry) => entry.id),
    [survivor.id],
  );
});

test("corrupt-index recovery aborts on operational payload reads without publishing an empty index", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-recovery-io-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let rejectedPayload: string | undefined;
  const store = createChatStore(async () => directory, undefined, {
    readFile: async (target) => {
      if (target === rejectedPayload) {
        const error = new Error(
          "injected payload I/O failure",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return fs.readFile(target, "utf-8");
    },
  });
  const chat = await store.create({ title: "Survives transient I/O" });
  const payload = path.join(directory, `${chat.id}.json`);
  const corruptIndex = '[{"id":"truncated"';
  await fs.writeFile(path.join(directory, "index.json"), corruptIndex, "utf-8");
  rejectedPayload = payload;

  await assert.rejects(store.list(), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "EIO";
  });
  assert.equal(
    await fs.readFile(path.join(directory, "index.json"), "utf-8"),
    corruptIndex,
  );
  assert.equal(
    (await fs.readdir(directory)).some((entry) =>
      /^\.index\.json\..+\.corrupt$/u.test(entry),
    ),
    false,
  );

  rejectedPayload = undefined;
  assert.deepEqual(
    (await store.list()).map((entry) => entry.id),
    [chat.id],
  );
});

test("a fully valid index is rebound to same-id payloads and canonical payload metadata", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-valid-index-binding-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const initial = createChatStore(async () => directory);
  const missing = await initial.create({ title: "Missing payload ghost" });
  const mismatched = await initial.create({
    title: "Mismatched payload ghost",
  });
  const survivor = await initial.create({
    title: "Canonical payload title",
    workspaceId: "payload-workspace",
    providerId: "payload-provider",
    model: "payload-model",
  });
  const metadata = (chat: typeof survivor) => {
    const { messages: _messages, ...meta } = chat;
    return meta;
  };
  await fs.rm(path.join(directory, `${missing.id}.json`));
  await fs.writeFile(
    path.join(directory, `${mismatched.id}.json`),
    JSON.stringify({ ...mismatched, id: "different-chat-id" }),
    "utf-8",
  );
  const staleSurvivor = {
    ...metadata(survivor),
    title: "Stale index title",
    workspaceId: "stale-index-workspace",
    providerId: "stale-index-provider",
    model: "stale-index-model",
    updatedAt: survivor.updatedAt - 1,
  };
  await fs.writeFile(
    path.join(directory, "index.json"),
    JSON.stringify([metadata(missing), metadata(mismatched), staleSurvivor]),
    "utf-8",
  );

  const restarted = createChatStore(async () => directory);
  assert.deepEqual(await restarted.list("stale-index-workspace"), []);
  assert.deepEqual(await restarted.list("payload-workspace"), [
    metadata(survivor),
  ]);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf-8")),
    [metadata(survivor)],
  );
  assert.equal(
    (await fs.readdir(directory)).some((entry) =>
      /^\.index\.json\..+\.corrupt$/u.test(entry),
    ),
    false,
  );
});

test("a valid index remains intact when canonical payload validation hits transient I/O", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-valid-index-io-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const initial = createChatStore(async () => directory);
  const chat = await initial.create({ title: "Retry valid index payload" });
  const payload = path.join(directory, `${chat.id}.json`);
  const indexPath = path.join(directory, "index.json");
  const indexBefore = await fs.readFile(indexPath, "utf-8");
  let failPayloadRead = true;
  const restarted = createChatStore(async () => directory, undefined, {
    readFile: async (target) => {
      if (failPayloadRead && target === payload) {
        const error = new Error(
          "injected valid-index payload read failure",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return fs.readFile(target, "utf-8");
    },
  });

  await assert.rejects(restarted.list(), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "EIO";
  });
  assert.equal(await fs.readFile(indexPath, "utf-8"), indexBefore);
  assert.equal(
    (await fs.readdir(directory)).some((entry) =>
      /^\.index\.json\..+\.corrupt$/u.test(entry),
    ),
    false,
  );

  failPayloadRead = false;
  assert.deepEqual(await restarted.list(), [
    {
      id: chat.id,
      title: chat.title,
      workspaceId: chat.workspaceId,
      providerId: chat.providerId,
      model: chat.model,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
  ]);
});

test("mixed-index recovery reconstructs only successfully validated same-id payloads", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-mixed-index-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const missing = await store.create({ title: "Missing payload ghost" });
  const mismatched = await store.create({ title: "Mismatched payload ghost" });
  const survivor = await store.create({ title: "Validated survivor" });
  const metadata = (chat: typeof survivor) => {
    const { messages: _messages, ...meta } = chat;
    return meta;
  };
  await fs.rm(path.join(directory, `${missing.id}.json`));
  await fs.writeFile(
    path.join(directory, `${mismatched.id}.json`),
    JSON.stringify({ ...mismatched, id: "different-chat-id" }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(directory, "index.json"),
    JSON.stringify([
      metadata(missing),
      metadata(mismatched),
      metadata(survivor),
      { id: false, title: "invalid entry" },
    ]),
    "utf-8",
  );

  assert.deepEqual(
    (await store.list()).map((entry) => entry.id),
    [survivor.id],
  );
  assert.deepEqual(
    (
      JSON.parse(
        await fs.readFile(path.join(directory, "index.json"), "utf-8"),
      ) as Array<{
        id: string;
      }>
    ).map((entry) => entry.id),
    [survivor.id],
  );
});

test("keeps the chat index when payload removal fails operationally", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-remove-failure-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Keep indexed" });
  const payload = path.join(directory, `${chat.id}.json`);
  await fs.rm(payload);
  await fs.mkdir(payload);

  await assert.rejects(store.remove(chat.id));

  assert.equal((await fs.stat(payload)).isDirectory(), true);
  await assert.rejects(store.list(), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "EISDIR";
  });
  assert.equal(
    (
      JSON.parse(
        await fs.readFile(path.join(directory, "index.json"), "utf-8"),
      ) as Array<{
        id: string;
      }>
    ).some((entry) => entry.id === chat.id),
    true,
  );
});

test("rejects a traversal-shaped chat id before removing any payload", async (t) => {
  const store = await testStore(t);
  await assert.rejects(store.remove("../outside"), /Invalid chat id/u);
});

test("loads legacy Gemini chat identities through the native Google provider", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-google-migration-"),
  );
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
  await fs.writeFile(
    path.join(directory, "index.json"),
    JSON.stringify([chat]),
    "utf-8",
  );
  await fs.writeFile(
    path.join(directory, "legacy-chat.json"),
    JSON.stringify(chat),
    "utf-8",
  );
  const store = createChatStore(async () => directory);

  assert.equal((await store.list())[0]?.providerId, "google");
  assert.equal((await store.get("legacy-chat"))?.providerId, "google");
});

test("persists a protected custom alias for historical chats", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aiden-chat-provider-alias-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chat = {
    id: "legacy-openai-chat",
    title: "Work gateway",
    workspaceId: "default",
    providerId: "openai",
    model: "work-model",
    createdAt: 10,
    updatedAt: 20,
    messages: [],
  };
  await fs.writeFile(
    path.join(directory, "index.json"),
    JSON.stringify([chat]),
    "utf-8",
  );
  await fs.writeFile(
    path.join(directory, "legacy-openai-chat.json"),
    JSON.stringify(chat),
    "utf-8",
  );
  const store = createChatStore(
    async () => directory,
    async (providerId) =>
      providerId === "openai" ? "custom:openai-legacy" : providerId,
  );

  assert.equal((await store.list())[0]?.providerId, "custom:openai-legacy");
  assert.equal((await store.get(chat.id))?.providerId, "custom:openai-legacy");
  const index = JSON.parse(
    await fs.readFile(path.join(directory, "index.json"), "utf-8"),
  ) as (typeof chat)[];
  const stored = JSON.parse(
    await fs.readFile(path.join(directory, "legacy-openai-chat.json"), "utf-8"),
  ) as typeof chat;
  assert.equal(index[0]?.providerId, "custom:openai-legacy");
  assert.equal(stored.providerId, "custom:openai-legacy");
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

test("assistant persistence fails closed when its generation workspace is stale", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ workspaceId: "first" });
  await store.moveEmptyChatToWorkspace(chat.id, "second");

  await assert.rejects(
    store.appendMessage(
      chat.id,
      { role: "assistant", content: "stale workspace result" },
      { expectedWorkspaceId: "first" },
    ),
    /workspace changed/u,
  );

  const current = await store.get(chat.id);
  assert.equal(current?.workspaceId, "second");
  assert.deepEqual(current?.messages, []);
});

test("does not move a chat after its conversation has started", async (t) => {
  const store = await testStore(t);
  const chat = await store.create({ workspaceId: "first" });
  await store.appendMessage(chat.id, {
    role: "user",
    content: "Keep this chat here",
  });

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
