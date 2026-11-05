import { app, ipcMain } from "../platform.js";
import { ChatReadMarkerStore, markChatReadThrough } from "./chat-read-markers.js";
import { chatStore } from "./chat-store.js";

export const chatReadMarkers = new ChatReadMarkerStore(() => app.getPath("userData"), {
  onChange: (snapshot) => ipcMain.broadcast("chats:read-markers-changed", snapshot),
});

/**
 * Mark a regular chat read on behalf of any surface. Returns false when the
 * chat or referenced message no longer exists, so a stale report is a no-op.
 */
export async function markChatRead(chatId: string, throughMessageId?: string): Promise<boolean> {
  return markChatReadThrough(chatReadMarkers, await chatStore.get(chatId), throughMessageId);
}
