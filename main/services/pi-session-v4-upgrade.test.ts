import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonlSessionRepo, TODO_CONTEXT, value } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createCurrentPiSessionRepository } from "./pi-session-repository-port.js";
import { convertOldPiV4Journal, upgradeOldPiV4File } from "./pi-session-v4-upgrade.js";

test("old Pi v4 journals upgrade with an exact backup and retain branch context", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-old-v4-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "--legacy--");
  await mkdir(directory);
  const journal = path.join(directory, "old.jsonl");
  const records = [
    { kind: "header", version: 4, id: "old", createdAt: 1, cwd: root,
      metadata: { kind: "aiden-chat-compaction-v1", chatId: "old" } },
    { kind: "entry", seq: 1, id: "first", parentId: null, timestamp: 2,
      type: "message", message: { role: "user", content: "Keep this", timestamp: 2 } },
    { kind: "lane", seq: 2, lane: "main", leafId: "first" },
  ];
  const original = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(journal, original, { mode: 0o600 });
  const repository = createCurrentPiSessionRepository(root);
  const listed = await repository.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.storageVersion, 0);
  const session = await repository.open(listed[0]!);
  assert.equal((await session.getMetadata()).storageVersion, 1);
  assert.deepEqual((await session.buildContext()).messages.map((message) => message.role), ["user"]);
  assert.match(JSON.stringify(await session.buildContext()), /Keep this/u);
  assert.deepEqual(await readFile(`${journal}.pi084-backup`, "utf8"), original);
  assert.equal((await stat(`${journal}.pi084-backup`)).mode & 0o777, 0o600);
  const upgraded = JSON.parse((await readFile(journal, "utf8")).split("\n")[0]!);
  assert.deepEqual({ v: upgraded.v, storageVersion: upgraded.storageVersion }, { v: 4, storageVersion: 1 });
  await repository.delete(listed[0]!);
  await assert.rejects(stat(journal), { code: "ENOENT" });
  await assert.rejects(stat(`${journal}.pi084-backup`), { code: "ENOENT" });
});

test("old Pi v4 upgrade preserves an interrupted operation and its transcript", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-old-v4-open-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "--legacy--");
  await mkdir(directory);
  const journal = path.join(directory, "old.jsonl");
  const original = [
    { kind: "header", version: 4, id: "old", createdAt: 1, cwd: root,
      metadata: { kind: "aiden-chat-compaction-v1", chatId: "old" } },
    { kind: "entry", seq: 1, id: "first", parentId: null, timestamp: 2,
      type: "message", message: { role: "user", content: "Recover this", timestamp: 2 } },
    { kind: "lane", seq: 2, lane: "main", leafId: "first" },
    { kind: "record", seq: 3, id: "operation", lane: "main", type: "operation_started", timestamp: 3,
      sourceLeafId: "first", intent: { kind: "navigation", targetId: "first", summarize: false } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(journal, original, { mode: 0o600 });
  const repository = createCurrentPiSessionRepository(root);
  const [listed] = await repository.list();
  assert.ok(listed);
  const session = await repository.open(listed);
  assert.match(JSON.stringify(await session.buildContext()), /Recover this/u);
  assert.equal(await readFile(`${journal}.pi084-backup`, "utf8"), original);
  const writes = (await readFile(journal, "utf8")).trim().split("\n").slice(1).map((line) => JSON.parse(line));
  const legacy = writes.filter((write) => write.namespace === "aiden.pi-legacy-record").map((write) => write.value);
  assert.deepEqual(legacy.map((value) => value.type), ["operation_started", "operation_finished"],
    "the interrupted operation is reconciled, not left open");
  assert.deepEqual(legacy[1], {
    kind: "record", id: "pi087-upgrade-recovered-operation", lane: "main", type: "operation_finished",
    timestamp: 3, runId: "operation", outcome: "aborted", recoveredBy: "aiden-pi-0.87.1-upgrade",
  });
  assert.deepEqual(writes.filter((write) => write.namespace === "pi.branch.tip").slice(-1)[0],
    { kind: "value", op: "set", seq: 3, namespace: "pi.branch.tip", key: "main", value: "first" },
    "the acknowledged branch tip is the recovered state");

  // The recovered chat keeps working: a new turn appends after the recovered
  // tip and survives a fresh process opening the promoted journal.
  await session.appendMessage({ role: "user", content: "After recovery", timestamp: 4 });
  const fresh = createCurrentPiSessionRepository(root);
  const [promoted] = await fresh.list();
  assert.equal(promoted?.storageVersion, 1);
  const reopened = await fresh.open(promoted!);
  assert.deepEqual((await reopened.buildContext()).messages.map((message) => "content" in message ? message.content : undefined),
    ["Recover this", "After recovery"]);
});

test("legacy operation reconciliation mirrors the 0.84.4 open-operation state", () => {
  const header = JSON.stringify({ kind: "header", version: 4, id: "old", createdAt: 1, cwd: "/tmp" });
  const journal = (records: object[]) => [header, ...records.map((item) => JSON.stringify(item))].join("\n") + "\n";
  const started = (id: string, seq: number) => ({ kind: "record", seq, id, lane: "main", type: "operation_started",
    timestamp: seq, sourceLeafId: null, intent: { kind: "navigation", targetId: null, summarize: false } });
  const finished = (id: string, runId: string, seq: number) => ({ kind: "record", seq, id, lane: "main",
    type: "operation_finished", timestamp: seq, runId, outcome: "completed" });
  assert.deepEqual(convertOldPiV4Journal(journal([started("a", 1), finished("a-done", "a", 2)])).interruptedOperations, []);
  assert.deepEqual(convertOldPiV4Journal(journal([started("a", 1), finished("a-done", "a", 2), started("b", 3)])).interruptedOperations, ["b"]);
  assert.deepEqual(convertOldPiV4Journal(journal([started("a", 1), finished("x-done", "unknown", 2)])).interruptedOperations, ["a"],
    "a finish for another operation does not close this one");
  assert.throws(() => convertOldPiV4Journal(journal([started("a", 1), started("a", 2)])), /duplicate record id/u);
  assert.throws(() => convertOldPiV4Journal(journal([started("a", 1), started("pi087-upgrade-recovered-a", 2)])), /conflicting recovery record/u);
});

test("an existing identical rollback backup is restricted to the owner before promotion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-old-v4-backup-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, "old.jsonl");
  const original = JSON.stringify({ kind: "header", version: 4, id: "old", createdAt: 1, cwd: root }) + "\n";
  await writeFile(journal, original, { mode: 0o600 });
  await writeFile(`${journal}.pi084-backup`, original);
  await chmod(`${journal}.pi084-backup`, 0o644);
  await upgradeOldPiV4File(journal);
  assert.equal((await stat(`${journal}.pi084-backup`)).mode & 0o777, 0o600);
  assert.equal(await readFile(`${journal}.pi084-backup`, "utf8"), original);

  await writeFile(journal, original, { mode: 0o600 });
  await writeFile(`${journal}.pi084-backup`, `${original}{"different":true}\n`);
  await chmod(`${journal}.pi084-backup`, 0o644);
  await assert.rejects(upgradeOldPiV4File(journal), /differs from the source journal/u);
  assert.equal((await stat(`${journal}.pi084-backup`)).mode & 0o777, 0o600, "a mismatched backup is still not left readable");
  assert.equal(await readFile(journal, "utf8"), original, "a mismatched backup blocks promotion");

  const fresh = path.join(root, "fresh.jsonl");
  await writeFile(fresh, original.replace('"old"', '"fresh"'), { mode: 0o644 });
  await upgradeOldPiV4File(fresh);
  assert.equal((await stat(`${fresh}.pi084-backup`)).mode & 0o777, 0o600, "a new backup never inherits the source mode");
});

test("old Pi v4 header-only journals upgrade without a trailing newline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-old-v4-header-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, "old.jsonl");
  await writeFile(journal, JSON.stringify({ kind: "header", version: 4, id: "old", createdAt: 1, cwd: root }));
  await upgradeOldPiV4File(journal);
  assert.match(await readFile(journal, "utf8"), /"storageVersion":1/u);
});

test("old Pi v4 usage rows retain native usage totals and adjustment details", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-old-v4-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, "old.jsonl");
  const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
  await writeFile(journal, [
    { kind: "header", version: 4, id: "old", createdAt: 1, cwd: root },
    { kind: "record", seq: 1, id: "usage-1", lane: "main", timestamp: 2,
      type: "usage", cause: "adjustment", usage, details: { reason: "correction" } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  await upgradeOldPiV4File(journal);
  const writes = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(writes.find((write) => write.kind === "usage"), {
    kind: "usage", seq: 1, id: "usage-1", usage, adjustment: true,
    details: { reason: "correction" },
  });
});

test("a failed ownership write releases the created journal and session claim", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-create-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = createCurrentPiSessionRepository(root);
  const originalCreate = JsonlSessionRepo.prototype.create;
  JsonlSessionRepo.prototype.create = async function (options, context) {
    const session = await originalCreate.call(this, options, context);
    session.setValue = async () => { throw new Error("ownership write failed"); };
    return session;
  };
  try {
    await assert.rejects(repository.create({ id: "retry", cwd: root,
      metadata: { kind: "aiden-chat-compaction-v1", chatId: "retry" } }), /ownership write failed/u);
  } finally {
    JsonlSessionRepo.prototype.create = originalCreate;
  }
  assert.deepEqual(await repository.list(), []);
  const retry = await repository.create({ id: "retry", cwd: root,
    metadata: { kind: "aiden-chat-compaction-v1", chatId: "retry" } });
  assert.equal((await retry.getMetadata()).id, "retry");
});

test("an ownership write whose rollback delete also fails stays retryable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-create-orphan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = { kind: "aiden-chat-compaction-v1", chatId: "retry" };
  const repository = createCurrentPiSessionRepository(root);
  const originalCreate = JsonlSessionRepo.prototype.create;
  const originalDelete = JsonlSessionRepo.prototype.delete;
  JsonlSessionRepo.prototype.create = async function (options, context) {
    const session = await originalCreate.call(this, options, context);
    session.setValue = async () => { throw new Error("ownership write failed"); };
    return session;
  };
  JsonlSessionRepo.prototype.delete = async () => { throw new Error("cleanup delete failed"); };
  try {
    await assert.rejects(repository.create({ id: "retry", cwd: root, metadata }), /ownership write failed/u,
      "the root cause, not the cleanup failure, reaches the caller");
  } finally {
    JsonlSessionRepo.prototype.create = originalCreate;
    JsonlSessionRepo.prototype.delete = originalDelete;
  }
  const native = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
  assert.equal((await native.list(undefined, TODO_CONTEXT)).length, 1, "the unowned header was left behind");
  assert.deepEqual((await repository.list()).map((entry) => entry.metadata), [undefined]);
  const retry = await repository.create({ id: "retry", cwd: root, metadata });
  assert.deepEqual((await retry.getMetadata()).metadata, metadata);
  assert.equal((await native.list(undefined, TODO_CONTEXT)).length, 1, "the orphan was replaced, not duplicated");
  // A fresh process (crash between create and the ownership write) recovers too.
  const crashed = await native.create({ id: "crashed", cwd: root }, TODO_CONTEXT);
  await crashed.close(TODO_CONTEXT);
  const reopened = await createCurrentPiSessionRepository(root).create({ id: "crashed", cwd: root,
    metadata: { kind: "aiden-chat-compaction-v1", chatId: "crashed" } });
  assert.equal((await reopened.getMetadata()).id, "crashed");
});

test("create never reclaims a same-id journal that holds data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-create-owned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
  const existing = await native.create({ id: "taken", cwd: root }, TODO_CONTEXT);
  await existing.setValue(value<string>("private", "note"), "private", TODO_CONTEXT);
  await existing.close(TODO_CONTEXT);
  await assert.rejects(createCurrentPiSessionRepository(root).create({ id: "taken", cwd: root,
    metadata: { kind: "aiden-chat-compaction-v1", chatId: "taken" } }), /Session already exists/u);
  assert.match(await readFile(existing.metadata.path, "utf8"), /private/u);
  const repository = createCurrentPiSessionRepository(root);
  const [first, second] = await Promise.allSettled([
    repository.create({ id: "same", cwd: root, metadata: { kind: "aiden-chat-compaction-v1", chatId: "same" } }),
    repository.create({ id: "same", cwd: root, metadata: { kind: "aiden-chat-compaction-v1", chatId: "same" } }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected", "a concurrent create cannot reclaim an in-flight claim");
});
