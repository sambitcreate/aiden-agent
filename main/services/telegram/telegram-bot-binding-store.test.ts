import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTelegramBotBindingStore } from "./telegram-bot-binding-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiden-telegram-bindings-"));
  let timestamp = 100;
  return {
    root,
    store: createTelegramBotBindingStore({ root: () => root, now: () => ++timestamp }),
  };
}

test("same owner can bind separate Telegram profiles without backing-chat collisions", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const work = await store.bind({ botId: "bot-work", profile: "work", chatId: 42, ownerUserId: 42, workspaceId: "work" });
  const personal = await store.bind({ botId: "bot-personal", profile: "personal", chatId: 42, ownerUserId: 42, workspaceId: "work" });
  assert.notEqual(work.backingChatId, personal.backingChatId);
  assert.equal((await store.resolve("work", 42))?.botId, "bot-work");
  assert.equal((await store.resolve("personal", 42))?.botId, "bot-personal");
});

test("an active DM target cannot be bound to two bots", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await store.bind({ botId: "first", profile: "default", chatId: 7, ownerUserId: 7, workspaceId: "work" });
  await assert.rejects(
    store.bind({ botId: "second", profile: "default", chatId: 7, ownerUserId: 7, workspaceId: "work" }),
    /already bound/u,
  );
  assert.equal((await store.resolveExact("default", 7))?.botId, "first");
});

test("thread targets are exact and can coexist within one Telegram chat", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await store.bind({ botId: "topic-one", profile: "default", chatId: -9, threadId: 10, ownerUserId: 7, workspaceId: "work" });
  await store.bind({ botId: "topic-two", profile: "default", chatId: -9, threadId: 11, ownerUserId: 7, workspaceId: "work" });
  await assert.rejects(
    store.bind({ botId: "topic-duplicate", profile: "default", chatId: -9, threadId: 10, ownerUserId: 7, workspaceId: "work" }),
    /already bound/u,
  );
  assert.equal((await store.resolve("default", -9, 10))?.botId, "topic-one");
  assert.equal((await store.resolve("default", -9, 11))?.botId, "topic-two");
  assert.equal(await store.resolve("default", -9), null);
});

test("unbind is soft and rebinding preserves the generated backing chat id", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await store.bind({ botId: "rebindable", profile: "default", chatId: 20, ownerUserId: 20, workspaceId: "work" });
  const detached = await store.unbind("rebindable");
  assert.equal(detached.enabled, false);
  assert.equal(await store.get("rebindable"), null);
  assert.equal((await store.get("rebindable", true))?.enabled, false);

  const rebound = await store.bind({ botId: "rebindable", profile: "work", chatId: 21, ownerUserId: 20, workspaceId: "work" });
  assert.equal(rebound.backingChatId, first.backingChatId);
  assert.equal((await store.resolve("work", 21))?.botId, "rebindable");
  const copy = await store.get("rebindable");
  assert.ok(copy);
  copy.enabled = false;
  assert.equal((await store.get("rebindable"))?.enabled, true);
  assert.equal((await store.list({ includeDisabled: true })).length, 1);
});

test("profile reset disables only that profile's active bot routes", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.bind({ botId: "work-bot", profile: "work", chatId: 20, ownerUserId: 20, workspaceId: "work" });
  await store.bind({ botId: "personal-bot", profile: "personal", chatId: 20, ownerUserId: 20, workspaceId: "work" });

  assert.equal(await store.unbindProfile("work"), 1);
  assert.equal(await store.get("work-bot"), null);
  assert.equal((await store.get("personal-bot"))?.enabled, true);
  assert.equal(await store.unbindProfile("work"), 0);
});

test("bindings survive a new store instance and keep exact projections", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await store.bind({ botId: "persistent", profile: "default", chatId: 99, ownerUserId: 9, workspaceId: "work" });
  const restarted = createTelegramBotBindingStore({ root: () => root });
  const loaded = await restarted.get("persistent");
  assert.deepEqual(loaded, created);
  assert.notStrictEqual(loaded, created);
  const disk = JSON.parse(await readFile(join(root, "telegram-bot-bindings.json"), "utf8")) as {
    version: number;
    bindings: unknown[];
  };
  assert.equal(disk.version, 1);
  assert.equal(disk.bindings.length, 1);
});

test("malformed records are ignored and corrupt source data is preserved before a write", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "telegram-bot-bindings.json");
  const valid = {
    botId: "valid",
    profile: "default",
    chatId: 1,
    ownerUserId: 1,
    workspaceId: "work",
    backingChatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
  };
  await writeFile(
    file,
    JSON.stringify({
      version: 99,
      bindings: [
        valid,
        { ...valid, botId: "duplicate", updatedAt: 0 },
        { ...valid, botId: "bad profile", updatedAt: 5 },
        { ...valid, botId: "bad-thread", threadId: 0, updatedAt: 6 },
      ],
    }),
    "utf8",
  );
  const store = createTelegramBotBindingStore({ root: () => root });
  assert.deepEqual((await store.list(true)).map(({ botId }) => botId), ["valid"]);

  const corrupt = "{not-json";
  await writeFile(file, corrupt, "utf8");
  const corruptStore = createTelegramBotBindingStore({ root: () => root });
  assert.deepEqual(await corruptStore.list(true), []);
  await corruptStore.bind({ botId: "after-corruption", profile: "default", chatId: 2, ownerUserId: 2, workspaceId: "work" });
  assert.equal(await readFile(file, "utf8").then((contents) => contents.includes(corrupt)), false);
  const rescued = (await readdir(root)).filter((name) => name.startsWith("telegram-bot-bindings.json.invalid-"));
  assert.equal(rescued.length, 1);
  assert.equal(await readFile(join(root, rescued[0]), "utf8"), corrupt);
});

test("profile, identity, target, and owner fields stay bounded", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    store.bind({ botId: "x".repeat(161), profile: "default", chatId: 1, ownerUserId: 1, workspaceId: "work" }),
    /bot id/u,
  );
  await assert.rejects(
    store.bind({ botId: "x", profile: "main", chatId: 1, ownerUserId: 1, workspaceId: "work" }),
    /profile/u,
  );
  await assert.rejects(
    store.bind({ botId: "x", profile: "default", chatId: 0, ownerUserId: 1, workspaceId: "work" }),
    /chat id/u,
  );
  await assert.rejects(
    store.bind({ botId: "x", profile: "default", chatId: 1, ownerUserId: 0, workspaceId: "work" }),
    /owner/u,
  );
  await assert.rejects(
    store.bind({ botId: "x", profile: "default", chatId: 1, ownerUserId: 1, workspaceId: "../escape" }),
    /workspace id/u,
  );
});
