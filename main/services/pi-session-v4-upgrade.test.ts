import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  assert.deepEqual((await session.buildContext()).messages.map((message) => message.role), ["user"]);
  assert.match(JSON.stringify(await session.buildContext()), /Keep this/u);
  assert.deepEqual(await readFile(`${journal}.pi084-backup`, "utf8"), original);
  assert.equal((await stat(`${journal}.pi084-backup`)).mode & 0o777, 0o600);
  const upgraded = JSON.parse((await readFile(journal, "utf8")).split("\n")[0]!);
  assert.deepEqual({ v: upgraded.v, storageVersion: upgraded.storageVersion }, { v: 4, storageVersion: 1 });
});

test("old Pi v4 upgrade refuses an unsettled operation without changing source bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-old-v4-open-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, "old.jsonl");
  const original = [
    { kind: "header", version: 4, id: "old", createdAt: 1, cwd: root },
    { kind: "record", seq: 1, id: "operation", type: "operation_started", timestamp: 2 },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(journal, original, { mode: 0o600 });
  await assert.rejects(upgradeOldPiV4File(journal), /unsettled operation/u);
  assert.equal(await readFile(journal, "utf8"), original);
  await assert.rejects(stat(`${journal}.pi084-backup`), { code: "ENOENT" });
});
