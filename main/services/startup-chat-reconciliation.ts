import type { createChatStore } from "./chat-store-core.js";

export interface ChatScopedStore {
  reconcileChats(validChatIds: ReadonlySet<string>): Promise<void>;
}

/**
 * Startup garbage collection for chat-scoped state. It must read the full,
 * unfiltered index: feature-owned chats are hidden from listings, not deleted,
 * and their effect and compaction state has to survive a restart.
 */
export async function reconcileChatScopedStores(
  chatStore: Pick<ReturnType<typeof createChatStore>, "list">,
  stores: readonly ChatScopedStore[],
): Promise<ReadonlySet<string>> {
  const chatIds = new Set((await chatStore.list()).map((chat) => chat.id));
  await Promise.all(stores.map((store) => store.reconcileChats(chatIds)));
  return chatIds;
}
