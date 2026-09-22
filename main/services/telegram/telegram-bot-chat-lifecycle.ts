import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";

export const TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE =
  "Disconnect Telegram from this Bot before deleting its Telegram conversation.";

export async function assertTelegramBackingChatMayBeDeleted(input: {
  botId: string;
  chatId: string;
  getBinding(botId: string): Promise<TelegramBotBinding | null>;
}): Promise<void> {
  const binding = await input.getBinding(input.botId);
  if (binding?.enabled && binding.backingChatId === input.chatId) {
    throw new Error(TELEGRAM_BACKING_CHAT_DELETE_BLOCKED_MESSAGE);
  }
}
