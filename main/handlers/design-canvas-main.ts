// Production wiring for the design canvas IPC; the handlers live in
// design-canvas.ts and are tested there.
import { ipcMain } from "../platform.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { chatStore } from "../services/chat-store.js";
import { configStore } from "../services/config-store.js";
import { designCanvasStore, designGrants } from "../services/design-canvas/main.js";
import { designModeEnabled } from "../services/studio/feature-flags.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL, registerDesignCanvasHandlers } from "./design-canvas.js";

export function registerDesignCanvasIpc(): void {
  registerDesignCanvasHandlers<Electron.IpcMainInvokeEvent>({
    enabled: () => designModeEnabled(),
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    store: designCanvasStore,
    broadcast: (update) => ipcMain.broadcast(DESIGN_CANVAS_UPDATED_CHANNEL, update),
    getChat: (chatId) => chatStore.get(chatId),
    grants: designGrants,
    workspaceRoot: async (chat) =>
      (await configStore.getWorkspace(persistedChatWorkspaceId(chat.workspaceId)))?.folderPath ??
      null,
  });
}
