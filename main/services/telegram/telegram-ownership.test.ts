import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  createTelegramOwnershipLease,
  createTelegramTransportOwnership,
  telegramSharedOwnershipRoot,
} from "./telegram-ownership.js";

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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-telegram-owner-"));
  roots.push(root);
  return root;
}

test("two Aiden processes with separate profiles cannot poll the same bot token", async () => {
  const shared = await tempRoot();
  const desktopProfile = await tempRoot();
  const cliProfile = await tempRoot();
  const token = "4242:secret";
  const desktop = createTelegramTransportOwnership({ profileRoot: () => desktopProfile, profile: "default", sharedRoot: () => shared, getToken: async () => token });
  const cli = createTelegramTransportOwnership({ profileRoot: () => cliProfile, profile: "default", sharedRoot: () => shared, getToken: async () => token });

  assert.equal((await desktop.acquire()).acquired, true);
  assert.deepEqual(await cli.acquire(), { acquired: false, recovered: false, ownerPid: process.pid, scope: "bot" });

  // The refused process did not keep its own profile lease: a sibling of it can still claim the profile.
  const cliSibling = createTelegramOwnershipLease({ root: () => cliProfile, profile: "default" });
  assert.equal(cliSibling.acquire().acquired, true);
  cliSibling.release();

  desktop.release();
  assert.equal((await cli.acquire()).acquired, true);
  cli.release();
});

test("different bot tokens poll side by side under one shared root", async () => {
  const shared = await tempRoot();
  const firstProfile = await tempRoot();
  const secondProfile = await tempRoot();
  const first = createTelegramTransportOwnership({ profileRoot: () => firstProfile, profile: "default", sharedRoot: () => shared, getToken: async () => "1:a" });
  const second = createTelegramTransportOwnership({ profileRoot: () => secondProfile, profile: "default", sharedRoot: () => shared, getToken: async () => "2:b" });
  assert.equal((await first.acquire()).acquired, true);
  assert.equal((await second.acquire()).acquired, true);
  first.release();
  second.release();
});

test("the shared Telegram lease root follows the shared Aiden config directory", () => {
  const home = path.join(os.homedir(), ".aiden");
  assert.equal(telegramSharedOwnershipRoot(undefined, { AIDEN_CONFIG_DIR: "/srv/aiden" }), path.resolve("/srv/aiden"));
  assert.equal(telegramSharedOwnershipRoot("/custom/agent", { AIDEN_CONFIG_DIR: "/srv/aiden" }), path.resolve("/srv/aiden"));
  assert.equal(telegramSharedOwnershipRoot(path.join(home, "agent"), {}), home, "the CLI's default agent dir shares the desktop root");
  assert.equal(telegramSharedOwnershipRoot(undefined, {}), home);
  assert.equal(telegramSharedOwnershipRoot("/custom/agent", {}), path.resolve("/custom/agent"));
});
