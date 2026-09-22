import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";
import {
  createTelegramBotBindingValidator,
  TELEGRAM_BOT_BINDING_VALIDATION_COPY,
  type TelegramBotBindingValidationDependencies,
} from "./telegram-bot-binding-validation.js";

const binding: TelegramBotBinding = {
  botId: "bot:planner",
  profile: "work",
  chatId: 42,
  threadId: 8,
  ownerUserId: 7,
  workspaceId: "external-project",
  backingWorkspaceId: "11111111-1111-4111-8111-111111111111",
  backingChatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
  createdAt: 1,
  updatedAt: 2,
  enabled: true,
};

function dependencies(
  overrides: Partial<TelegramBotBindingValidationDependencies> = {},
): TelegramBotBindingValidationDependencies {
  return {
    getBot: async () => ({ id: binding.botId }),
    getProfileOwnerUserId: async () => binding.ownerUserId,
    getActiveBinding: async () => ({ ...binding }),
    resolveManagedWorkspace: async () => ({
      botId: binding.botId,
      workspaceId: binding.backingWorkspaceId,
    }),
    getChatAccess: async () => ({
      botId: binding.botId,
      chatId: binding.backingChatId,
    }),
    ...overrides,
  };
}

test("production Bot binding validation accepts only the exact live route", async () => {
  assert.equal(await createTelegramBotBindingValidator(dependencies())(binding), true);
});

test("missing, mismatched, and archived Bot identities use fixed unavailable copy", async (t) => {
  for (const [name, getBot] of [
    ["missing", async () => null],
    ["mismatched", async () => ({ id: "bot:other" })],
    ["archived", async () => ({ id: binding.botId, archivedAt: 4 })],
  ] as const) {
    await t.test(name, async () => {
      assert.equal(
        await createTelegramBotBindingValidator(dependencies({ getBot }))(binding),
        TELEGRAM_BOT_BINDING_VALIDATION_COPY.unavailableOrArchived,
      );
    });
  }
});

test("stale route fields, disabled records, and profile-owner drift fail independently", async (t) => {
  for (const [name, active] of [
    ["missing", null],
    ["disabled", { ...binding, enabled: false }],
    ["profile", { ...binding, profile: "personal" }],
    ["chat", { ...binding, chatId: 43 }],
    ["thread", { ...binding, threadId: 9 }],
    ["owner", { ...binding, ownerUserId: 8 }],
    ["external workspace", { ...binding, workspaceId: "other" }],
    ["managed workspace", { ...binding, backingWorkspaceId: "other" }],
    ["backing chat", { ...binding, backingChatId: "telegram-bot-22222222-2222-4222-8222-222222222222" }],
  ] as const) {
    await t.test(name, async () => {
      assert.equal(
        await createTelegramBotBindingValidator(
          dependencies({ getActiveBinding: async () => active }),
        )(binding),
        TELEGRAM_BOT_BINDING_VALIDATION_COPY.bindingChanged,
      );
    });
  }

  assert.equal(
    await createTelegramBotBindingValidator(
      dependencies({ getProfileOwnerUserId: async () => 99 }),
    )(binding),
    TELEGRAM_BOT_BINDING_VALIDATION_COPY.ownerMismatch,
  );
});

test("managed-home and chat-policy identity mismatches use fixed conversation copy", async (t) => {
  const cases: Array<
    readonly [string, Partial<TelegramBotBindingValidationDependencies>]
  > = [
    [
      "managed-home owner",
      {
        resolveManagedWorkspace: async () => ({
          botId: "bot:other",
          workspaceId: binding.backingWorkspaceId,
        }),
      },
    ],
    [
      "managed-home workspace",
      {
        resolveManagedWorkspace: async () => ({
          botId: binding.botId,
          workspaceId: "22222222-2222-4222-8222-222222222222",
        }),
      },
    ],
    [
      "chat-policy owner",
      {
        getChatAccess: async () => ({
          botId: "bot:other",
          chatId: binding.backingChatId,
        }),
      },
    ],
    [
      "chat-policy chat",
      {
        getChatAccess: async () => ({
          botId: binding.botId,
          chatId: "chat:other",
        }),
      },
    ],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      assert.equal(
        await createTelegramBotBindingValidator(dependencies(override))(binding),
        TELEGRAM_BOT_BINDING_VALIDATION_COPY.conversationMismatch,
      );
    });
  }
});

test("private dependency failures collapse to one fixed repair message", async (t) => {
  const failures: Array<
    readonly [string, keyof TelegramBotBindingValidationDependencies]
  > = [
    ["Bot", "getBot"],
    ["profile", "getProfileOwnerUserId"],
    ["binding", "getActiveBinding"],
    ["managed home", "resolveManagedWorkspace"],
    ["chat policy", "getChatAccess"],
  ];
  for (const [name, key] of failures) {
    await t.test(name, async () => {
      const broken = {
        [key]: async () => {
          throw new Error("private storage detail");
        },
      } as Partial<TelegramBotBindingValidationDependencies>;
      assert.equal(
        await createTelegramBotBindingValidator(dependencies(broken))(binding),
        TELEGRAM_BOT_BINDING_VALIDATION_COPY.temporarilyUnavailable,
      );
    });
  }
});
