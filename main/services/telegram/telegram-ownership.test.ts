import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createTelegramOwnershipLease } from "./telegram-ownership.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("one live process owns each Telegram profile lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-telegram-owner-"));
  roots.push(root);
  const first = createTelegramOwnershipLease({ root: () => root, profile: "default" });
  const second = createTelegramOwnershipLease({ root: () => root, profile: "default" });
  assert.equal(first.acquire().acquired, true);
  assert.deepEqual(second.acquire(), { acquired: false, recovered: false, ownerPid: process.pid });
  first.release();
  assert.equal(second.acquire().acquired, true);
  second.release();
});

test("a dead stale owner is quarantined and recovered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-telegram-owner-"));
  roots.push(root);
  const directory = path.join(root, "telegram-owners");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "work.json"), JSON.stringify({
    pid: 2_147_483_647,
    generation: "old",
    acquiredAt: 0,
    heartbeatAt: 0,
  }));
  const lease = createTelegramOwnershipLease({ root: () => root, profile: "work", now: () => 50_000, staleMs: 1_000 });
  assert.deepEqual(lease.acquire(), { acquired: true, recovered: true });
  lease.release();
});
