import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { acquireBotProfileLock, BOT_PROFILE_GUARD_FILE, BOT_PROFILE_LOCK_FILE } from "./profile-lock.js";
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

test("a raw read and close of the guard cannot release a live owner's lock", async () => {
  const dir = tempBotsDir();
  const owner = await acquireBotProfileLock(dir);
  assert.equal(owner.ok, true);
  const child = spawnHarnessChild("lock", [dir]);
  try {
    readFileSync(path.join(dir, BOT_PROFILE_GUARD_FILE));
    assert.equal(JSON.parse(await child.waitFor("LOCK")).ok, false);
  } finally {
    await child.kill();
    if (owner.ok) await owner.release();
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

test("three ready processes competing after SIGKILL never overlap", async () => {
  const dir = tempBotsDir();
  const stale = spawnHarnessChild("lock", [dir]);
  assert.deepEqual(JSON.parse(await stale.waitFor("LOCK")), { ok: true });
  await stale.kill();
  const gate = path.join(path.dirname(dir), "go");
  const contenders = Array.from({ length: 3 }, () => spawnHarnessChild("lock-gated", [dir, gate]));
  try {
    await Promise.all(contenders.map((child) => child.waitFor("READY")));
    writeFileSync(gate, "go");
    const results = await Promise.all(contenders.map(async (child) => JSON.parse(await child.waitFor("LOCK")) as { ok: boolean }));
    assert.equal(results.filter((result) => result.ok).length, 1);
    const winner = contenders[results.findIndex((result) => result.ok)]!;
    assert.equal((await acquireBotProfileLock(dir)).ok, false);
    await winner.kill();
    const recovered = await acquireBotProfileLock(dir);
    assert.equal(recovered.ok, true);
    if (recovered.ok) await recovered.release();
  } finally { await Promise.all(contenders.map((child) => child.kill())); }
});

test("a stopped live owner survives missing diagnostic metadata", async (t) => {
  if (process.platform === "win32") return t.skip("SIGSTOP is unavailable");
  const dir = tempBotsDir();
  const owner = spawnHarnessChild("lock", [dir]);
  try {
    assert.deepEqual(JSON.parse(await owner.waitFor("LOCK")), { ok: true });
    owner.child.kill("SIGSTOP");
    rmSync(path.join(dir, BOT_PROFILE_LOCK_FILE));
    const contender = spawnHarnessChild("lock", [dir]);
    try { assert.equal(JSON.parse(await contender.waitFor("LOCK")).ok, false); }
    finally { await contender.kill(); }
  } finally {
    owner.child.kill("SIGCONT");
    await owner.kill();
  }
  const recovered = await acquireBotProfileLock(dir);
  assert.equal(recovered.ok, true);
  if (recovered.ok) await recovered.release();
});

test("a symlinked guard fails closed and leaves its target untouched", async () => {
  const dir = tempBotsDir();
  const first = await acquireBotProfileLock(dir);
  assert.equal(first.ok, true);
  if (first.ok) await first.release();
  const guard = path.join(dir, BOT_PROFILE_GUARD_FILE);
  const target = path.join(path.dirname(dir), "target");
  writeFileSync(target, "untouched");
  rmSync(guard);
  symlinkSync(target, guard);
  await assert.rejects(acquireBotProfileLock(dir));
  assert.equal(readFileSync(target, "utf8"), "untouched");
});

test("a guard made readable by other users fails closed", async () => {
  const dir = tempBotsDir();
  const first = await acquireBotProfileLock(dir);
  assert.equal(first.ok, true);
  if (first.ok) await first.release();
  chmodSync(path.join(dir, BOT_PROFILE_GUARD_FILE), 0o644);
  await assert.rejects(acquireBotProfileLock(dir), /Unsafe lease guard/);
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

test("new-protocol metadata with a recycled live pid is reclaimed, while legacy metadata is respected", async () => {
  const dir = tempBotsDir();
  const file = path.join(dir, BOT_PROFILE_LOCK_FILE);
  const initial = await acquireBotProfileLock(dir);
  assert.equal(initial.ok, true);
  if (initial.ok) await initial.release();
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: 1, token: "legacy" }));
  assert.deepEqual(await acquireBotProfileLock(dir), { ok: false, reason: "held_by_live_process", pid: process.pid });
  writeFileSync(file, JSON.stringify({ protocol: "flock-v1", pid: process.pid, startedAt: 1, token: "retired" }));
  const recovered = await acquireBotProfileLock(dir);
  assert.equal(recovered.ok, true);
  if (recovered.ok) await recovered.release();
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
