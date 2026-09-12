import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queries";
import { discardChatMessageQueue } from "./chat-message-queue";

// Chat ids are never reused. Retaining exact tombstones for this renderer
// lifetime prevents queued terminal notifications from reinstalling a
// successfully deleted transcript.
const deletedChatIds = new Set<string>();

export function isChatCacheDeleted(chatId: string): boolean {
  return deletedChatIds.has(chatId);
}

export async function removeDeletedChatFromCache(
  queryClient: QueryClient,
  chatId: string,
): Promise<void> {
  deletedChatIds.add(chatId);
  discardChatMessageQueue(chatId);
  const chatKey = queryKeys.chat(chatId);
  await queryClient.cancelQueries({ queryKey: chatKey, exact: true });
  queryClient.removeQueries({ queryKey: chatKey, exact: true });
}
