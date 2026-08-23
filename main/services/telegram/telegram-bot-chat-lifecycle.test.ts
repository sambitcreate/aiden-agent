import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";
import {
  assertTelegramBackingChatMayBeDeleted,
  TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE,
} from "./telegram-bot-chat-lifecycle.js";

const binding: TelegramBotBinding = {
  botId: "bot:one",
  profile: "work",
  chatId: 7,
  ownerUserId: 7,
  workspaceId: "external",
  backingWorkspaceId: "managed-home",
  backingChatId: "telegram-bot-11111111-1111-4111-8111-111111111111",
  createdAt: 1,
  updatedAt: 1,
  enabled: true,
};

test("enabled backing conversation deletion is rejected with fixed product-safe copy", async () => {
  await assert.rejects(
    assertTelegramBackingChatMayBeDeleted({
      botId: binding.botId,
      chatId: binding.backingChatId,
      getBinding: async () => binding,
    }),
    (error: unknown) => {
      assert.equal(
        (error as Error).message,
        TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE,
      );
      return true;
    },
  );
});

test("ordinary and disabled backing conversations remain deletable", async () => {
  for (const candidate of [null, { ...binding, enabled: false }, binding]) {
    await assert.doesNotReject(
      assertTelegramBackingChatMayBeDeleted({
        botId: binding.botId,
        chatId: candidate === binding ? "chat:ordinary" : binding.backingChatId,
        getBinding: async () => candidate,
      }),
    );
  }
});
