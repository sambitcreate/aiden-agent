import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BOT_PAUSES_FILE, BotPauseStoreCorruptError, createBotPauseStore } from "./bot-pause-store.js";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-pauses-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a pause survives a restart and pausing again keeps the first time and origin", async () => {
  await withDir(async (dir) => {
    let clock = 1_000;
    const store = createBotPauseStore({ root: () => dir, now: () => clock });
    assert.equal(await store.get("bot-a"), undefined);
    assert.deepEqual(await store.pause("bot-a", "mac"), { since: 1_000, by: "mac" });
    clock = 5_000;
    assert.deepEqual(await store.pause("bot-a", "phone"), { since: 1_000, by: "mac" });

    const reopened = createBotPauseStore({ root: () => dir });
    assert.deepEqual(await reopened.get("bot-a"), { since: 1_000, by: "mac" });
    assert.equal(await reopened.get("bot-b"), undefined);
    assert.deepEqual([...(await reopened.list())], [["bot-a", { since: 1_000, by: "mac" }]]);
  });
});

test("unpause returns the record it cleared, once", async () => {
  await withDir(async (dir) => {
    const store = createBotPauseStore({ root: () => dir, now: () => 7 });
    await store.pause("bot-a", "cli");
    assert.deepEqual(await store.unpause("bot-a"), { since: 7, by: "cli" });
    assert.equal(await store.unpause("bot-a"), undefined);
    assert.equal(await createBotPauseStore({ root: () => dir }).get("bot-a"), undefined);
  });
});

test("deleting a Bot forgets only its pause", async () => {
  await withDir(async (dir) => {
    const store = createBotPauseStore({ root: () => dir });
    await store.pause("bot-a", "mac");
    await store.pause("bot-b", "mac");
    await store.forgetBot("bot-a");
    await store.forgetBot("bot-a");
    const reopened = createBotPauseStore({ root: () => dir });
    assert.equal(await reopened.get("bot-a"), undefined);
    assert.notEqual(await reopened.get("bot-b"), undefined);
  });
});

test("the file is private to the user", async () => {
  await withDir(async (dir) => {
    await createBotPauseStore({ root: () => dir }).pause("bot-a", "mac");
    const stat = await fs.stat(path.join(dir, BOT_PAUSES_FILE));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("malformed ids and origins are refused", async () => {
  await withDir(async (dir) => {
    const store = createBotPauseStore({ root: () => dir });
    await assert.rejects(store.pause("", "mac"), /Bot/u);
    await assert.rejects(store.pause("x".repeat(500), "mac"), /Bot/u);
    await assert.rejects(store.pause("__proto__", "mac"), /Bot/u);
    await assert.rejects(store.pause("bot-a", "watch" as never), /origin/u);
    assert.equal(await store.get("__proto__"), undefined);
  });
});

test("an unreadable file fails closed: reads throw, writes are refused, the bytes are kept", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, BOT_PAUSES_FILE);
    await fs.writeFile(file, "{ not json");
    const store = createBotPauseStore({ root: () => dir });
    await assert.rejects(store.get("bot-a"), BotPauseStoreCorruptError);
    await assert.rejects(store.list(), BotPauseStoreCorruptError);
    await assert.rejects(store.pause("bot-a", "mac"), BotPauseStoreCorruptError);
    await assert.rejects(store.unpause("bot-a"), BotPauseStoreCorruptError);
    assert.equal(await fs.readFile(file, "utf8"), "{ not json");

    // A delete still finishes: the record it cannot read can never come back.
    await store.forgetBot("bot-a");
    assert.equal(await fs.readFile(file, "utf8"), "{ not json");
  });
});

test("a file from a newer shape is never trusted or overwritten", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, BOT_PAUSES_FILE);
    const future = JSON.stringify({ version: 2, bots: { "bot-a": { since: 1, by: "mac" } } });
    await fs.writeFile(file, future);
    const store = createBotPauseStore({ root: () => dir });
    await assert.rejects(store.get("bot-a"), BotPauseStoreCorruptError);
    await assert.rejects(store.pause("bot-b", "mac"), BotPauseStoreCorruptError);
    assert.equal(await fs.readFile(file, "utf8"), future);
  });
});

test("a record with an unknown origin or extra keys makes the file unreadable", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, BOT_PAUSES_FILE);
    for (const record of [{ since: 1, by: "robot" }, { since: 1, by: "mac", note: "x" }, { since: -1, by: "mac" }]) {
      await fs.writeFile(file, JSON.stringify({ version: 1, bots: { "bot-a": record } }));
      await assert.rejects(createBotPauseStore({ root: () => dir }).get("bot-a"), BotPauseStoreCorruptError);
    }
  });
});

test("fixing an unreadable file takes effect without a restart", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, BOT_PAUSES_FILE);
    await fs.writeFile(file, "garbage");
    const store = createBotPauseStore({ root: () => dir, now: () => 3 });
    await assert.rejects(store.get("bot-a"), BotPauseStoreCorruptError);
    await fs.writeFile(file, JSON.stringify({ version: 1, bots: { "bot-a": { since: 2, by: "phone" } } }));
    assert.deepEqual(await store.get("bot-a"), { since: 2, by: "phone" });
    assert.deepEqual(await store.pause("bot-b", "mac"), { since: 3, by: "mac" });
    assert.equal((await store.list()).size, 2);
  });
});
