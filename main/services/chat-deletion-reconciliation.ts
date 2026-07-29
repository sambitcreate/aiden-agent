export interface PendingChatDeletionStore {
  pendingChatDeletions(): Promise<string[]>;
  completeChatDeletion(chatId: string): Promise<void>;
}

/**
 * Finish crash-interrupted cross-store deletes before any renderer can replay
 * a chat whose private child history was already removed.
 */
export async function reconcilePendingChatDeletions(
  store: PendingChatDeletionStore,
  removeChat: (chatId: string) => Promise<void>,
): Promise<void> {
  for (const chatId of await store.pendingChatDeletions()) {
    await removeChat(chatId);
    await store.completeChatDeletion(chatId);
  }
}
