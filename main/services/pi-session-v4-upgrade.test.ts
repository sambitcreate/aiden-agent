import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { createCurrentPiSessionRepository } from "./pi-session-repository-port.js";
import { upgradeOldPiV4File } from "./pi-session-v4-upgrade.js";

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
  assert.match(await readFile(journal, "utf8"), /operation_started/u);
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
