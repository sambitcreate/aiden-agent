// Production wiring for the design canvas IPC; the handlers live in
// design-canvas.ts and are tested there.
import { BrowserWindow, dialog, ipcMain } from "../platform.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { chatStore } from "../services/chat-store.js";
import { configStore } from "../services/config-store.js";
import {
  designCanvasStore,
  designFileWatcher,
  designGrants,
} from "../services/design-canvas/main.js";
import { designModeEnabled } from "../services/studio/feature-flags.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL, registerDesignCanvasHandlers } from "./design-canvas.js";

export function registerDesignCanvasIpc(): void {
  registerDesignCanvasHandlers<Electron.IpcMainInvokeEvent>({
    enabled: () => designModeEnabled(),
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    store: designCanvasStore,
    broadcast: (update) => ipcMain.broadcast(DESIGN_CANVAS_UPDATED_CHANNEL, update),
    // Index metadata only: these checks never need the transcript.
    getChat: (chatId) => chatStore.getMeta(chatId),
    grants: designGrants,
    workspaceRoot: async (chat) =>
      (await configStore.getWorkspace(persistedChatWorkspaceId(chat.workspaceId)))?.folderPath ??
      null,
    windowFor: (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) return null;
      return {
        getContentSize: () => window.getContentSize(),
        capturePage: (rect) => window.webContents.capturePage(rect),
      };
    },
    watcher: designFileWatcher,
    pickFile: async (event, options) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.OpenDialogOptions = {
        defaultPath: options.defaultPath,
        properties: ["openFile"],
        filters: options.filters,
      };
      const result =
        window && !window.isDestroyed()
          ? await dialog.showOpenDialog(window, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
}
