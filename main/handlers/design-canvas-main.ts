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
  designCanvasSnapshots,
  designModeConsent,
} from "../services/design-canvas/main.js";
import { chatApplicationService } from "../services/chat-application-service-main.js";
import { renderDesignFrame } from "../services/design-canvas/frame-render.js";
import { exportStoredHtmlArtifact, wrapStoredHtmlArtifact } from "../services/gui-artifact-recovery.js";
import { generativeUiArtifactStore } from "../services/generative-ui-artifact-store.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { designModeEnabled } from "../services/studio/feature-flags.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL, registerDesignCanvasHandlers } from "./design-canvas.js";

export function registerDesignCanvasIpc(): void {
  // The canvas picture Aiden asked for with canvas_read {snapshot: true}.
  ipcMain.handle("designCanvas:snapshotAnswer", (event, requestId: unknown, dataUrl: unknown) =>
    designModeEnabled() &&
    designCanvasSnapshots.answer(requestId, dataUrl, rendererDocumentOwner(event, () => new Error("Active renderer required."))),
  );
  // The person's answer on Aiden's "Enter design mode?" card. Enter turns
  // design mode on the way the Design toggle does, then tells every window.
  ipcMain.handle("designCanvas:consentAnswer", async (event, requestId: unknown, answer: unknown) => {
    if (!designModeEnabled()) return false;
    return designModeConsent.answer(
      requestId,
      answer,
      rendererDocumentOwner(event, () => new Error("Active renderer required.")),
      async (chatId) => {
        await chatApplicationService.setDesignMode(chatId, true, { rejectFeatureOwned: true });
        ipcMain.broadcast("chats:design-mode-changed", { chatId, designMode: true });
      },
    );
  });
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
        getZoomFactor: () => window.webContents.getZoomFactor(),
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
    saveFile: async (event, options) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.SaveDialogOptions = {
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties: ["createDirectory", "showOverwriteConfirmation"],
      };
      const result =
        window && !window.isDestroyed()
          ? await dialog.showSaveDialog(window, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    renderFrame: renderDesignFrame,
    artifactPreview: (chatId, mediaId, theme) => wrapStoredHtmlArtifact({ chatId, mediaId, theme }),
    artifactHtml: (chatId, mediaId) => generativeUiArtifactStore.htmlFor(chatId, mediaId),
    exportArtifactSource: async (event, chatId, mediaId) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) throw new Error("The export window is unavailable.");
      return exportStoredHtmlArtifact({ chatId, mediaId, parent });
    },
  });
}
