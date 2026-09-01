import type { ContextLifecycleService } from "./context-lifecycle-service.js";
import {
  telegramCompactionResult,
  type TelegramCompactionResult,
} from "./telegram/telegram-session.js";

/** Production desktop boundary: renderer identity owns admission and cancellation. */
export function compactDesktopChat(
  service: ContextLifecycleService,
  chatId: string,
  ownerDocumentId: string,
) {
  return service.compactChat(
    chatId,
    { kind: "desktop", ownerId: ownerDocumentId },
    "operator",
  );
}

export function cancelDesktopCompaction(
  service: ContextLifecycleService,
  chatId: string,
  ownerDocumentId: string,
): boolean {
  return service.cancelChat(chatId, ownerDocumentId);
}

/** Production Telegram boundary: profile identity never owns model or journal selection. */
export function createTelegramLifecycleAdapter(
  service: ContextLifecycleService,
  profile: string,
): {
  compactChat(chatId: string): Promise<TelegramCompactionResult>;
  cancelChat(chatId: string): boolean;
} {
  const ownerId = `telegram:${profile}`;
  return {
    compactChat: async (chatId) =>
      telegramCompactionResult(
        await service.compactChat(
          chatId,
          { kind: "telegram", profile, ownerId },
          "operator",
        ),
      ),
    cancelChat: (chatId) => service.cancelChat(chatId, ownerId),
  };
}
