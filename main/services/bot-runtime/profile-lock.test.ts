import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { acquireBotProfileLock, BOT_PROFILE_LOCK_FILE } from "./profile-lock.js";
import { spawnHarnessChild } from "./test-support/child.js";

const roots: string[] = [];
function tempBotsDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-lock-"));
  roots.push(root);
  return path.join(root, "bots");
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("the first acquire succeeds and release removes the lock file", async () => {
  const dir = tempBotsDir();
  const lock = await acquireBotProfileLock(dir);
  assert.equal(lock.ok, true);
  assert.equal(existsSync(path.join(dir, BOT_PROFILE_LOCK_FILE)), true);
  if (lock.ok) await lock.release();
  assert.equal(existsSync(path.join(dir, BOT_PROFILE_LOCK_FILE)), false);
});

test("a second process is refused while the holder is alive", async () => {
  const dir = tempBotsDir();
  const lock = await acquireBotProfileLock(dir);
  assert.equal(lock.ok, true);
  const child = spawnHarnessChild("lock", [dir]);
  try {
    const reply = JSON.parse(await child.waitFor("LOCK"));
    assert.deepEqual(reply, { ok: false, reason: "held_by_live_process", pid: process.pid });
  } finally {
    await child.kill();
    if (lock.ok) await lock.release();
  }
});

test("this process cannot take the lock twice", async () => {
  const dir = tempBotsDir();
  const first = await acquireBotProfileLock(dir);
  const second = await acquireBotProfileLock(dir);
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "held_by_live_process", pid: process.pid });
  if (first.ok) await first.release();
  const third = await acquireBotProfileLock(dir);
  assert.equal(third.ok, true);
  if (third.ok) await third.release();
});

test("a lock left by a dead process is reclaimed", async () => {
  const dir = tempBotsDir();
  const child = spawnHarnessChild("lock", [dir]);
  assert.deepEqual(JSON.parse(await child.waitFor("LOCK")), { ok: true });
  await child.kill(); // SIGKILL: the lock file stays behind
  assert.equal(existsSync(path.join(dir, BOT_PROFILE_LOCK_FILE)), true);

  const lock = await acquireBotProfileLock(dir);
  assert.equal(lock.ok, true);
  if (lock.ok) await lock.release();
});

test("a lock naming a pid that does not exist is reclaimed", async () => {
  const dir = tempBotsDir();
  const first = await acquireBotProfileLock(dir);
  if (first.ok) await first.release();
  writeFileSync(
    path.join(dir, BOT_PROFILE_LOCK_FILE),
    JSON.stringify({ pid: 999_999, startedAt: 1, token: "stale" }),
  );
  const lock = await acquireBotProfileLock(dir);
  assert.equal(lock.ok, true);
  if (lock.ok) await lock.release();
});

test("an unreadable lock file is treated as stale", async () => {
  const dir = tempBotsDir();
  const first = await acquireBotProfileLock(dir);
  if (first.ok) await first.release();
  writeFileSync(path.join(dir, BOT_PROFILE_LOCK_FILE), "{torn");
  const lock = await acquireBotProfileLock(dir);
  assert.equal(lock.ok, true);
  if (lock.ok) await lock.release();
});
