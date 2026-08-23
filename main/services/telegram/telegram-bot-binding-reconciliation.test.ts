import assert from "node:assert/strict";
import test from "node:test";
import type { BotManagedWorkspaceResolution } from "../bot-managed-workspace-core.js";
import type { Chat } from "../types.js";
import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";
import { createTelegramBotBindingAuthorityNarrower } from "./telegram-bot-binding-authority.js";
import { reconcileTelegramBotBindings } from "./telegram-bot-binding-reconciliation.js";

const BOT_ID = "bot:planner";
const HOME_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "telegram-bot-11111111-1111-4111-8111-111111111111";

function binding(overrides: Partial<TelegramBotBinding> = {}): TelegramBotBinding {
  return {
    botId: BOT_ID,
    profile: "work",
    chatId: 42,
    ownerUserId: 7,
    workspaceId: "external-project",
    backingWorkspaceId: HOME_ID,
    backingChatId: CHAT_ID,
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
    ...overrides,
  };
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: CHAT_ID,
    title: "Planner",
    workspaceId: HOME_ID,
    botId: BOT_ID,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...overrides,
  };
}

function policy(overrides: { botId?: string } = {}) {
  return {
    botId: BOT_ID,
    ...overrides,
  };
}

function fixture(options: {
  bindings?: TelegramBotBinding[];
  initialChat?: Chat;
  access?: { botId: string };
  homeId?: string;
  failCreate?: boolean;
  failDisable?: boolean;
  failAccess?: boolean;
} = {}) {
  const chats = new Map<string, Chat>();
  if (options.initialChat) chats.set(options.initialChat.id, options.initialChat);
  const disabled: string[] = [];
  const creates: Array<{ audienceId: string; chatId: string }> = [];
  const managedWorkspace = {
    botId: BOT_ID,
    workspaceId: options.homeId ?? HOME_ID,
    createdAt: 1,
    homePath: "/private/bot-home",
    incarnation: { device: "1", inode: "2" },
  } satisfies BotManagedWorkspaceResolution;

  const authority = createTelegramBotBindingAuthorityNarrower({
    async unbind(botId: string) {
      if (options.failDisable) throw new Error("disk unavailable");
      disabled.push(botId);
      return binding({ botId, enabled: false });
    },
    async unbindProfile() {
      throw new Error("startup reconciliation never disables a whole profile");
    },
  });
  const deps = {
    async listBindings() {
      return options.bindings ?? [binding()];
    },
    async disableBinding(botId: string) {
      await authority.disableBot(botId);
    },
    async withBotMutation<Result>(
      _botId: string,
      action: (operations: {
        createChat(input: { audienceId: string; chatId: string }): Promise<Chat>;
        managedWorkspace: BotManagedWorkspaceResolution;
      }) => Promise<Result>,
    ) {
      return action({
        managedWorkspace,
        createChat: async (input) => {
          creates.push(input);
          if (options.failCreate) throw new Error("create failed");
          const created = chat({ id: input.chatId });
          chats.set(created.id, created);
          return created;
        },
      });
    },
    async getChat(chatId: string) {
      return chats.get(chatId) ?? null;
    },
    async getChatAccess() {
      if (options.failAccess) throw new Error("policy unavailable");
      return options.access ?? policy();
    },
  };

  return { deps, chats, disabled, creates };
}

test("repairs a binding committed before its backing chat and is idempotent after restart", async () => {
  const state = fixture();
  const first = await reconcileTelegramBotBindings(state.deps);
  const second = await reconcileTelegramBotBindings(state.deps);

  assert.deepEqual(first, { inspected: 1, repaired: 1, disabled: 0 });
  assert.deepEqual(second, { inspected: 1, repaired: 0, disabled: 0 });
  assert.deepEqual(state.creates, [{ audienceId: "telegram:work", chatId: CHAT_ID }]);
  assert.deepEqual(state.disabled, []);
  assert.equal(state.chats.get(CHAT_ID)?.workspaceId, HOME_ID);
});

test("keeps an exact existing backing chat enabled only when its policy is accessible", async () => {
  const state = fixture({ initialChat: chat() });

  assert.deepEqual(await reconcileTelegramBotBindings(state.deps), {
    inspected: 1,
    repaired: 0,
    disabled: 0,
  });
  assert.deepEqual(state.creates, []);
  assert.deepEqual(state.disabled, []);
});

test("durably disables bindings with a mismatched home, chat, or policy owner", async () => {
  const cases = [
    fixture({ homeId: "22222222-2222-4222-8222-222222222222" }),
    fixture({ initialChat: chat({ botId: "bot:other" }) }),
    fixture({ initialChat: chat(), access: policy({ botId: "bot:other" }) }),
    fixture({ initialChat: chat(), failAccess: true }),
  ];

  for (const state of cases) {
    assert.deepEqual(await reconcileTelegramBotBindings(state.deps), {
      inspected: 1,
      repaired: 0,
      disabled: 1,
    });
    assert.deepEqual(state.disabled, [BOT_ID]);
  }
});

test("disables a binding when backing-chat repair fails", async () => {
  const state = fixture({ failCreate: true });

  assert.deepEqual(await reconcileTelegramBotBindings(state.deps), {
    inspected: 1,
    repaired: 0,
    disabled: 1,
  });
  assert.deepEqual(state.disabled, [BOT_ID]);
});

test("propagates a durable-disable failure so Telegram startup can remain closed", async () => {
  const state = fixture({
    homeId: "22222222-2222-4222-8222-222222222222",
    failDisable: true,
  });

  await assert.rejects(reconcileTelegramBotBindings(state.deps), /disk unavailable/u);
});

test("ignores disabled records returned by a defensive dependency", async () => {
  const state = fixture({ bindings: [binding({ enabled: false })] });
  assert.deepEqual(await reconcileTelegramBotBindings(state.deps), {
    inspected: 0,
    repaired: 0,
    disabled: 0,
  });
});
