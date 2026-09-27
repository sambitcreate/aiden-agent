import { app, ipcMain } from "../platform.js";
import { ChatReadMarkerStore, chatReadThroughAt } from "./chat-read-markers.js";
import { chatStore } from "./chat-store.js";

export const chatReadMarkers = new ChatReadMarkerStore(() => app.getPath("userData"), {
  onChange: (snapshot) => ipcMain.broadcast("chats:read-markers-changed", snapshot),
});

/**
 * Mark a regular chat read on behalf of any surface. Returns false when the
 * chat or referenced message no longer exists, so a stale report is a no-op.
 */
export async function markChatRead(chatId: string, throughMessageId?: string): Promise<boolean> {
  const chat = await chatStore.get(chatId);
  if (!chat) return false;
  const throughAt = chatReadThroughAt(chat, throughMessageId);
  if (throughAt === null) return false;
  const sequence =
    throughMessageId === undefined
      ? chat.messages.length -
        1 -
        [...chat.messages]
          .reverse()
          .findIndex((message) => message.role === "user" || message.role === "assistant")
      : chat.messages.findIndex((message) => message.id === throughMessageId);
  await chatReadMarkers.markRead(chatId, throughAt, sequence);
  return true;
}
