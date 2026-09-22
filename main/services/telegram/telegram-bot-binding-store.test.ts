import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTelegramBotBindingStore,
  TELEGRAM_BOT_BINDING_STORE_UNAVAILABLE_MESSAGE,
  type TelegramBotBindingInput,
  type TelegramBotBindingRollbackAuthority,
} from "./telegram-bot-binding-store.js";

type TestBindingInput = Omit<TelegramBotBindingInput, "backingWorkspaceId"> & {
  backingWorkspaceId?: string;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiden-telegram-bindings-"));
  let timestamp = 100;
  const bindingStore = createTelegramBotBindingStore({
    root: () => root,
    now: () => ++timestamp,
  });
  return {
    root,
    store: {
      ...bindingStore,
      bind: (input: TestBindingInput) =>
        bindingStore.bind({
          ...input,
          backingWorkspaceId:
            input.backingWorkspaceId ?? `bot-home-${input.botId}`,
        }),
    },
  };
}

function memoryAuthority(
  initial: string | null = null,
): TelegramBotBindingRollbackAuthority & {
  clear(): void;
} {
  let value = initial;
  return {
    async load() {
      return value;
    },
    async store(next, expected) {
      if (value !== expected) throw new Error("authority changed");
      value = next;
    },
    clear() {
      value = null;
    },
  };
}

test("same owner can bind separate Telegram profiles without backing-chat collisions", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const work = await store.bind({
    botId: "bot-work",
    profile: "work",
    chatId: 42,
    ownerUserId: 42,
    workspaceId: "work",
  });
  const personal = await store.bind({
    botId: "bot-personal",
    profile: "personal",
    chatId: 42,
    ownerUserId: 42,
    workspaceId: "work",
  });
  assert.notEqual(work.backingChatId, personal.backingChatId);
  assert.equal((await store.resolve("work", 42))?.botId, "bot-work");
  assert.equal((await store.resolve("personal", 42))?.botId, "bot-personal");
});

test("an active DM target cannot be bound to two bots", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await store.bind({
    botId: "first",
    profile: "default",
    chatId: 7,
    ownerUserId: 7,
    workspaceId: "work",
  });
  await assert.rejects(
    store.bind({
      botId: "second",
      profile: "default",
      chatId: 7,
      ownerUserId: 7,
      workspaceId: "work",
    }),
    /already bound/u,
  );
  assert.equal((await store.resolveExact("default", 7))?.botId, "first");
});

test("thread targets are exact and can coexist within one Telegram chat", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await store.bind({
    botId: "topic-one",
    profile: "default",
    chatId: -9,
    threadId: 10,
    ownerUserId: 7,
    workspaceId: "work",
  });
  await store.bind({
    botId: "topic-two",
    profile: "default",
    chatId: -9,
    threadId: 11,
    ownerUserId: 7,
    workspaceId: "work",
  });
  await assert.rejects(
    store.bind({
      botId: "topic-duplicate",
      profile: "default",
      chatId: -9,
      threadId: 10,
      ownerUserId: 7,
      workspaceId: "work",
    }),
    /already bound/u,
  );
  assert.equal((await store.resolve("default", -9, 10))?.botId, "topic-one");
  assert.equal((await store.resolve("default", -9, 11))?.botId, "topic-two");
  assert.equal(await store.resolve("default", -9), null);
});

test("unbind is soft and rebinding preserves the generated backing chat id", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await store.bind({
    botId: "rebindable",
    profile: "default",
    chatId: 20,
    ownerUserId: 20,
    workspaceId: "work",
  });
  const detached = await store.unbind("rebindable");
  assert.equal(detached.enabled, false);
  assert.equal(await store.get("rebindable"), null);
  assert.equal((await store.get("rebindable", true))?.enabled, false);

  const rebound = await store.bind({
    botId: "rebindable",
    profile: "work",
    chatId: 21,
    ownerUserId: 20,
    workspaceId: "work",
  });
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
  await store.bind({
    botId: "work-bot",
    profile: "work",
    chatId: 20,
    ownerUserId: 20,
    workspaceId: "work",
  });
  await store.bind({
    botId: "personal-bot",
    profile: "personal",
    chatId: 20,
    ownerUserId: 20,
    workspaceId: "work",
  });

  assert.equal(await store.unbindProfile("work"), 1);
  assert.equal(await store.get("work-bot"), null);
  assert.equal((await store.get("personal-bot"))?.enabled, true);
  assert.equal(await store.unbindProfile("work"), 0);
});

test("bindings survive a new store instance and keep exact projections", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await store.bind({
    botId: "persistent",
    profile: "default",
    chatId: 99,
    ownerUserId: 9,
    workspaceId: "work",
  });
  const restarted = createTelegramBotBindingStore({ root: () => root });
  const loaded = await restarted.get("persistent");
  assert.deepEqual(loaded, created);
  assert.notStrictEqual(loaded, created);
  const disk = JSON.parse(
    await readFile(join(root, "telegram-bot-bindings.json"), "utf8"),
  ) as {
    version: number;
    bindings: unknown[];
  };
  assert.equal(disk.version, 3);
  assert.equal((disk as { generation?: number }).generation, 1);
  assert.equal(disk.bindings.length, 1);
});

test("malformed or corrupt records fail closed and cannot be replaced by a binding write", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "telegram-bot-bindings.json");
  const valid = {
    botId: "valid",
    profile: "default",
    chatId: 1,
    ownerUserId: 1,
    workspaceId: "work",
    backingWorkspaceId: "bot-home-valid",
    backingChatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
  };
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
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
  await assert.rejects(
    store.list(true),
    new RegExp(TELEGRAM_BOT_BINDING_STORE_UNAVAILABLE_MESSAGE, "u"),
  );
  await assert.rejects(
    store.resolve("default", 1),
    new RegExp(TELEGRAM_BOT_BINDING_STORE_UNAVAILABLE_MESSAGE, "u"),
  );

  const corrupt = "{not-json";
  await writeFile(file, corrupt, "utf8");
  const corruptStore = createTelegramBotBindingStore({ root: () => root });
  await assert.rejects(corruptStore.list(true), /routing data is unavailable/u);
  await assert.rejects(
    corruptStore.bind({
      botId: "after-corruption",
      profile: "default",
      chatId: 2,
      ownerUserId: 2,
      workspaceId: "work",
      backingWorkspaceId: "bot-home-after-corruption",
    }),
    /routing data is unavailable/u,
  );
  assert.equal(await readFile(file, "utf8"), corrupt);
  const rescued = (await readdir(root)).filter((name) =>
    name.startsWith("telegram-bot-bindings.json.invalid-"),
  );
  assert.equal(rescued.length, 0);
});

test("future binding state fails closed for reads and cannot be overwritten", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "telegram-bot-bindings.json");
  const future = JSON.stringify({
    version: 99,
    bindings: [{ future: true }],
  });
  await writeFile(file, future, "utf8");
  const store = createTelegramBotBindingStore({ root: () => root });
  await assert.rejects(store.list(true), /routing data is unavailable/u);
  await assert.rejects(
    store.resolve("default", 8),
    /routing data is unavailable/u,
  );
  await assert.rejects(
    store.bind({
      botId: "must-not-overwrite",
      profile: "default",
      chatId: 8,
      ownerUserId: 8,
      workspaceId: "external",
      backingWorkspaceId: "managed-home",
    }),
    /routing data is unavailable/u,
  );
  assert.equal(await readFile(file, "utf8"), future);
});

test("v1 enabled and disabled bindings durably migrate without changing backing chats", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "telegram-bot-bindings.json");
  const enabled = {
    botId: "enabled-v1",
    profile: "default",
    chatId: 71,
    ownerUserId: 7,
    workspaceId: "legacy-home-enabled",
    backingChatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
    createdAt: 1,
    updatedAt: 3,
    enabled: true,
  };
  const disabled = {
    botId: "disabled-v1",
    profile: "default",
    chatId: 71,
    ownerUserId: 7,
    workspaceId: "legacy-home-disabled",
    backingChatId: "telegram-bot-22222222-2222-4222-8222-222222222222",
    createdAt: 1,
    updatedAt: 2,
    enabled: false,
  };
  const secondEnabled = {
    botId: "second-enabled-v1",
    profile: "work",
    chatId: 72,
    ownerUserId: 7,
    workspaceId: "legacy-home-second",
    backingChatId: "telegram-bot-33333333-3333-4333-8333-333333333333",
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
  };
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      bindings: [disabled, secondEnabled, enabled],
    }),
    "utf8",
  );

  const store = createTelegramBotBindingStore({ root: () => root });
  const migrated = await store.list(true);
  assert.deepEqual(
    migrated.map(({ botId }) => botId),
    ["enabled-v1", "disabled-v1", "second-enabled-v1"],
  );
  assert.equal(
    migrated.find(({ botId }) => botId === "enabled-v1")?.backingWorkspaceId,
    enabled.workspaceId,
  );
  assert.equal(
    migrated.find(({ botId }) => botId === "disabled-v1")?.backingWorkspaceId,
    disabled.workspaceId,
  );
  assert.equal(
    migrated.find(({ botId }) => botId === "enabled-v1")?.backingChatId,
    enabled.backingChatId,
  );
  assert.equal(
    migrated.find(({ botId }) => botId === "disabled-v1")?.enabled,
    false,
  );
  assert.equal((await store.resolve("default", 71))?.botId, "enabled-v1");
  assert.equal((await store.resolve("work", 72))?.botId, "second-enabled-v1");

  const disk = JSON.parse(await readFile(file, "utf8")) as {
    version: number;
    bindings: Array<{
      botId: string;
      backingWorkspaceId?: string;
      backingChatId: string;
    }>;
  };
  assert.equal(disk.version, 3);
  assert.equal((disk as { generation?: number }).generation, 0);
  assert.equal(disk.bindings.length, 3);
  assert(
    disk.bindings.every(
      ({ backingWorkspaceId }) => typeof backingWorkspaceId === "string",
    ),
  );
  assert.equal(
    disk.bindings.find(({ botId }) => botId === "enabled-v1")?.backingChatId,
    enabled.backingChatId,
  );
});

test("protected generation rejects an offline restore of a pre-unbind route", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "aiden-telegram-binding-rollback-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = { head: memoryAuthority(), bootstrap: memoryAuthority() };
  const first = createTelegramBotBindingStore({ root: () => root, authority });
  const bound = await first.bind({
    botId: "rollback-bot",
    profile: "default",
    chatId: 81,
    ownerUserId: 81,
    workspaceId: "external",
    backingWorkspaceId: "managed-home",
  });
  const file = join(root, "telegram-bot-bindings.json");
  const beforeUnbind = await readFile(file);
  await first.unbind(bound.botId);
  assert.equal(await first.resolve("default", 81), null);

  await writeFile(file, beforeUnbind);
  const restarted = createTelegramBotBindingStore({
    root: () => root,
    authority,
  });
  await assert.rejects(
    restarted.resolve("default", 81),
    new RegExp(TELEGRAM_BOT_BINDING_STORE_UNAVAILABLE_MESSAGE, "u"),
  );
  await assert.rejects(restarted.list(), /routing data is unavailable/u);
  assert.deepEqual(await readFile(file), beforeUnbind);
});

test("protected binding transitions reconcile every crash checkpoint", async (t) => {
  type CrashStage =
    "beforePending" | "afterPending" | "afterFile" | "afterCommit";
  const scenarios: Array<{ stage: CrashStage; remainsBound: boolean }> = [
    { stage: "beforePending" as const, remainsBound: true },
    { stage: "afterPending" as const, remainsBound: true },
    { stage: "afterFile" as const, remainsBound: false },
    { stage: "afterCommit" as const, remainsBound: false },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.stage, async () => {
      const root = await mkdtemp(
        join(tmpdir(), "aiden-telegram-binding-crash-"),
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      const authority = {
        head: memoryAuthority(),
        bootstrap: memoryAuthority(),
      };
      let crash: CrashStage | undefined;
      const fail = (stage: CrashStage) => async () => {
        if (crash === stage) throw new Error(`crash:${stage}`);
      };
      const first = createTelegramBotBindingStore({
        root: () => root,
        authority,
        authorityTransitionHooks: {
          beforePending: fail("beforePending"),
          afterPending: fail("afterPending"),
          afterFile: fail("afterFile"),
          afterCommit: fail("afterCommit"),
        },
      });
      const bound = await first.bind({
        botId: `crash-${scenario.stage}`,
        profile: "default",
        chatId: 91,
        ownerUserId: 91,
        workspaceId: "external",
        backingWorkspaceId: "managed-home",
      });
      crash = scenario.stage;
      await assert.rejects(
        first.unbind(bound.botId),
        new RegExp(`crash:${scenario.stage}`, "u"),
      );

      const restarted = createTelegramBotBindingStore({
        root: () => root,
        authority,
      });
      const resolved = await restarted.resolve("default", 91);
      assert.equal(
        resolved?.botId ?? null,
        scenario.remainsBound ? bound.botId : null,
      );
      await restarted.assertHealthy();
    });
  }
});

test("consumed bootstrap marker rejects anchor loss with an older restored route", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "aiden-telegram-binding-anchor-loss-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const authority = { head: memoryAuthority(), bootstrap: memoryAuthority() };
  const first = createTelegramBotBindingStore({ root: () => root, authority });
  const bound = await first.bind({
    botId: "anchor-loss",
    profile: "default",
    chatId: 92,
    ownerUserId: 92,
    workspaceId: "external",
    backingWorkspaceId: "managed-home",
  });
  const file = join(root, "telegram-bot-bindings.json");
  const beforeUnbind = await readFile(file);
  await first.unbind(bound.botId);
  authority.head.clear();
  await writeFile(file, beforeUnbind);

  const restarted = createTelegramBotBindingStore({
    root: () => root,
    authority,
  });
  await assert.rejects(
    restarted.resolve("default", 92),
    /routing data is unavailable/u,
  );
  assert.equal(await authority.bootstrap.load(), "consumed");
  assert.equal(await authority.head.load(), null);
});

test("profile, identity, target, and owner fields stay bounded", async (t) => {
  const { root, store } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    store.bind({
      botId: "x".repeat(161),
      profile: "default",
      chatId: 1,
      ownerUserId: 1,
      workspaceId: "work",
    }),
    /bot id/u,
  );
  await assert.rejects(
    store.bind({
      botId: "x",
      profile: "main",
      chatId: 1,
      ownerUserId: 1,
      workspaceId: "work",
    }),
    /profile/u,
  );
  await assert.rejects(
    store.bind({
      botId: "x",
      profile: "default",
      chatId: 0,
      ownerUserId: 1,
      workspaceId: "work",
    }),
    /chat id/u,
  );
  await assert.rejects(
    store.bind({
      botId: "x",
      profile: "default",
      chatId: 1,
      ownerUserId: 0,
      workspaceId: "work",
    }),
    /owner/u,
  );
  await assert.rejects(
    store.bind({
      botId: "x",
      profile: "default",
      chatId: 1,
      ownerUserId: 1,
      workspaceId: "../escape",
    }),
    /workspace id/u,
  );
});
