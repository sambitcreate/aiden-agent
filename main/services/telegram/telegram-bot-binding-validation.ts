import type { TelegramBotBinding } from "./telegram-bot-binding-store.js";
import type { TelegramBotBindingSnapshot } from "./telegram-queue.js";

export const TELEGRAM_BOT_BINDING_VALIDATION_COPY = Object.freeze({
  temporarilyUnavailable:
    "This bot is temporarily unavailable. Open Aiden on the Mac to repair it.",
  unavailableOrArchived: "This bot is unavailable or archived.",
  bindingChanged: "This Telegram bot binding has changed or was disabled.",
  conversationMismatch:
    "This Telegram bot binding no longer matches the bot’s private conversation.",
  ownerMismatch: "The Telegram profile owner no longer matches this bot binding.",
});

export type TelegramBotBindingValidationResult = true | string;

export interface TelegramBotBindingValidationDependencies {
  getBot(botId: string): Promise<{ id: string; archivedAt?: number } | null>;
  getProfileOwnerUserId(profile: string): Promise<number | undefined>;
  getActiveBinding(botId: string): Promise<TelegramBotBinding | null>;
  resolveManagedWorkspace(
    botId: string,
  ): Promise<{ botId: string; workspaceId: string }>;
  getChatAccess(chatId: string): Promise<{ botId: string; chatId: string }>;
}

function sameActiveBinding(
  expected: TelegramBotBindingSnapshot,
  actual: TelegramBotBinding | null,
): boolean {
  return Boolean(
    actual?.enabled === true &&
      actual.botId === expected.botId &&
      actual.profile === expected.profile &&
      actual.chatId === expected.chatId &&
      actual.threadId === expected.threadId &&
      actual.ownerUserId === expected.ownerUserId &&
      actual.workspaceId === expected.workspaceId &&
      actual.backingWorkspaceId === expected.backingWorkspaceId &&
      actual.backingChatId === expected.backingChatId,
  );
}

/**
 * Re-prove every main-owned identity behind an already resolved Telegram route.
 * Dependency errors collapse to one fixed repair message so private storage,
 * policy, and managed-home failures never cross the Telegram boundary.
 */
export function createTelegramBotBindingValidator(
  dependencies: TelegramBotBindingValidationDependencies,
) {
  return async (
    binding: TelegramBotBindingSnapshot,
  ): Promise<TelegramBotBindingValidationResult> => {
    let bot: Awaited<ReturnType<typeof dependencies.getBot>>;
    let ownerUserId: Awaited<
      ReturnType<typeof dependencies.getProfileOwnerUserId>
    >;
    let activeBinding: Awaited<
      ReturnType<typeof dependencies.getActiveBinding>
    >;
    let managedWorkspace: Awaited<
      ReturnType<typeof dependencies.resolveManagedWorkspace>
    >;
    let access: Awaited<ReturnType<typeof dependencies.getChatAccess>>;
    try {
      [bot, ownerUserId, activeBinding, managedWorkspace, access] =
        await Promise.all([
          dependencies.getBot(binding.botId),
          dependencies.getProfileOwnerUserId(binding.profile),
          dependencies.getActiveBinding(binding.botId),
          dependencies.resolveManagedWorkspace(binding.botId),
          dependencies.getChatAccess(binding.backingChatId),
        ]);
    } catch {
      return TELEGRAM_BOT_BINDING_VALIDATION_COPY.temporarilyUnavailable;
    }

    if (!bot || bot.id !== binding.botId || bot.archivedAt !== undefined) {
      return TELEGRAM_BOT_BINDING_VALIDATION_COPY.unavailableOrArchived;
    }
    if (!sameActiveBinding(binding, activeBinding)) {
      return TELEGRAM_BOT_BINDING_VALIDATION_COPY.bindingChanged;
    }
    if (
      managedWorkspace.botId !== binding.botId ||
      managedWorkspace.workspaceId !== binding.backingWorkspaceId ||
      access.botId !== binding.botId ||
      access.chatId !== binding.backingChatId
    ) {
      return TELEGRAM_BOT_BINDING_VALIDATION_COPY.conversationMismatch;
    }
    if (ownerUserId !== binding.ownerUserId) {
      return TELEGRAM_BOT_BINDING_VALIDATION_COPY.ownerMismatch;
    }
    return true;
  };
}
