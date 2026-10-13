// Wires the chat image actions (save to Downloads, copy, reveal) to Electron.
// The behaviour lives in ../services/chat-image-actions.ts.

import { app, clipboard, ipcMain, nativeImage, shell } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { registerChatImageActionHandlers as register } from "../services/chat-image-actions.js";

export function registerChatImageActionHandlers(): void {
  register(ipcMain as never, {
    getChat: (chatId) => chatStore.get(chatId),
    downloadsDir: () => app.getPath("downloads"),
    writeClipboardImage: (bytes) => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error("Unreadable image.");
      clipboard.writeImage(image);
    },
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
  });
}
