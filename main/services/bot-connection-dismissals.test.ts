import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  BOT_CONNECTION_DISMISSALS_FILE,
  createBotConnectionDismissalStore,
} from "./bot-connection-dismissals.js";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-dismissals-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a Not now dismissal is remembered per Bot across restarts", async () => {
  await withDir(async (dir) => {
    const store = createBotConnectionDismissalStore({ root: () => dir, now: () => 42 });
    assert.equal(await store.isDismissed("bot-a", "gmail"), false);
    await store.dismiss("bot-a", "gmail");
    await store.dismiss("bot-a", "gmail");
    assert.equal(await store.isDismissed("bot-a", "gmail"), true);
    assert.equal(await store.isDismissed("bot-b", "gmail"), false);
    assert.equal(await store.isDismissed("bot-a", "notion"), false);

    const reopened = createBotConnectionDismissalStore({ root: () => dir });
    assert.equal(await reopened.isDismissed("bot-a", "gmail"), true);
    assert.deepEqual(await reopened.list("bot-a"), ["gmail"]);
    assert.deepEqual(await reopened.list("bot-b"), []);
  });
});

test("deleting a Bot forgets its dismissals only", async () => {
  await withDir(async (dir) => {
    const store = createBotConnectionDismissalStore({ root: () => dir });
    await store.dismiss("bot-a", "gmail");
    await store.dismiss("bot-b", "notion");
    await store.forgetBot("bot-a");
    const reopened = createBotConnectionDismissalStore({ root: () => dir });
    assert.equal(await reopened.isDismissed("bot-a", "gmail"), false);
    assert.equal(await reopened.isDismissed("bot-b", "notion"), true);
  });
});

test("the file is private to the user", async () => {
  await withDir(async (dir) => {
    const store = createBotConnectionDismissalStore({ root: () => dir });
    await store.dismiss("bot-a", "gmail");
    const stat = await fs.stat(path.join(dir, BOT_CONNECTION_DISMISSALS_FILE));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("malformed ids are refused", async () => {
  await withDir(async (dir) => {
    const store = createBotConnectionDismissalStore({ root: () => dir });
    await assert.rejects(store.dismiss("", "gmail"), /Bot/u);
    await assert.rejects(store.dismiss("bot-a", "../x"), /connection/u);
    await assert.rejects(store.dismiss("x".repeat(500), "gmail"), /Bot/u);
    assert.equal(await store.isDismissed("bot-a", "__proto__"), false);
  });
});

test("an unreadable file is kept intact instead of being overwritten", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, BOT_CONNECTION_DISMISSALS_FILE);
    await fs.writeFile(file, "{ not json");
    const store = createBotConnectionDismissalStore({ root: () => dir });
    assert.equal(await store.isDismissed("bot-a", "gmail"), false);
    await assert.rejects(store.dismiss("bot-a", "gmail"));
    assert.equal(await fs.readFile(file, "utf8"), "{ not json");
  });
});

test("a file from a newer shape is read safely and never overwritten", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, BOT_CONNECTION_DISMISSALS_FILE);
    const future = JSON.stringify({ version: 2, bots: { "bot-a": { gmail: 1 } } });
    await fs.writeFile(file, future);
    const store = createBotConnectionDismissalStore({ root: () => dir });
    assert.equal(await store.isDismissed("bot-a", "gmail"), false);
    await assert.rejects(store.dismiss("bot-a", "notion"));
    assert.equal(await fs.readFile(file, "utf8"), future);
  });
});
