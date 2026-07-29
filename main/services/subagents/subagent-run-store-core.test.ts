import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  parseSubagentRunSnapshotV1,
  type SubagentRunSnapshotV1,
} from "../../../renderer/shared/subagent-runs.js";
import { createChatStore } from "../chat-store-core.js";
import { reconcilePendingChatDeletions } from "../chat-deletion-reconciliation.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { SubagentEventProjector } from "./subagent-event-projector.js";
import { readSubagentHistoryForOwner } from "./subagent-history-read-core.js";
import {
  MAX_SUBAGENT_CHAT_TOMBSTONES,
  MAX_SUBAGENT_RUN_STORE_BYTES,
  createSubagentRunStore,
} from "./subagent-run-store-core.js";
import type {
  SubagentRunStoreGeneration,
  SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";

async function testDirectory(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-subagent-runs-"));
  const directory = path.join(root, "private-runs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return directory;
}

function snapshot(overrides: Partial<SubagentRunSnapshotV1> = {}): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    groupId: "group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Review persistence",
    taskPreview: "Inspect the private run store.",
    state: "completed",
    startedAt: 10,
    updatedAt: 20,
    finishedAt: 20,
    modelId: "test-model",
    turns: 2,
    tools: 3,
    tokens: 40,
    warnings: [],
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function framedIrregularEncoding(value: string): string {
  const chunks: string[] = [];
  const widths = [4, 7, 5, 9];
  let offset = 0;
  let widthIndex = 0;
  while (offset < value.length) {
    const width = widths[widthIndex % widths.length]!;
    chunks.push(value.slice(offset, offset + width));
    offset += width;
    widthIndex += 1;
  }
  return `ALPHA BRAVO CIVIC DELTA HOTEL ${chunks.join(" \t")} INDIA JULIET KILO MANGO NOVEL`;
}

interface ControlledStorageState {
  contents: string | undefined;
  generation: SubagentRunStoreGeneration;
  generationCounter: number;
  nextWriteFailure?: "before_install" | "after_install";
  readFailures: number;
}

function controlledStorage(state: ControlledStorageState): SubagentRunStoreStorage {
  return {
    async cleanup() {
      return false;
    },
    async read() {
      if (state.readFailures > 0) {
        state.readFailures -= 1;
        throw new Error("simulated durable read failure");
      }
      if (state.contents === undefined) {
        if (state.generation === "missing") {
          return { status: "missing", contents: undefined, generation: "missing" };
        }
        return { status: "oversized", contents: undefined, generation: state.generation };
      }
      return {
        status: "data",
        contents: Buffer.from(state.contents, "utf8"),
        generation: state.generation,
      };
    },
    async write(expected, contents) {
      if (expected !== state.generation) {
        throw new Error("simulated destination generation change");
      }
      const failure = state.nextWriteFailure;
      state.nextWriteFailure = undefined;
      if (failure === "before_install") {
        throw new Error("simulated pre-install write failure");
      }
      state.generationCounter += 1;
      state.contents = contents;
      state.generation = `test-${state.generationCounter}`;
      if (failure === "after_install") {
        throw new Error("simulated post-install acknowledgement failure");
      }
      return state.generation;
    },
    async syncDirectory() {},
    async close() {},
  };
}

function readHistoryFromStore(store: {
  get(runId: string): Promise<SubagentRunSnapshotV1 | null>;
}): Promise<SubagentRunSnapshotV1 | null> {
  return readSubagentHistoryForOwner(
    {
      id: 1,
      documentId: "1:1:run-store-history",
      isDestroyed: () => false,
      send: () => undefined,
      onInvalidated: () => () => undefined,
    } satisfies RendererDocumentOwner,
    "chat-1",
    "run-1",
    {
      getChat: async () => ({
        id: "chat-1",
        workspaceId: "workspace-1",
        messages: [
          {
            role: "assistant",
            subagents: {
              version: 1,
              generationId: "generation-1",
              runIds: ["run-1"],
            },
          },
        ],
      }),
      getSnapshot: (runId) => store.get(runId),
    },
  );
}

async function assertUnreadableDeletionEvidenceBlocksRestart(
  t: test.TestContext,
  corrupt: (contents: Buffer) => Buffer,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-deletion-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatsDirectory = path.join(root, "chats");
  const runsDirectory = path.join(root, "runs");
  await fs.mkdir(chatsDirectory, { recursive: true });
  const chats = createChatStore(async () => chatsDirectory);
  const deletedChat = await chats.create({ title: "Delete across unreadable restart" });
  await chats.appendMessage(deletedChat.id, {
    role: "assistant",
    content: "Private review finished.",
    subagents: {
      version: 1,
      generationId: "generation-1",
      runIds: ["run-1"],
      total: 1,
      completed: 1,
      failed: 0,
      timedOut: 0,
      interrupted: 0,
    },
  });

  const beforeCrash = createSubagentRunStore(async () => runsDirectory);
  await beforeCrash.upsert(snapshot({ chatId: deletedChat.id }));
  const survivingRun = snapshot({
    runId: "run-surviving-evidence",
    childId: "child-surviving-evidence",
    chatId: "chat-surviving-evidence",
  });
  await beforeCrash.upsert(survivingRun);
  await beforeCrash.deleteChat(deletedChat.id);
  await beforeCrash.close();

  const target = path.join(runsDirectory, "runs.json");
  const repairable = await fs.readFile(target);
  assert.deepEqual(JSON.parse(repairable.toString("utf8")).pendingChatDeletions, [deletedChat.id]);
  const unreadable = corrupt(repairable);
  assert.equal(unreadable.includes(Buffer.from(deletedChat.id, "utf8")), true);
  await fs.writeFile(target, unreadable);
  const unreadableHash = createHash("sha256").update(unreadable).digest("hex");

  const restarted = createSubagentRunStore(async () => runsDirectory);
  let rendererCouldOpen = false;
  const removedChats: string[] = [];
  await assert.rejects(
    (async () => {
      await restarted.initialize();
      await reconcilePendingChatDeletions(restarted, async (chatId) => {
        removedChats.push(chatId);
        await chats.remove(chatId);
      });
      rendererCouldOpen = true;
    })(),
    /unreadable evidence and was preserved/u,
  );

  assert.equal(rendererCouldOpen, false);
  assert.equal(removedChats.length, 0);
  assert.ok(await chats.get(deletedChat.id));
  await assert.rejects(restarted.pendingChatDeletions(), /unreadable evidence and was preserved/u);
  await assert.rejects(restarted.get(survivingRun.runId), /unreadable evidence and was preserved/u);
  await assert.rejects(
    restarted.listByChat(survivingRun.chatId),
    /unreadable evidence and was preserved/u,
  );
  await assert.rejects(
    restarted.upsert(
      snapshot({
        runId: "run-blocked-by-unreadable-evidence",
        childId: "child-blocked-by-unreadable-evidence",
        chatId: "chat-blocked-by-unreadable-evidence",
      }),
    ),
    /unreadable evidence and was preserved/u,
  );
  await assert.rejects(
    readSubagentHistoryForOwner(
      {
        id: 1,
        documentId: "1:1:invalid-run-store",
        isDestroyed: () => false,
        send: () => undefined,
        onInvalidated: () => () => undefined,
      } satisfies RendererDocumentOwner,
      deletedChat.id,
      "run-1",
      {
        getChat: (chatId) => chats.get(chatId),
        getSnapshot: (runId) => restarted.get(runId),
      },
    ),
    /unreadable evidence and was preserved/u,
  );
  await assert.rejects(
    restarted.deleteChat("chat-blocked-by-unreadable-evidence"),
    /unreadable evidence and was preserved/u,
  );
  await assert.rejects(
    restarted.completeChatDeletion(deletedChat.id),
    /unreadable evidence and was preserved/u,
  );
  const preserved = await fs.readFile(target);
  assert.deepEqual(preserved, unreadable);
  assert.equal(createHash("sha256").update(preserved).digest("hex"), unreadableHash);

  // Repair is an explicit external action. The same restarted store then
  // recovers the preserved marker before the renderer is allowed to open.
  await fs.writeFile(target, repairable);
  await restarted.initialize();
  await reconcilePendingChatDeletions(restarted, async (chatId) => {
    removedChats.push(chatId);
    await chats.remove(chatId);
  });
  rendererCouldOpen = true;

  assert.equal(rendererCouldOpen, true);
  assert.deepEqual(removedChats, [deletedChat.id]);
  assert.equal(await chats.get(deletedChat.id), null);
  assert.deepEqual(await restarted.pendingChatDeletions(), []);
  assert.deepEqual(await restarted.get(survivingRun.runId), survivingRun);
  await restarted.close();
}

test("persists renderer-safe snapshots atomically with private modes", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);

  await store.upsert(snapshot());

  assert.deepEqual(await store.get("run-1"), snapshot());
  assert.deepEqual(await store.listByChat("chat-1"), [snapshot()]);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, "runs.json"))).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("persists and replays only bounded renderer-safe milestone kinds", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const withMilestones = snapshot({
    milestones: ["reading", "listing", "searching", "composing"],
  });

  await store.upsert(withMilestones);
  const restarted = createSubagentRunStore(async () => directory);

  assert.deepEqual(await restarted.get("run-1"), withMilestones);
  assert.doesNotMatch(
    await fs.readFile(path.join(directory, "runs.json"), "utf8"),
    /read_file|list_dir|grep|arguments|results|\/Users\//u,
  );
});

test("an ABA private-store pathname swap cannot redirect descriptor-bound history", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot());
  const originalDirectory = `${directory}-original`;
  const sentinelDirectory = `${directory}-sentinel`;
  const sentinelTarget = path.join(sentinelDirectory, "runs.json");
  const originalContents = await fs.readFile(path.join(directory, "runs.json"), "utf-8");
  await fs.rename(directory, originalDirectory);
  await fs.mkdir(sentinelDirectory, { mode: 0o700 });
  await fs.writeFile(sentinelTarget, "sentinel must survive\n", { mode: 0o600 });
  await fs.symlink(sentinelDirectory, directory, "dir");

  const next = snapshot({
    runId: "run-descriptor-bound",
    childId: "child-descriptor-bound",
    updatedAt: 30,
    finishedAt: 30,
  });
  await store.upsert(next);

  assert.equal(await fs.readFile(sentinelTarget, "utf-8"), "sentinel must survive\n");
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(originalDirectory, "runs.json"), "utf-8")).runs,
    [next, snapshot()],
  );
  assert.notEqual(
    await fs.readFile(path.join(originalDirectory, "runs.json"), "utf-8"),
    originalContents,
  );
  assert.deepEqual(
    (await fs.readdir(sentinelDirectory)).filter((name) => name.includes(".tmp")),
    [],
  );
  await fs.unlink(directory);
  await fs.rename(originalDirectory, directory);
  assert.deepEqual(await store.get("run-descriptor-bound"), next);
});

test("a regular runs.json replacement is preserved by the destination CAS", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot());
  const target = path.join(directory, "runs.json");
  const retained = path.join(directory, "retained-original.json");
  const sentinel = "regular replacement must survive\n";
  await fs.rename(target, retained);
  await fs.writeFile(target, sentinel, { mode: 0o600 });
  const rejected = snapshot({
    runId: "run-cas-rejected",
    childId: "child-cas-rejected",
    updatedAt: 30,
    finishedAt: 30,
  });

  // A stale native generation now performs one fresh read before retrying. The
  // replacement is not valid run-store evidence, so it remains untouched and
  // fails closed instead of being overwritten from B's cached database.
  await assert.rejects(store.upsert(rejected), /unreadable evidence and was preserved/u);

  assert.equal(await fs.readFile(target, "utf8"), sentinel);
  assert.doesNotMatch(await fs.readFile(retained, "utf8"), /run-cas-rejected/u);
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("a symlink replacement for runs.json is never followed during replay", async (t) => {
  const directory = await testDirectory(t);
  const writer = createSubagentRunStore(async () => directory);
  await writer.upsert(snapshot());
  const target = path.join(directory, "runs.json");
  const original = path.join(directory, "runs-original.json");
  const sentinel = path.join(path.dirname(directory), "outside-sentinel.json");
  await fs.rename(target, original);
  await fs.writeFile(sentinel, "outside sentinel\n", { mode: 0o600 });
  await fs.symlink(sentinel, target);

  const restarted = createSubagentRunStore(async () => directory);
  await assert.rejects(restarted.initialize());
  assert.equal(await fs.readFile(sentinel, "utf-8"), "outside sentinel\n");
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
});

test("hardlinked run stores are rejected without mutating the external sentinel", async (t) => {
  for (const operation of ["initialize", "upsert"] as const) {
    await t.test(operation, async (subtest) => {
      const directory = await testDirectory(subtest);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, "runs.json");
      const sentinel = path.join(path.dirname(directory), `${operation}-sentinel.json`);
      const contents = `${JSON.stringify(
        {
          version: 1,
          runs: [snapshot()],
          pendingChatDeletions: [],
        },
        null,
        2,
      )}\n`;
      await fs.writeFile(sentinel, contents, { encoding: "utf8", mode: 0o640 });
      await fs.chmod(sentinel, 0o640);
      await fs.link(sentinel, target);
      const before = await fs.stat(sentinel);
      assert.equal(before.nlink, 2);

      const store = createSubagentRunStore(async () => directory);
      if (operation === "initialize") {
        await assert.rejects(store.initialize(), /storage changed and was preserved/u);
      } else {
        await assert.rejects(
          store.upsert(
            snapshot({
              runId: "run-hardlink-rejected",
              childId: "child-hardlink-rejected",
              updatedAt: 30,
              finishedAt: 30,
            }),
          ),
          /storage changed and was preserved/u,
        );
      }

      const afterSentinel = await fs.stat(sentinel);
      const afterTarget = await fs.stat(target);
      assert.equal(await fs.readFile(sentinel, "utf8"), contents);
      assert.equal(await fs.readFile(target, "utf8"), contents);
      assert.equal(afterSentinel.mode & 0o777, before.mode & 0o777);
      assert.equal(afterTarget.mode & 0o777, before.mode & 0o777);
      assert.equal(afterSentinel.nlink, 2);
      assert.equal(afterTarget.nlink, 2);
      assert.equal(afterSentinel.dev, before.dev);
      assert.equal(afterSentinel.ino, before.ino);
      assert.equal(afterTarget.dev, before.dev);
      assert.equal(afterTarget.ino, before.ino);
    });
  }
});

test("startup durably removes only crash-left staging files owned by the run store", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stale = path.join(directory, ".runs.json.00000000-0000-4000-8000-000000000000.tmp");
  const symlinked = path.join(directory, ".runs.json.00000000-0000-4000-8000-000000000001.tmp");
  const unrelated = path.join(directory, ".runs.json.crash.tmp");
  const outside = path.join(path.dirname(directory), "outside-sentinel");
  await fs.writeFile(stale, JSON.stringify({ version: 1, runs: [snapshot()] }), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.writeFile(unrelated, "not owned by the atomic writer", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.writeFile(outside, "outside must survive", { mode: 0o600 });
  await fs.symlink(outside, symlinked);
  let directorySyncs = 0;
  const store = createSubagentRunStore(async () => directory, {
    syncDirectory: async (directoryPath) => {
      assert.equal(directoryPath, directory);
      directorySyncs += 1;
    },
  });

  await store.initialize();

  await assert.rejects(fs.access(stale));
  assert.equal(await fs.readFile(unrelated, "utf-8"), "not owned by the atomic writer");
  assert.equal((await fs.lstat(symlinked)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, "utf8"), "outside must survive");
  assert.equal(directorySyncs, 1);
  assert.deepEqual(await store.listByChat("chat-1"), []);
});

test("retries the staging-cleanup directory sync even after the stale file is gone", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stale = path.join(directory, ".runs.json.00000000-0000-4000-8000-000000000000.tmp");
  await fs.writeFile(stale, "private crash-left data", {
    encoding: "utf-8",
    mode: 0o600,
  });
  let directorySyncs = 0;
  const store = createSubagentRunStore(async () => directory, {
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === 1) {
        throw new Error("simulated staging cleanup sync failure");
      }
    },
  });

  await assert.rejects(store.initialize(), /simulated staging cleanup sync failure/u);
  await assert.rejects(fs.access(stale));
  await store.initialize();

  assert.equal(directorySyncs, 2);
  assert.deepEqual(await store.listByChat("chat-1"), []);
});

test("syncs staged data and the parent directory before a write is accepted", async (t) => {
  const directory = await testDirectory(t);
  const barriers: string[] = [];
  const store = createSubagentRunStore(async () => directory, {
    syncFile: async (filePath) => {
      assert.match(path.basename(filePath), /^\.runs\.json\..+\.tmp$/u);
      barriers.push("file");
    },
    syncDirectory: async (directoryPath) => {
      assert.equal(directoryPath, directory);
      barriers.push("directory");
    },
  });

  await store.upsert(snapshot());

  assert.deepEqual(barriers, ["file", "directory"]);
  assert.deepEqual(await store.get("run-1"), snapshot());
});

test("does not install an atomic target when staged-file sync fails", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory, {
    syncFile: async () => {
      throw new Error("simulated staged sync failure");
    },
  });

  await assert.rejects(store.upsert(snapshot()), /simulated staged sync failure/u);
  await assert.rejects(fs.access(path.join(directory, "runs.json")));
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("does not acknowledge a rename whose directory sync fails", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory, {
    syncDirectory: async () => {
      throw new Error("simulated directory sync failure");
    },
  });

  await assert.rejects(store.upsert(snapshot()), /simulated directory sync failure/u);
  const installed = JSON.parse(await fs.readFile(path.join(directory, "runs.json"), "utf-8")) as {
    runs: SubagentRunSnapshotV1[];
  };
  assert.deepEqual(installed.runs, [snapshot()]);
});

test("retries a pending post-rename directory sync before accepting the target", async (t) => {
  const directory = await testDirectory(t);
  let directorySyncs = 0;
  const store = createSubagentRunStore(async () => directory, {
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === 1) {
        throw new Error("simulated first directory sync failure");
      }
    },
  });

  await assert.rejects(store.upsert(snapshot()), /simulated first directory sync failure/u);
  await store.initialize();

  assert.equal(directorySyncs, 2);
  assert.deepEqual(await store.get("run-1"), snapshot());
});

test("a live fsync retry never performs restart reconciliation", async (t) => {
  const directory = await testDirectory(t);
  let directorySyncs = 0;
  const store = createSubagentRunStore(async () => directory, {
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === 1) throw new Error("simulated live directory sync failure");
    },
  });
  const running = snapshot({
    state: "running",
    finishedAt: undefined,
  });
  await assert.rejects(store.upsert(running), /simulated live directory sync failure/u);

  const progressed = snapshot({
    revision: 2,
    state: "running",
    activity: "Still running in this process",
    updatedAt: 30,
    finishedAt: undefined,
  });
  await store.upsert(progressed);

  assert.equal(directorySyncs, 3);
  const persisted = await store.get("run-1");
  assert.equal(persisted?.state, "running");
  assert.equal(persisted?.revision, 2);
  assert.equal(persisted?.activity, "Still running in this process");
  assert.equal(persisted?.finishedAt, undefined);
});

test("propagates operational read failures without rewriting valid history", async (t) => {
  const directory = await testDirectory(t);
  const writer = createSubagentRunStore(async () => directory);
  await writer.upsert(snapshot());
  await writer.close();
  const target = path.join(directory, "runs.json");
  const before = await fs.readFile(target, "utf-8");
  const ioError = Object.assign(new Error("simulated read failure"), {
    code: "EIO",
  });
  const restarted = createSubagentRunStore(async () => directory, {
    afterRead: async () => {
      throw ioError;
    },
  });

  await assert.rejects(restarted.initialize(), /simulated read failure/u);
  await assert.rejects(restarted.get("run-1"), /simulated read failure/u);
  await assert.rejects(restarted.listByChat("chat-1"), /simulated read failure/u);
  await assert.rejects(restarted.pendingChatDeletions(), /simulated read failure/u);
  await assert.rejects(
    restarted.upsert(
      snapshot({
        runId: "run-blocked-by-eio",
        childId: "child-blocked-by-eio",
      }),
    ),
    /simulated read failure/u,
  );
  assert.equal(await fs.readFile(target, "utf-8"), before);
});

test("malformed JSON remains blocked and untouched until repaired", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, "runs.json");
  const malformed = "{invalid json";
  await fs.writeFile(target, malformed, "utf-8");
  const restarted = createSubagentRunStore(async () => directory);

  await assert.rejects(restarted.initialize(), /unreadable evidence and was preserved/u);
  await assert.rejects(restarted.get("run-1"), /unreadable evidence and was preserved/u);
  await assert.rejects(restarted.upsert(snapshot()), /unreadable evidence and was preserved/u);
  await assert.rejects(restarted.pendingChatDeletions(), /unreadable evidence and was preserved/u);
  assert.equal(await fs.readFile(target, "utf-8"), malformed);

  const repaired = `${JSON.stringify({
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: [],
  })}\n`;
  await fs.writeFile(target, repaired, "utf-8");
  await restarted.initialize();
  assert.deepEqual(await restarted.get("run-1"), snapshot());
  assert.equal(await fs.readFile(target, "utf-8"), repaired);
});

test("duplicate JSON keys fail closed before recovery authority can be normalized", async (t) => {
  const cases = [
    {
      name: "duplicate deletion authority",
      contents: `{"version":1,"runs":[${JSON.stringify(snapshot())}],"pendingChatDeletions":["chat-1"],"pendingChatDeletions":[]}\n`,
    },
    {
      name: "escaped duplicate non-authority key",
      contents: `{"version":1,"\\u0076ersion":1,"runs":[${JSON.stringify(snapshot())}],"pendingChatDeletions":[]}\n`,
    },
    {
      name: "escaped duplicate nested key",
      contents: `{"version":1,"runs":[${JSON.stringify(snapshot()).slice(0, -1)},"w\\u0061rnings":[]}],"pendingChatDeletions":[]}\n`,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const state: ControlledStorageState = {
        contents: fixture.contents,
        generation: "test-1",
        generationCounter: 1,
        readFailures: 0,
      };
      const store = createSubagentRunStore(async () => "/private/subagent-runs", {
        storageFactory: () => controlledStorage(state),
      });

      await assert.rejects(store.initialize(), /unreadable evidence and was preserved/u);
      await assert.rejects(store.get("run-1"), /unreadable evidence and was preserved/u);
      assert.equal(state.contents, fixture.contents);
      assert.equal(state.generationCounter, 1);
    });
  }
});

test("escaped exact keys and same-named nested keys do not confuse root schema validation", async () => {
  const valid = JSON.stringify(snapshot());
  const contents = `{"version":1,"runs":[${valid},{"pendingChatDeletions":["nested-not-authority"]}],"pendingChatDeleti\\u006fns":[]}\n`;
  const state: ControlledStorageState = {
    contents,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await store.initialize();

  assert.deepEqual(await store.get("run-1"), snapshot());
  assert.deepEqual(JSON.parse(state.contents ?? "null"), {
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: [],
  });
});

test("BOM, zero-width, and unknown root-key mutations remain byte-identical evidence", async (t) => {
  const valid = JSON.stringify({
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: ["chat-1"],
  });
  const cases = [
    { name: "UTF-8 BOM", contents: `\uFEFF${valid}\n` },
    {
      name: "zero-width authority-key mutation",
      contents: `${valid.replace("pendingChatDeletions", "pendingChatDeletions\u200B")}\n`,
    },
    {
      name: "unknown root key",
      contents: `${valid.slice(0, -1)},"unexpected":[]}\n`,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const state: ControlledStorageState = {
        contents: fixture.contents,
        generation: "test-1",
        generationCounter: 1,
        readFailures: 0,
      };
      const store = createSubagentRunStore(async () => "/private/subagent-runs", {
        storageFactory: () => controlledStorage(state),
      });

      await assert.rejects(store.initialize(), /unreadable evidence and was preserved/u);
      await assert.rejects(store.pendingChatDeletions(), /unreadable evidence and was preserved/u);
      assert.equal(state.contents, fixture.contents);
      assert.equal(state.generationCounter, 1);
    });
  }
});

test("only the exact legacy v1 root shape migrates to the current schema", async () => {
  const legacy = `${JSON.stringify({ version: 1, runs: [snapshot()] })}\n`;
  const state: ControlledStorageState = {
    contents: legacy,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await store.initialize();

  assert.deepEqual(await store.get("run-1"), snapshot());
  assert.deepEqual(JSON.parse(state.contents ?? "null"), {
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: [],
  });
  assert.equal(state.generationCounter, 2);
});

test("a duplicate-key store recovers only after byte-exact external repair", async () => {
  const corrupted = `{"version":1,"runs":[${JSON.stringify(snapshot())}],"pendingChatDeletions":["chat-1"],"pendingChatDeletions":[]}\n`;
  const state: ControlledStorageState = {
    contents: corrupted,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await assert.rejects(store.initialize(), /unreadable evidence and was preserved/u);
  assert.equal(state.contents, corrupted);
  const repaired = `${JSON.stringify({
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: [],
  })}\n`;
  state.contents = repaired;
  state.generation = "test-2";
  state.generationCounter = 2;

  await store.initialize();

  assert.deepEqual(await store.get("run-1"), snapshot());
  assert.equal(state.contents, repaired);
  assert.equal(state.generationCounter, 2);
});

test("strict decoding preserves valid Unicode run history", async (t) => {
  const directory = await testDirectory(t);
  const unicode = snapshot({
    label: "Review café and 日本語",
    taskPreview: "Inspect the résumé 🧪.",
    terminalMarkdown: "Completed safely — naïve input preserved.",
  });
  const writer = createSubagentRunStore(async () => directory);
  await writer.upsert(unicode);
  await writer.close();

  const restarted = createSubagentRunStore(async () => directory);
  await restarted.initialize();

  assert.deepEqual(await restarted.get(unicode.runId), unicode);
  const persisted = await fs.readFile(path.join(directory, "runs.json"), "utf8");
  assert.match(persisted, /café and 日本語/u);
  assert.match(persisted, /résumé 🧪/u);
  await restarted.close();
});

test("persists already-redacted projector fields without reinterpreting JSON syntax", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const projector = new SubagentEventProjector({
    generationId: "generation-redacted",
    chatId: "chat-redacted",
    workspaceId: "workspace-redacted",
    modelId: "model-redacted",
    now: () => 100,
  });
  projector.begin(
    {
      runId: "run-redacted",
      groupId: "generation-redacted:group-1",
      childId: "child-redacted",
    },
    {
      role: "reviewer",
      label: "Check NODE_ENV\u200b＝production",
      task: "Inspect ／Users/alice/private.",
    },
  );
  const projected = projector.snapshot()[0]!;

  await store.upsert(projected);

  const persisted = await store.get("run-redacted");
  assert.deepEqual(persisted, projected);
  assert.match(persisted?.label ?? "", /\[REDACTED ENVIRONMENT VALUE\]/u);
  assert.match(persisted?.taskPreview ?? "", /\[REDACTED ABSOLUTE PATH\]/u);
});

test("projector, parser, and durable replay never retain POSIX environment values", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const taskValue = "task-export-lowercase-environment-value,semicolon;brace}";
  const envValue = "terminal-env-lowercase-environment-value,semicolon;brace}";
  const bareValue = "terminal-bare-mixed-case-environment-value,semicolon;brace}";
  const declareValue = "terminal-declare-lowercase-environment-value,semicolon;brace}";
  let now = 100;
  const projector = new SubagentEventProjector({
    generationId: "generation-environment-boundary",
    chatId: "chat-environment-boundary",
    workspaceId: "workspace-environment-boundary",
    modelId: "model-environment-boundary",
    now: () => now,
  });
  projector.begin(
    {
      runId: "run-environment-boundary",
      groupId: "generation-environment-boundary:group-1",
      childId: "child-environment-boundary",
    },
    {
      role: "reviewer",
      label: "Review environment persistence",
      task: `Inspect export foo=${taskValue}`,
    },
  );
  now += 1;
  projector.finish("run-environment-boundary", {
    role: "reviewer",
    label: "Review environment persistence",
    status: "completed",
    summary: `env foo=${envValue} command\nmixedName=${bareValue} command\ndeclare -x foo=${declareValue}`,
  });

  const projected = projector.snapshot()[0]!;
  assert.ok(parseSubagentRunSnapshotV1(projected));
  assert.equal(
    parseSubagentRunSnapshotV1({ ...projected, taskPreview: `export foo=${taskValue}` }),
    undefined,
  );
  assert.equal(
    parseSubagentRunSnapshotV1({
      ...projected,
      latestText: `env foo=${envValue} command`,
      terminalMarkdown: `mixedName=${bareValue} command\ndeclare -x foo=${declareValue}`,
    }),
    undefined,
  );

  await store.upsert(projected);
  await store.close();

  const durable = await fs.readFile(path.join(directory, "runs.json"), "utf8");
  assert.doesNotMatch(
    durable,
    /task-export-lowercase-environment-value|terminal-env-lowercase-environment-value|terminal-bare-mixed-case-environment-value|terminal-declare-lowercase-environment-value/u,
  );
  const replayedStore = createSubagentRunStore(async () => directory);
  const replayed = await replayedStore.get("run-environment-boundary");
  assert.deepEqual(replayed, projected);
  assert.ok(parseSubagentRunSnapshotV1(replayed));
  await replayedStore.close();
});

test("an unmatched angle cannot frame a lowercase shell assignment through projector, parser, or replay", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const shellProgram = "sh -c 'printf \"<\"; foo=supersecretvalue env'";
  const projector = new SubagentEventProjector({
    generationId: "generation-unmatched-angle",
    chatId: "chat-unmatched-angle",
    workspaceId: "workspace-unmatched-angle",
    modelId: "model-unmatched-angle",
    now: () => 100,
  });
  projector.begin(
    {
      runId: "run-unmatched-angle",
      groupId: "generation-unmatched-angle:group-1",
      childId: "child-unmatched-angle",
    },
    {
      role: "reviewer",
      label: "Check an unmatched angle",
      task: shellProgram,
    },
  );
  projector.finish("run-unmatched-angle", {
    role: "reviewer",
    label: "Check an unmatched angle",
    status: "completed",
    summary: shellProgram,
  });

  const projected = projector.snapshot()[0]!;
  for (const field of ["taskPreview", "latestText", "terminalMarkdown"] as const) {
    assert.match(projected[field] ?? "", /REDACTED/u, field);
    assert.doesNotMatch(projected[field] ?? "", /supersecretvalue/u, field);
    assert.equal(parseSubagentRunSnapshotV1({ ...projected, [field]: shellProgram }), undefined);
  }

  await store.upsert(projected);
  await store.close();
  const durable = await fs.readFile(path.join(directory, "runs.json"), "utf8");
  assert.doesNotMatch(durable, /supersecretvalue/u);

  const replayedStore = createSubagentRunStore(async () => directory);
  const replayed = await replayedStore.get("run-unmatched-angle");
  assert.deepEqual(replayed, projected);
  assert.ok(parseSubagentRunSnapshotV1(replayed));
  await replayedStore.close();
});

test("durable replay never restores JSON named-control credentials", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  let now = 100;
  const projector = new SubagentEventProjector({
    generationId: "generation-named-control",
    chatId: "chat-named-control",
    workspaceId: "workspace-named-control",
    modelId: "model-named-control",
    now: () => now,
  });
  projector.begin(
    {
      runId: "run-named-control",
      groupId: "generation-named-control:group-1",
      childId: "child-named-control",
    },
    {
      role: "reviewer",
      label: "Check escaped output",
      task: String.raw`Inspect api\tkey=correct-horse-battery-staple.`,
    },
  );
  now += 1;
  projector.finish("run-named-control", {
    role: "reviewer",
    label: "Check escaped output",
    status: "completed",
    summary: Buffer.from(String.raw`api\rkey=correct-horse-battery-staple`, "utf8").toString(
      "base64",
    ),
  });

  await store.upsert(projector.snapshot()[0]!);
  const replayedStore = createSubagentRunStore(async () => directory);
  const replayed = await replayedStore.get("run-named-control");

  assert.match(replayed?.taskPreview ?? "", /REDACTED/u);
  assert.match(replayed?.terminalMarkdown ?? "", /REDACTED/u);
  assert.doesNotMatch(
    await fs.readFile(path.join(directory, "runs.json"), "utf8"),
    /correct-horse-battery-staple|api\\\\[tr]key/u,
  );
});

test("serializes concurrent upserts without losing records", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.upsert(
        snapshot({
          runId: `run-${index + 1}`,
          childId: `child-${index + 1}`,
          revision: index + 1,
          updatedAt: 100 + index,
          finishedAt: 100 + index,
        }),
      ),
    ),
  );

  const runs = await store.listByChat("chat-1");
  assert.equal(runs.length, 20);
  assert.equal(new Set(runs.map((run) => run.runId)).size, 20);
  assert.deepEqual(
    runs.map((run) => run.updatedAt),
    [...runs.map((run) => run.updatedAt)].sort((a, b) => b - a),
  );
});

test("retries a stale native generation without poisoning projector flush or losing concurrent records", async (t) => {
  const directory = await testDirectory(t);
  const writerA = createSubagentRunStore(async () => directory);
  const cachedWriterB = createSubagentRunStore(async () => directory);

  // B has a valid empty cache and a missing generation before A installs an
  // independent record. The first projector persistence write must therefore
  // exercise the native compare-and-swap conflict path.
  await cachedWriterB.initialize();
  const concurrent = snapshot({
    runId: "run-concurrent-a",
    groupId: "generation-concurrent-a:group-1",
    generationId: "generation-concurrent-a",
    childId: "child-concurrent-a",
    chatId: "chat-concurrent-a",
    workspaceId: "workspace-concurrent-a",
  });
  await writerA.upsert(concurrent);

  let now = 100;
  const projector = new SubagentEventProjector({
    generationId: "generation-concurrent-b",
    chatId: "chat-concurrent-b",
    workspaceId: "workspace-concurrent-b",
    modelId: "model-concurrent-b",
    now: () => now,
    onSnapshot: async (entry) => {
      await cachedWriterB.upsert(entry);
    },
  });
  projector.begin(
    {
      runId: "run-concurrent-b",
      groupId: "generation-concurrent-b:group-1",
      childId: "child-concurrent-b",
    },
    {
      role: "reviewer",
      label: "Persist concurrent review",
      task: "Preserve independent durable records.",
    },
  );
  now += 1;
  projector.finish("run-concurrent-b", {
    role: "reviewer",
    label: "Persist concurrent review",
    status: "completed",
    summary: "The concurrent persistence retry completed.",
  });

  await projector.flush();

  const terminal = projector.snapshot()[0]!;
  assert.deepEqual(await writerA.get(concurrent.runId), concurrent);
  assert.deepEqual(await writerA.get(terminal.runId), terminal);
  assert.deepEqual(await cachedWriterB.get(concurrent.runId), concurrent);
  assert.deepEqual(await cachedWriterB.get(terminal.runId), terminal);
  await writerA.close();
  await cachedWriterB.close();
});

test("requires revisions to increase for changed snapshots", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot({ state: "running", finishedAt: undefined }));

  await assert.rejects(
    store.upsert(
      snapshot({
        state: "running",
        finishedAt: undefined,
        activity: "Changed without revision",
      }),
    ),
    /revisions must increase/u,
  );
  await store.upsert(
    snapshot({
      revision: 2,
      state: "running",
      activity: "Finished review",
      updatedAt: 30,
      finishedAt: undefined,
    }),
  );

  assert.equal((await store.get("run-1"))?.revision, 2);
  assert.equal((await store.get("run-1"))?.activity, "Finished review");
});

test("does not let a later revision move a run between owners", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot());

  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 2,
        chatId: "chat-2",
        workspaceId: "workspace-2",
        updatedAt: 30,
        finishedAt: 30,
      }),
    ),
    /identity cannot change/u,
  );
  assert.equal((await store.get("run-1"))?.chatId, "chat-1");
  assert.deepEqual(await store.listByChat("chat-2"), []);
});

test("durable replay scrubs every claimant for a run ID with conflicting owners", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true });
  const original = snapshot();
  const reassigned = snapshot({
    revision: 2,
    chatId: "chat-2",
    workspaceId: "workspace-2",
    updatedAt: 30,
    finishedAt: 30,
  });
  await fs.writeFile(
    path.join(directory, "runs.json"),
    JSON.stringify({
      version: 1,
      runs: [original, reassigned],
      pendingChatDeletions: [],
    }),
    "utf-8",
  );

  const store = createSubagentRunStore(async () => directory);
  await store.initialize();

  assert.equal(await store.get("run-1"), null);
  assert.deepEqual(await store.listByChat("chat-1"), []);
  assert.deepEqual(await store.listByChat("chat-2"), []);
  const persisted = JSON.parse(await fs.readFile(path.join(directory, "runs.json"), "utf-8")) as {
    runs: SubagentRunSnapshotV1[];
  };
  assert.deepEqual(persisted.runs, []);
});

test("does not let a later revision rewrite immutable metadata or revive terminal work", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot());

  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 2,
        label: "Rewritten label",
        updatedAt: 30,
        finishedAt: 30,
      }),
    ),
    /identity cannot change/u,
  );
  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 2,
        state: "running",
        updatedAt: 30,
        finishedAt: undefined,
      }),
    ),
    /lifecycle cannot move backward/u,
  );
});

test("requires lifecycle states and aggregate counters to move forward", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const queued = snapshot({
    state: "queued",
    finishedAt: undefined,
    turns: 0,
    tools: 0,
    tokens: 0,
    milestones: [],
  });
  await store.upsert(queued);
  await store.upsert(
    snapshot({
      revision: 2,
      state: "running",
      updatedAt: 21,
      finishedAt: undefined,
      turns: 1,
      tools: 1,
      tokens: 10,
      milestones: ["reading", "searching"],
    }),
  );
  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 3,
        state: "starting",
        updatedAt: 22,
        finishedAt: undefined,
        turns: 1,
        tools: 1,
        tokens: 10,
      }),
    ),
    /lifecycle cannot move backward/u,
  );
  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 3,
        state: "running",
        updatedAt: 22,
        finishedAt: undefined,
        turns: 1,
        tools: 1,
        tokens: 10,
        milestones: ["searching"],
      }),
    ),
    /lifecycle cannot move backward/u,
  );
  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 3,
        state: "running",
        updatedAt: 22,
        finishedAt: undefined,
        turns: 0,
        tools: 1,
        tokens: 10,
      }),
    ),
    /lifecycle cannot move backward/u,
  );
});

test("history capacity never evicts runs still owned by retained chats", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory, { maxRuns: 2 });

  const oldest = snapshot({
    runId: "run-old",
    childId: "child-old",
    chatId: "chat-old",
    updatedAt: 20,
  });
  await store.upsert(oldest);
  await store.upsert(
    snapshot({
      runId: "run-new",
      childId: "child-new",
      chatId: "chat-new",
      updatedAt: 40,
      finishedAt: 40,
    }),
  );
  await assert.rejects(
    store.upsert(
      snapshot({
        runId: "run-third",
        childId: "child-third",
        chatId: "chat-third",
        updatedAt: 50,
        finishedAt: 50,
      }),
    ),
    /history is at capacity/u,
  );

  assert.deepEqual(await store.get("run-old"), oldest);
  assert.equal((await store.get("run-new"))?.chatId, "chat-new");
  assert.equal(await store.get("run-third"), null);

  await store.deleteChat("chat-old");
  await store.upsert(
    snapshot({
      runId: "run-third",
      childId: "child-third",
      chatId: "chat-third",
      updatedAt: 50,
      finishedAt: 50,
    }),
  );
  assert.equal((await store.get("run-third"))?.chatId, "chat-third");
});

test("capacity rejection preserves older history when the wall clock moves backward", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory, { maxRuns: 1 });
  const beforeRollback = snapshot({
    runId: "run-before-rollback",
    childId: "child-before-rollback",
    updatedAt: 200,
    finishedAt: 200,
  });
  await store.upsert(beforeRollback);

  await assert.rejects(
    store.upsert(
      snapshot({
        runId: "run-after-rollback",
        childId: "child-after-rollback",
        updatedAt: 100,
        finishedAt: 100,
      }),
    ),
    /history is at capacity/u,
  );

  assert.deepEqual(await store.get("run-before-rollback"), beforeRollback);
  assert.equal(await store.get("run-after-rollback"), null);
});

test("reconciles persisted active children to interrupted exactly once", async (t) => {
  const directory = await testDirectory(t);
  const writer = createSubagentRunStore(async () => directory);
  for (const [index, state] of (["queued", "starting", "running"] as const).entries()) {
    await writer.upsert(
      snapshot({
        runId: `run-${state}`,
        childId: `child-${state}`,
        revision: index + 1,
        state,
        updatedAt: 20 + index,
        finishedAt: undefined,
      }),
    );
  }

  let restartTime = 100;
  const restarted = createSubagentRunStore(async () => directory, {
    now: () => restartTime,
  });
  await restarted.initialize();
  restartTime = 150;
  const startupPersisted = JSON.parse(
    await fs.readFile(path.join(directory, "runs.json"), "utf-8"),
  ) as { runs: SubagentRunSnapshotV1[] };
  assert.equal(startupPersisted.runs.length, 3);
  assert.ok(
    startupPersisted.runs.every(
      (run) => run.state === "interrupted" && run.updatedAt === 100 && run.finishedAt === 100,
    ),
  );

  const reconciled = await restarted.listByChat("chat-1");
  assert.equal(reconciled.length, 3);
  for (const run of reconciled) {
    assert.equal(run.state, "interrupted");
    assert.equal(run.updatedAt, 100);
    assert.equal(run.finishedAt, 100);
    assert.equal(run.activity, "Interrupted after Aiden restarted.");
    const originalRevision = run.runId === "run-queued" ? 1 : run.runId === "run-starting" ? 2 : 3;
    assert.equal(run.revision, originalRevision + 1);
  }

  const openedAgain = createSubagentRunStore(async () => directory, { now: () => 200 });
  const stable = await openedAgain.listByChat("chat-1");
  assert.deepEqual(stable, reconciled);
});

test("scrubs an active maximum revision instead of blocking restart", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "runs.json"),
    JSON.stringify({
      version: 1,
      runs: [
        snapshot({
          state: "running",
          revision: Number.MAX_SAFE_INTEGER,
          finishedAt: undefined,
        }),
      ],
    }),
    "utf-8",
  );

  const restarted = createSubagentRunStore(async () => directory, {
    now: () => 100,
  });
  await restarted.initialize();

  assert.deepEqual(await restarted.listByChat("chat-1"), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "runs.json"), "utf-8")), {
    version: 1,
    runs: [],
    pendingChatDeletions: [],
  });
});

test("rejects credentials and absolute paths before writing", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);

  await assert.rejects(
    store.upsert(
      snapshot({
        taskPreview: "Read /Users/person/private.txt with OPENAI_API_KEY=top-secret-value",
      }),
    ),
    /Invalid subagent run snapshot/u,
  );
  await assert.rejects(
    store.upsert(
      snapshot({
        terminalMarkdown: "Found Bearer abcdefghijklmnop in C:\\Users\\person\\secret.txt",
      }),
    ),
    /Invalid subagent run snapshot/u,
  );
  await assert.rejects(fs.access(path.join(directory, "runs.json")));
});

test("rejects framed encodings on write and removes them from durable replay", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const unsafe = framedIrregularEncoding(
    Buffer.from("OPENAI_API_KEY=correct-horse-framed-store", "utf8").toString("base64url"),
  );

  await assert.rejects(
    store.upsert(snapshot({ terminalMarkdown: unsafe })),
    /Invalid subagent run snapshot/u,
  );
  await fs.mkdir(directory, { recursive: true });
  const valid = snapshot({ runId: "run-valid-framed", childId: "child-valid-framed" });
  await fs.writeFile(
    path.join(directory, "runs.json"),
    JSON.stringify({
      version: 1,
      runs: [
        valid,
        snapshot({
          runId: "run-unsafe-framed",
          childId: "child-unsafe-framed",
          terminalMarkdown: unsafe,
        }),
      ],
      pendingChatDeletions: [],
    }),
    "utf8",
  );

  const replayed = createSubagentRunStore(async () => directory);
  assert.deepEqual(
    (await replayed.listByChat("chat-1")).map(({ runId }) => runId),
    ["run-valid-framed"],
  );
  assert.doesNotMatch(await fs.readFile(path.join(directory, "runs.json"), "utf8"), /ALPHA/u);
});

test("rejects private identifiers on write and scrubs them during durable replay", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  const secrets = [
    "sk-abcdefghijklmno",
    "c2stYWJjZGVmZ2hpamtsbW5v",
    "ONVS2YLCMNSGKZTHNBUWU23MNVXG6",
    "run-c2stYWJjZGVmZ2hpamtsbW5v-suffix",
    "c2st.YWJj.ZGVm.Z2hp.amts.bW5v",
    Buffer.from("/Users/alice/private.txt", "utf8")
      .toString("base64url")
      .match(/.{1,4}/gu)!
      .join("."),
    Buffer.from("OPENAI_API_KEY=correct-horse-battery-staple", "utf8")
      .toString("hex")
      .match(/.{1,4}/gu)!
      .join("."),
  ];
  const identifierKeys = [
    "runId",
    "groupId",
    "generationId",
    "childId",
    "chatId",
    "workspaceId",
  ] as const;

  for (const secret of secrets) {
    for (const key of identifierKeys) {
      await assert.rejects(
        store.upsert(snapshot({ [key]: secret })),
        /Invalid subagent run snapshot/u,
        `${key} accepted ${secret}`,
      );
    }
  }
  await assert.rejects(fs.access(path.join(directory, "runs.json")));

  await fs.mkdir(directory, { recursive: true });
  const valid = snapshot({ runId: "run-valid", childId: "child-valid" });
  const unsafe = secrets.flatMap((secret, secretIndex) =>
    identifierKeys.map((key, keyIndex) => ({
      ...valid,
      runId: `run-unsafe-${secretIndex}-${keyIndex}`,
      childId: `child-unsafe-${secretIndex}-${keyIndex}`,
      [key]: secret,
    })),
  );
  await fs.writeFile(
    path.join(directory, "runs.json"),
    JSON.stringify({ version: 1, runs: [valid, ...unsafe], pendingChatDeletions: [] }),
    "utf8",
  );

  const replayed = createSubagentRunStore(async () => directory);
  assert.deepEqual(
    (await replayed.listByChat("chat-1")).map(({ runId }) => runId),
    ["run-valid"],
  );
  const persisted = await fs.readFile(path.join(directory, "runs.json"), "utf8");
  for (const secret of secrets) assert.doesNotMatch(persisted, new RegExp(secret, "u"));
});

test("drops malformed and unsafe records loaded from disk", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true });
  const valid = snapshot({ runId: "run-valid", childId: "child-valid" });
  await fs.writeFile(
    path.join(directory, "runs.json"),
    JSON.stringify({
      version: 1,
      runs: [
        valid,
        { ...valid, runId: "/private/run", childId: "child-path" },
        { ...valid, runId: "run-extra", childId: "child-extra", rawToolArguments: "secret" },
        {
          ...valid,
          runId: "run-entity-secret",
          childId: "child-entity-secret",
          terminalMarkdown: "api&#95;key=fake-super-secret-value",
        },
        {
          ...valid,
          runId: "run-named-control-secret",
          childId: "child-named-control-secret",
          terminalMarkdown: String.raw`api\nkey=correct-horse-battery-staple`,
        },
      ],
    }),
    "utf-8",
  );

  const store = createSubagentRunStore(async () => directory);
  assert.deepEqual(
    (await store.listByChat("chat-1")).map((run) => run.runId),
    ["run-valid"],
  );
  const persisted = JSON.parse(await fs.readFile(path.join(directory, "runs.json"), "utf-8")) as {
    runs: SubagentRunSnapshotV1[];
  };
  assert.deepEqual(
    persisted.runs.map((run) => run.runId),
    ["run-valid"],
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(directory, "runs.json"), "utf-8"),
    /fake-super-secret-value|correct-horse-battery-staple|&#95;|api\\\\nkey/u,
  );
});

test("deletes all inspector history belonging to a chat", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot());
  await store.upsert(
    snapshot({
      runId: "run-other-chat",
      childId: "child-other-chat",
      chatId: "chat-2",
    }),
  );

  await store.deleteChat("chat-1");
  await store.flush();

  assert.deepEqual(await store.listByChat("chat-1"), []);
  assert.deepEqual(
    (await store.listByChat("chat-2")).map((run) => run.runId),
    ["run-other-chat"],
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(directory, "runs.json"), "utf-8"),
    /"chatId": "chat-1"/u,
  );
});

test("chat deletion tombstones reject late projector snapshots", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );

  await store.deleteChat("chat-1");
  await assert.rejects(
    store.upsert(
      snapshot({
        revision: 2,
        updatedAt: 30,
        finishedAt: 30,
      }),
    ),
    /no longer available/u,
  );
  assert.deepEqual(await store.listByChat("chat-1"), []);
});

test("a synchronous chat tombstone revokes queued and in-flight private-history reads", async () => {
  const state: ControlledStorageState = {
    contents: `${JSON.stringify(
      {
        version: 1,
        runs: [snapshot()],
        pendingChatDeletions: [],
      },
      null,
      2,
    )}\n`,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const readStarted = deferred();
  const releaseRead = deferred();
  let firstRead = true;
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
    afterRead: async (contents) => {
      if (firstRead) {
        firstRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      }
      return contents;
    },
  });

  const inFlightGet = store.get("run-1");
  const historyRead = readSubagentHistoryForOwner(
    {
      id: 1,
      documentId: "1:1:document",
      isDestroyed: () => false,
      send: () => undefined,
      onInvalidated: () => () => undefined,
    } satisfies RendererDocumentOwner,
    "chat-1",
    "run-1",
    {
      getChat: async () => ({
        id: "chat-1",
        workspaceId: "workspace-1",
        messages: [
          {
            role: "assistant",
            subagents: {
              version: 1,
              generationId: "generation-1",
              runIds: ["run-1"],
            },
          },
        ],
      }),
      getSnapshot: (runId) => store.get(runId),
    },
  );
  const queuedList = store.listByChat("chat-1");
  await readStarted.promise;
  const deletion = store.deleteChat("chat-1");
  releaseRead.resolve();

  assert.equal(await inFlightGet, null);
  assert.equal(await historyRead, null);
  assert.deepEqual(await queuedList, []);
  await deletion;
  assert.equal(await store.get("run-1"), null);
  assert.deepEqual(await store.listByChat("chat-1"), []);
});

test("native cross-instance deletion revokes cached get, list, and history reads", async (t) => {
  const directory = await testDirectory(t);
  const seed = createSubagentRunStore(async () => directory);
  await seed.upsert(snapshot());
  await seed.close();

  const getReader = createSubagentRunStore(async () => directory);
  const listReader = createSubagentRunStore(async () => directory);
  const historyReader = createSubagentRunStore(async () => directory);
  const deletingStore = createSubagentRunStore(async () => directory);

  assert.deepEqual(await getReader.get("run-1"), snapshot());
  assert.deepEqual(await listReader.listByChat("chat-1"), [snapshot()]);
  assert.deepEqual(await readHistoryFromStore(historyReader), snapshot());

  await deletingStore.deleteChat("chat-1");

  assert.equal(await getReader.get("run-1"), null);
  assert.deepEqual(await listReader.listByChat("chat-1"), []);
  assert.equal(await readHistoryFromStore(historyReader), null);

  await Promise.all([
    getReader.close(),
    listReader.close(),
    historyReader.close(),
    deletingStore.close(),
  ]);
});

test("a stale cross-instance writer cannot resurrect a chat after its deletion tombstone wins", async (t) => {
  const directory = await testDirectory(t);
  const seed = createSubagentRunStore(async () => directory);
  await seed.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );
  await seed.close();

  const writePaused = deferred<void>();
  const releaseWrite = deferred<void>();
  let stagedSyncs = 0;
  const staleWriter = createSubagentRunStore(async () => directory, {
    syncFile: async () => {
      stagedSyncs += 1;
      if (stagedSyncs === 1) {
        writePaused.resolve();
        await releaseWrite.promise;
      }
    },
  });
  const deletingStore = createSubagentRunStore(async () => directory);
  t.after(async () => {
    releaseWrite.resolve();
    await Promise.allSettled([staleWriter.close(), deletingStore.close()]);
  });

  // Cache the old generation, then hold the write after its merge has been
  // prepared. A separate instance commits the recovery-authoritative marker.
  const cachedRuns = await staleWriter.listByChat("chat-1");
  assert.equal(cachedRuns.length, 1);
  assert.equal(cachedRuns[0]?.runId, "run-1");
  assert.equal(cachedRuns[0]?.state, "running");
  const staleCompletion = staleWriter.upsert(
    snapshot({
      revision: 2,
      updatedAt: 30,
      finishedAt: 30,
    }),
  );
  await writePaused.promise;
  await deletingStore.deleteChat("chat-1");
  releaseWrite.resolve();

  await assert.rejects(staleCompletion, /no longer available/u);
  assert.equal(stagedSyncs, 1);
  assert.equal(await staleWriter.get("run-1"), null);
  assert.deepEqual(await staleWriter.listByChat("chat-1"), []);
  assert.deepEqual(await staleWriter.pendingChatDeletions(), ["chat-1"]);
});

test("ordinary cached reads fail closed when a newer durable generation is unreadable", async () => {
  const initial = `${JSON.stringify({
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: [],
  })}\n`;
  const state: ControlledStorageState = {
    contents: initial,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  assert.deepEqual(await store.get("run-1"), snapshot());
  assert.deepEqual(await store.listByChat("chat-1"), [snapshot()]);
  assert.deepEqual(await readHistoryFromStore(store), snapshot());

  const unreadable = `{"version":1,"runs":[${JSON.stringify(snapshot())}],"pendingChatDeletions":["chat-1"],"pendingChatDeletions":[]}\n`;
  state.contents = unreadable;
  state.generation = "test-2";
  state.generationCounter = 2;

  await assert.rejects(store.get("run-1"), /unreadable evidence and was preserved/u);
  await assert.rejects(store.listByChat("chat-1"), /unreadable evidence and was preserved/u);
  await assert.rejects(readHistoryFromStore(store), /unreadable evidence and was preserved/u);
  assert.equal(state.contents, unreadable);
  assert.equal(state.generationCounter, 2);
});

test("upsert hydrates a durable deletion intent without requiring initialize", async () => {
  const state: ControlledStorageState = {
    contents: `${JSON.stringify(
      {
        version: 1,
        runs: [],
        pendingChatDeletions: ["chat-1"],
      },
      null,
      2,
    )}\n`,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await assert.rejects(store.upsert(snapshot()), /no longer available/u);
  assert.deepEqual(await store.pendingChatDeletions(), ["chat-1"]);
});

test("cross-store completion releases a committed tombstone", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  await store.upsert(snapshot());
  await store.deleteChat("chat-1");
  await store.completeChatDeletion("chat-1");

  const replacement = snapshot({
    runId: "run-replacement",
    childId: "child-replacement",
  });
  await store.upsert(replacement);
  assert.deepEqual(await store.get("run-replacement"), replacement);
});

test("pending chat-deletion tombstones have a hard bound", async (t) => {
  const directory = await testDirectory(t);
  const store = createSubagentRunStore(async () => directory);
  for (let index = 0; index < MAX_SUBAGENT_CHAT_TOMBSTONES; index += 1) {
    await store.deleteChat(`chat-delete-${index}`);
  }
  await assert.rejects(
    store.deleteChat("chat-delete-overflow"),
    /Too many subagent history deletions are pending/u,
  );
  await store.completeChatDeletion("chat-delete-0");
  await store.deleteChat("chat-delete-after-release");
});

test("post-rename chat-deletion failure retains its durable intent and tombstone", async (t) => {
  const directory = await testDirectory(t);
  let directorySyncs = 0;
  const store = createSubagentRunStore(async () => directory, {
    syncDirectory: async () => {
      directorySyncs += 1;
      if (directorySyncs === 2) {
        throw new Error("simulated delete directory sync failure");
      }
    },
  });
  await store.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );

  await assert.rejects(store.deleteChat("chat-1"), /simulated delete directory sync failure/u);
  const completed = snapshot({
    revision: 2,
    updatedAt: 30,
    finishedAt: 30,
  });
  await assert.rejects(store.upsert(completed), /no longer available/u);
  await store.deleteChat("chat-1");
  assert.deepEqual(await store.pendingChatDeletions(), ["chat-1"]);
  await store.completeChatDeletion("chat-1");

  const replacement = snapshot({
    runId: "run-replacement",
    childId: "child-replacement",
  });
  await store.upsert(replacement);
  assert.deepEqual(await store.get("run-replacement"), replacement);
});

test("an installed deletion whose acknowledgement fails remains fail-closed and restart-recoverable", async () => {
  const state: ControlledStorageState = {
    contents: undefined,
    generation: "missing",
    generationCounter: 0,
    readFailures: 0,
  };
  const storageFactory = () => controlledStorage(state);
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory,
  });
  await store.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );

  state.nextWriteFailure = "after_install";
  const deletion = store.deleteChat("chat-1");
  const currentlyQueuedCompletion = store.upsert(
    snapshot({
      revision: 2,
      updatedAt: 30,
      finishedAt: 30,
    }),
  );
  await assert.rejects(deletion, /post-install acknowledgement failure/u);
  await assert.rejects(currentlyQueuedCompletion, /no longer available/u);

  const installed = JSON.parse(state.contents ?? "null") as {
    runs: SubagentRunSnapshotV1[];
    pendingChatDeletions: string[];
  };
  assert.deepEqual(installed.pendingChatDeletions, ["chat-1"]);
  assert.deepEqual(installed.runs, []);
  assert.deepEqual(await store.pendingChatDeletions(), ["chat-1"]);
  await assert.rejects(
    store.upsert(
      snapshot({
        runId: "run-late",
        childId: "child-late",
        updatedAt: 40,
        finishedAt: 40,
      }),
    ),
    /no longer available/u,
  );

  // Retrying is idempotent after the fresh read recovered the installed
  // generation, and a new process can finish the same durable intent.
  await store.deleteChat("chat-1");
  const restarted = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory,
  });
  await restarted.initialize();
  assert.deepEqual(await restarted.pendingChatDeletions(), ["chat-1"]);
  const reconciled: string[] = [];
  await reconcilePendingChatDeletions(restarted, async (chatId) => {
    reconciled.push(chatId);
  });
  assert.deepEqual(reconciled, ["chat-1"]);
  assert.deepEqual(await restarted.pendingChatDeletions(), []);

  const replacement = snapshot({
    runId: "run-replacement",
    childId: "child-replacement",
  });
  await restarted.upsert(replacement);
  assert.deepEqual(await restarted.get(replacement.runId), replacement);
});

test("a pre-install deletion failure releases only after durable absence is proven", async () => {
  const state: ControlledStorageState = {
    contents: undefined,
    generation: "missing",
    generationCounter: 0,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });
  await store.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );

  state.nextWriteFailure = "before_install";
  await assert.rejects(store.deleteChat("chat-1"), /pre-install write failure/u);
  const completed = snapshot({
    revision: 2,
    updatedAt: 30,
    finishedAt: 30,
  });
  await store.upsert(completed);
  assert.deepEqual(await store.get(completed.runId), completed);
  assert.deepEqual(await store.pendingChatDeletions(), []);
});

test("an ordinary fresh read can prove absence after an indeterminate pre-install failure", async () => {
  const state: ControlledStorageState = {
    contents: undefined,
    generation: "missing",
    generationCounter: 0,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });
  await store.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );

  state.nextWriteFailure = "before_install";
  state.readFailures = 1;
  await assert.rejects(store.deleteChat("chat-1"), /pre-install write failure/u);
  const surviving = await store.get("run-1");
  assert.equal(surviving?.state, "running");
  assert.equal(surviving?.finishedAt, undefined);
  assert.deepEqual(
    (await store.listByChat("chat-1")).map((run) => run.runId),
    ["run-1"],
  );

  // This is the same fresh durable verification the IPC delete handler uses
  // before deciding that the original chat survived and admission can reopen.
  assert.deepEqual(await store.pendingChatDeletions(), []);
  const completed = snapshot({
    revision: 2,
    updatedAt: 30,
    finishedAt: 30,
  });
  await store.upsert(completed);
  assert.deepEqual(await store.get("run-1"), completed);
});

test("fresh verification releases a tombstone when completion installed but acknowledgement failed", async () => {
  const state: ControlledStorageState = {
    contents: undefined,
    generation: "missing",
    generationCounter: 0,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });
  await store.upsert(snapshot());
  await store.deleteChat("chat-1");

  state.nextWriteFailure = "after_install";
  await assert.rejects(
    store.completeChatDeletion("chat-1"),
    /post-install acknowledgement failure/u,
  );
  assert.equal(await store.get("run-1"), null);
  assert.deepEqual(await store.pendingChatDeletions(), []);

  const replacement = snapshot({
    runId: "run-replacement",
    childId: "child-replacement",
  });
  await store.upsert(replacement);
  assert.deepEqual(await store.get(replacement.runId), replacement);
});

test("pre-rename chat-deletion failure releases only its provisional tombstone", async (t) => {
  const directory = await testDirectory(t);
  let fileSyncs = 0;
  const store = createSubagentRunStore(async () => directory, {
    syncFile: async () => {
      fileSyncs += 1;
      if (fileSyncs === 2) throw new Error("simulated delete staged sync failure");
    },
  });
  await store.upsert(
    snapshot({
      state: "running",
      finishedAt: undefined,
    }),
  );

  await assert.rejects(store.deleteChat("chat-1"), /simulated delete staged sync failure/u);
  const completed = snapshot({
    revision: 2,
    updatedAt: 30,
    finishedAt: 30,
  });
  await store.upsert(completed);
  assert.deepEqual(await store.get("run-1"), completed);
  assert.deepEqual(await store.pendingChatDeletions(), []);
});

test("pending deletion intent scrubs same-chat runs before completion clears it", async () => {
  const state: ControlledStorageState = {
    contents: `${JSON.stringify(
      {
        version: 1,
        runs: [snapshot()],
        pendingChatDeletions: ["chat-1"],
      },
      null,
      2,
    )}\n`,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await store.initialize();
  assert.equal(await store.get("run-1"), null);
  assert.deepEqual(await store.pendingChatDeletions(), ["chat-1"]);
  await store.completeChatDeletion("chat-1");

  const completed = JSON.parse(state.contents ?? "null") as {
    runs: SubagentRunSnapshotV1[];
    pendingChatDeletions: string[];
  };
  assert.deepEqual(completed, {
    version: 1,
    runs: [],
    pendingChatDeletions: [],
  });
});

test("pending deletion normalization filters and deduplicates before enforcing its cap", async () => {
  const state: ControlledStorageState = {
    contents: `${JSON.stringify({
      version: 1,
      runs: [snapshot()],
      pendingChatDeletions: [
        ...Array.from({ length: MAX_SUBAGENT_CHAT_TOMBSTONES + 8 }, () => null),
        ...Array.from({ length: MAX_SUBAGENT_CHAT_TOMBSTONES + 8 }, () => "chat-duplicate"),
        "chat-1",
        "chat-1",
      ],
    })}\n`,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await store.initialize();
  assert.deepEqual(await store.pendingChatDeletions(), ["chat-duplicate", "chat-1"]);
  assert.equal(await store.get("run-1"), null);
  const normalized = JSON.parse(state.contents ?? "null") as {
    runs: SubagentRunSnapshotV1[];
    pendingChatDeletions: string[];
  };
  assert.deepEqual(normalized.runs, []);
  assert.deepEqual(normalized.pendingChatDeletions, ["chat-duplicate", "chat-1"]);
});

test("a marker-bearing database with an invalid root shape fails closed", async () => {
  const contents = `${JSON.stringify({
    version: 99,
    runs: "malformed",
    pendingChatDeletions: ["chat-1"],
  })}\n`;
  const state: ControlledStorageState = {
    contents,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await assert.rejects(store.initialize(), /unreadable evidence and was preserved/u);
  await assert.rejects(store.pendingChatDeletions(), /unreadable evidence and was preserved/u);
  assert.equal(state.contents, contents);
  assert.equal(state.generationCounter, 1);
});

test("structurally malformed pending deletion state fails closed without rewriting", async () => {
  const contents = `${JSON.stringify({
    version: 1,
    runs: [snapshot()],
    pendingChatDeletions: "chat-1",
  })}\n`;
  const state: ControlledStorageState = {
    contents,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await assert.rejects(store.initialize(), /Invalid pending subagent chat deletion state/u);
  assert.equal(state.contents, contents);
  assert.equal(state.generationCounter, 1);
});

test("over-cap valid pending deletion state fails closed without dropping a marker", async () => {
  const contents = `${JSON.stringify({
    version: 1,
    runs: [],
    pendingChatDeletions: Array.from(
      { length: MAX_SUBAGENT_CHAT_TOMBSTONES + 1 },
      (_, index) => `chat-over-cap-${index}`,
    ),
  })}\n`;
  const state: ControlledStorageState = {
    contents,
    generation: "test-1",
    generationCounter: 1,
    readFailures: 0,
  };
  const store = createSubagentRunStore(async () => "/private/subagent-runs", {
    storageFactory: () => controlledStorage(state),
  });

  await assert.rejects(store.initialize(), /Too many subagent chat deletions require recovery/u);
  assert.equal(state.contents, contents);
  assert.equal(state.generationCounter, 1);
});

test("startup finishes a chat deletion journaled before the owning chat was removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-deletion-restart-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatsDirectory = path.join(root, "chats");
  const runsDirectory = path.join(root, "runs");
  await fs.mkdir(chatsDirectory, { recursive: true });
  const chats = createChatStore(async () => chatsDirectory);
  const chat = await chats.create({ title: "Delete across restart" });
  await chats.appendMessage(chat.id, {
    role: "assistant",
    content: "Reviewed.",
    subagents: {
      version: 1,
      generationId: "generation-1",
      runIds: ["run-1"],
      total: 1,
      completed: 1,
      failed: 0,
      timedOut: 0,
      interrupted: 0,
    },
  });
  const beforeCrash = createSubagentRunStore(async () => runsDirectory);
  await beforeCrash.upsert(snapshot({ chatId: chat.id }));

  // This is the exact crash boundary: the private history and durable intent
  // committed, but the owning chat removal never began.
  await beforeCrash.deleteChat(chat.id);

  const afterRestart = createSubagentRunStore(async () => runsDirectory);
  await afterRestart.initialize();
  assert.deepEqual(await afterRestart.pendingChatDeletions(), [chat.id]);
  assert.ok(await chats.get(chat.id));
  const crashLeftChatIndex = path.join(
    chatsDirectory,
    ".index.json.00000000-0000-4000-8000-000000000000.chat-delete.tmp",
  );
  await fs.writeFile(crashLeftChatIndex, "private crash-left chat metadata", "utf-8");

  await reconcilePendingChatDeletions(afterRestart, async (chatId) => chats.remove(chatId));

  assert.equal(await chats.get(chat.id), null);
  assert.equal(
    (await chats.list()).some((entry) => entry.id === chat.id),
    false,
  );
  assert.equal(await afterRestart.get("run-1"), null);
  assert.deepEqual(await afterRestart.pendingChatDeletions(), []);
  await assert.rejects(fs.access(crashLeftChatIndex));
});

test("marker-bearing syntax corruption blocks restart without reopening the chat", async (t) => {
  await assertUnreadableDeletionEvidenceBlocksRestart(t, (contents) => contents.subarray(0, -2));
});

test("invalid UTF-8 blocks every run-store path until byte-exact external repair", async (t) => {
  await assertUnreadableDeletionEvidenceBlocksRestart(t, (contents) => {
    const corrupted = Buffer.from(contents);
    const field = Buffer.from("pendingChatDeletions", "utf8");
    const fieldOffset = corrupted.indexOf(field);
    assert.notEqual(fieldOffset, -1);
    // Inside a JSON property name, replacement decoding would still parse but
    // would hide the recovery-authoritative field and report no deletion.
    corrupted[fieldOffset + "pendingChat".length] = 0x80;
    const lossilyDecoded = JSON.parse(corrupted.toString("utf8")) as Record<string, unknown>;
    assert.equal(lossilyDecoded.pendingChatDeletions, undefined);
    return corrupted;
  });
});

test("an oversized marker-bearing store blocks restart without reopening the chat", async (t) => {
  await assertUnreadableDeletionEvidenceBlocksRestart(t, (contents) => {
    const padding = MAX_SUBAGENT_RUN_STORE_BYTES - contents.byteLength + 1;
    return Buffer.concat([contents, Buffer.alloc(padding, 0x20)]);
  });
});

test("repairs permissive modes on an existing private store", async (t) => {
  const directory = await testDirectory(t);
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const target = path.join(directory, "runs.json");
  await fs.writeFile(target, JSON.stringify({ version: 1, runs: [snapshot()] }), {
    encoding: "utf-8",
    mode: 0o644,
  });
  await fs.chmod(directory, 0o755);
  await fs.chmod(target, 0o644);
  const retainedOriginal = await fs.open(target, "r");
  t.after(() => retainedOriginal.close());
  const originalIdentity = await retainedOriginal.stat();

  const store = createSubagentRunStore(async () => directory);
  assert.equal((await store.listByChat("chat-1")).length, 1);
  const installedIdentity = await fs.stat(target);
  const retainedIdentity = await retainedOriginal.stat();
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal(installedIdentity.mode & 0o777, 0o600);
  assert.notEqual(installedIdentity.ino, originalIdentity.ino);
  assert.equal(retainedIdentity.ino, originalIdentity.ino);
  assert.equal(retainedIdentity.mode & 0o777, 0o644);
  assert.equal(retainedIdentity.nlink, 0);
});
