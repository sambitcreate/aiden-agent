import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import {
  accumulateSubagentTranscriptUpdate,
  mergeSubagentTranscript,
  type SubagentTranscriptUpdateV1,
  type SubagentTranscriptV1,
} from "../../../renderer/shared/subagent-transcript.js";
import { reconcilePendingChatDeletions } from "../chat-deletion-reconciliation.js";
import { createSubagentRunStoreDispatcher } from "./subagent-run-store-dispatcher.js";
import {
  createSubagentTranscriptFactory,
  createSubagentTranscriptStore,
  SUBAGENT_TRANSCRIPTS_DIRECTORY,
} from "./subagent-transcript-store.js";
import { temporaryDirectory } from "../../shared/temp-dir-test-support.js";

async function tempRoot(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await temporaryDirectory(t, "aiden-transcripts-");
  return root;
}

function transcript(runId: string, text = "Done."): SubagentTranscriptV1 {
  return {
    version: 1,
    runId,
    revision: 2,
    trimmed: false,
    entries: [
      { kind: "task", text: "Look." },
      { kind: "message", text, steps: [], startedAt: 1_000, finishedAt: 2_000 },
    ],
  };
}

async function savedFiles(root: string): Promise<string[]> {
  const base = path.join(root, SUBAGENT_TRANSCRIPTS_DIRECTORY);
  const found: string[] = [];
  for (const chat of await fs.readdir(base).catch(() => [])) {
    for (const file of await fs.readdir(path.join(base, chat))) found.push(`${chat}/${file}`);
  }
  return found.sort();
}

test("a recorded helper run saves to disk and reloads exactly", async (t) => {
  const root = await tempRoot(t);
  const store = createSubagentTranscriptStore(async () => root);
  const published: SubagentTranscriptUpdateV1[] = [];
  const factory = createSubagentTranscriptFactory(store, {
    publish: (update, chatId) => {
      assert.equal(chatId, "chat-1");
      published.push(update);
    },
  });
  const recorder = factory({ runId: "run-1", chatId: "chat-1", task: "Find where the retry limit is read." })!;
  recorder.messageStarted();
  recorder.textDelta("I will read the config files.");
  recorder.messageEnded("I will read the config files.");
  recorder.toolStarted("provider-a", "read_file", { path: "src/config.ts" });
  recorder.toolStarted("provider-b", "grep", { pattern: "retryLimit" });
  recorder.toolFinished("provider-a", "completed");
  recorder.toolFinished("provider-b", "completed");
  recorder.messageStarted();
  recorder.textDelta("The limit is read in src/retry.ts.");
  await recorder.finish("completed");

  const reloaded = await createSubagentTranscriptStore(async () => root).read("chat-1", "run-1");
  assert.ok(reloaded);
  assert.equal(reloaded.entries.length, 3);
  assert.equal(reloaded.entries[2]!.text, "The limit is read in src/retry.ts.");
  const steps = reloaded.entries[1]!.kind === "message" ? reloaded.entries[1]!.steps : [];
  assert.deepEqual(
    steps.map((step) => step.kind === "tool" && step.label),
    ["Read file", "Search files"],
  );
  // The saved copy is what a window following the stream ends up with.
  let live: SubagentTranscriptUpdateV1 | undefined;
  for (const update of published) live = accumulateSubagentTranscriptUpdate(live, update);
  assert.deepEqual(mergeSubagentTranscript(null, live).transcript, reloaded);

  // The file is private to the user.
  const [file] = await savedFiles(root);
  const mode = (await fs.stat(path.join(root, SUBAGENT_TRANSCRIPTS_DIRECTORY, file!))).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
});

test("a read never returns another chat's helper or a damaged file", async (t) => {
  const root = await tempRoot(t);
  const store = createSubagentTranscriptStore(async () => root);
  await store.write("chat-1", transcript("run-1"));
  assert.deepEqual(await store.read("chat-1", "run-1"), transcript("run-1"));
  assert.equal(await store.read("chat-2", "run-1"), null);
  assert.equal(await store.read("chat-1", "run-2"), null);
  assert.equal(await store.read("chat-1", "../run-1"), null);

  const [file] = await savedFiles(root);
  await fs.writeFile(path.join(root, SUBAGENT_TRANSCRIPTS_DIRECTORY, file!), "{not json");
  assert.equal(await store.read("chat-1", "run-1"), null);

  // A file holding a different run's conversation is not handed out under this id.
  await fs.writeFile(path.join(root, SUBAGENT_TRANSCRIPTS_DIRECTORY, file!), JSON.stringify(transcript("run-9")));
  assert.equal(await store.read("chat-1", "run-1"), null);

  await assert.rejects(store.write("chat-1", { ...transcript("run-1"), runId: "../escape" }));
});

test("each chat keeps a bounded number of helper conversations, newest first", async (t) => {
  const root = await tempRoot(t);
  const store = createSubagentTranscriptStore(async () => root, { maxPerChat: 2 });
  for (const runId of ["run-1", "run-2", "run-3"]) {
    await store.write("chat-1", transcript(runId));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(await store.read("chat-1", "run-1"), null);
  assert.ok(await store.read("chat-1", "run-2"));
  assert.ok(await store.read("chat-1", "run-3"));
});

test("a temporary file left by a crashed save is removed once it is stale", async (t) => {
  const root = await tempRoot(t);
  const now = Date.now();
  const store = createSubagentTranscriptStore(async () => root, { now: () => now });
  await store.write("chat-1", transcript("run-1"));
  const [chat] = (await savedFiles(root)).map((file) => file.split("/")[0]!);
  const directory = path.join(root, SUBAGENT_TRANSCRIPTS_DIRECTORY, chat!);
  const leftover = path.join(directory, ".run-9.json.crashed.tmp");
  const recent = path.join(directory, ".run-8.json.in-progress.tmp");
  await fs.writeFile(leftover, "{");
  await fs.writeFile(recent, "{");
  const old = new Date(now - 120_000);
  await fs.utimes(leftover, old, old);

  await store.write("chat-1", transcript("run-2"));
  const names = await fs.readdir(directory);
  assert.equal(names.includes(path.basename(leftover)), false, "the stale leftover is gone");
  assert.equal(names.includes(path.basename(recent)), true, "a save that may still be running is left alone");
  assert.ok(await store.read("chat-1", "run-1"));
  assert.ok(await store.read("chat-1", "run-2"));
});

test("deleting a chat removes its helper conversations and refuses late writes", async (t) => {
  const root = await tempRoot(t);
  const store = createSubagentTranscriptStore(async () => root);
  await store.write("chat-1", transcript("run-1"));
  await store.write("chat-1", transcript("run-2"));
  await store.write("chat-2", transcript("run-3"));
  await store.deleteChat("chat-1");
  assert.equal(await store.read("chat-1", "run-1"), null);
  assert.equal(await store.read("chat-1", "run-2"), null);
  assert.ok(await store.read("chat-2", "run-3"));
  assert.equal((await savedFiles(root)).length, 1);

  // A helper still finishing after the delete cannot bring its file back.
  await store.write("chat-1", transcript("run-1"));
  assert.equal(await store.read("chat-1", "run-1"), null);
});

function tombstoneStore(tombstones: Set<string>, log: string[]) {
  return {
    async initialize() {},
    async upsert(snapshot: unknown) {
      return snapshot as never;
    },
    async get() {
      return null;
    },
    async listByChat() {
      return [];
    },
    async deleteChat(chatId: string) {
      log.push(`tombstone:${chatId}`);
      tombstones.add(chatId);
    },
    async pendingChatDeletions() {
      return [...tombstones];
    },
    async completeChatDeletion(chatId: string) {
      log.push(`clear:${chatId}`);
      tombstones.delete(chatId);
    },
    async flush() {},
    async close() {},
  };
}

test("helper conversations are removed after a crash in the middle of a chat delete", async (t) => {
  const root = await tempRoot(t);
  const tombstones = new Set<string>();
  const log: string[] = [];

  // First process: the chat's deletion marker is written, then the process
  // dies before its helper conversations are removed.
  const before = createSubagentTranscriptStore(async () => root);
  await before.write("chat-1", transcript("run-1"));
  await before.write("chat-1", transcript("run-2"));
  await before.write("chat-2", transcript("run-3"));
  const crashing = createSubagentRunStoreDispatcher({
    selection: "v1",
    v1: tombstoneStore(tombstones, log) as never,
    v2: {} as never,
    deleteChatTranscripts: async () => {
      throw new Error("process ended");
    },
  });
  await crashing.initialize();
  await crashing.deleteChat("chat-1");
  assert.deepEqual([...tombstones], ["chat-1"]);
  assert.equal((await savedFiles(root)).length, 3, "the crash left the files behind");

  // Next start: a startup retry whose removal fails keeps the marker.
  const flaky = createSubagentRunStoreDispatcher({
    selection: "v1",
    v1: tombstoneStore(tombstones, log) as never,
    v2: {} as never,
    deleteChatTranscripts: async () => {
      throw new Error("disk busy");
    },
  });
  await flaky.initialize();
  await assert.rejects(reconcilePendingChatDeletions(flaky, async () => {}), /disk busy/u);
  assert.deepEqual([...tombstones], ["chat-1"]);

  // The start after that finishes the job with a fresh store.
  const after = createSubagentTranscriptStore(async () => root);
  const recovered = createSubagentRunStoreDispatcher({
    selection: "v1",
    v1: tombstoneStore(tombstones, log) as never,
    v2: {} as never,
    deleteChatTranscripts: (chatId) => after.deleteChat(chatId),
  });
  await recovered.initialize();
  await reconcilePendingChatDeletions(recovered, async () => {});
  assert.deepEqual([...tombstones], []);
  assert.equal(await after.read("chat-1", "run-1"), null);
  assert.equal(await after.read("chat-1", "run-2"), null);
  assert.ok(await after.read("chat-2", "run-3"), "other chats are untouched");
  assert.deepEqual(log, ["tombstone:chat-1", "clear:chat-1"]);
});

test("a normal chat delete removes helper conversations straight away", async (t) => {
  const root = await tempRoot(t);
  const store = createSubagentTranscriptStore(async () => root);
  await store.write("chat-1", transcript("run-1"));
  const tombstones = new Set<string>();
  const dispatcher = createSubagentRunStoreDispatcher({
    selection: "v1",
    v1: tombstoneStore(tombstones, []) as never,
    v2: {} as never,
    deleteChatTranscripts: (chatId) => store.deleteChat(chatId),
  });
  await dispatcher.initialize();
  await dispatcher.deleteChat("chat-1");
  assert.deepEqual(await savedFiles(root), []);
  await dispatcher.completeChatDeletion("chat-1");
  assert.deepEqual([...tombstones], []);
});
