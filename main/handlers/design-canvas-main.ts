// Production wiring for the design canvas IPC; the handlers live in
// design-canvas.ts and are tested there.
import { BrowserWindow, dialog, ipcMain } from "../platform.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { chatStore } from "../services/chat-store.js";
import { configStore } from "../services/config-store.js";
import {
  broadcastDesignCanvasUpdate,
  designCanvasStore,
  designCanvasViews,
  designFileWatcher,
  designGrants,
  designCanvasSnapshots,
  designModeConsent,
  designAppRoots,
  designMdReader,
  designAppConsent,
  designAppServers,
} from "../services/design-canvas/main.js";
import { chatApplicationService } from "../services/chat-application-service-main.js";
import { renderDesignFrame } from "../services/design-canvas/frame-render.js";
import { exportStoredHtmlArtifact, wrapStoredHtmlArtifact } from "../services/gui-artifact-recovery.js";
import { generativeUiArtifactStore } from "../services/generative-ui-artifact-store.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { designLiveEnabled, designModeEnabled } from "../services/studio/feature-flags.js";
import { installedAppNetwork } from "../services/design-canvas/app-frames/app-network-main.js";
import { renderAppFrame } from "../services/design-canvas/app-frames/app-export.js";
import { registerDesignCanvasHandlers } from "./design-canvas.js";
import { createDesignModeCardEnter, registerDesignAppHandlers } from "./design-app.js";

/** Windows whose reload, crash or destruction already unmounts every canvas view. */
const watchedSenders = new WeakSet<Electron.WebContents>();
/** Windows whose minimize, restore, hide and show already re-count canvas presence. */
const watchedWindows = new WeakSet<Electron.BrowserWindow>();

export function registerDesignCanvasIpc(): void {
  // The canvas picture Aiden asked for with canvas_read {snapshot: true}.
  ipcMain.handle("designCanvas:snapshotAnswer", (event, requestId: unknown, dataUrl: unknown) =>
    designModeEnabled() &&
    designCanvasSnapshots.answer(requestId, dataUrl, rendererDocumentOwner(event, () => new Error("Active renderer required."))),
  );
  // The person's answer on Aiden's "Enter design mode?" card. Enter turns
  // design mode on the way the Design toggle does, then tells every window;
  // with the live flag on it also starts the workspace's app for this window.
  const cardEnter = createDesignModeCardEnter({
    // Waits for the chat's page, so Aiden's first placement after "entered" lands there.
    setDesignMode: (chatId) => chatApplicationService.setDesignMode(chatId, true, { rejectFeatureOwned: true, awaitEntry: true }),
    broadcastEntered: (chatId) => ipcMain.broadcast("chats:design-mode-changed", { chatId, designMode: true }),
    designApp: { enabled: () => designLiveEnabled(), entered: (input) => designAppServers.designModeEntered(input) },
  });
  ipcMain.handle("designCanvas:consentAnswer", async (event, requestId: unknown, answer: unknown) => {
    if (!designModeEnabled()) return false;
    const owner = rendererDocumentOwner(event, () => new Error("Active renderer required."));
    return designModeConsent.answer(requestId, answer, owner, cardEnter(owner));
  });
  // Design mode's live apps: the person's controls and the run-app card's answer.
  registerDesignAppHandlers<Electron.IpcMainInvokeEvent>({
    enabled: () => designLiveEnabled(),
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    owner: (event) => rendererDocumentOwner(event, () => new Error("Active renderer required.")),
    // Index metadata only: these checks never need the transcript.
    getChat: (chatId) => chatStore.getMeta(chatId),
    workspace: (workspaceId) => configStore.getWorkspace(workspaceId),
    servers: designAppServers,
    consent: designAppConsent,
  });
  registerDesignCanvasHandlers<Electron.IpcMainInvokeEvent>({
    enabled: () => designModeEnabled(),
    designMd: { enabled: () => designLiveEnabled(), reader: designMdReader, appRoots: designAppRoots },
    appFrames: {
      enabled: () => designLiveEnabled(),
      registry: () => installedAppNetwork()?.registry ?? null,
      clearSettled: async (origin) => {
        await installedAppNetwork()?.clearSettled(origin);
      },
      // Download draws the running app on the default session, as an export window (D18).
      renderApp: (request) => renderAppFrame(request, () => installedAppNetwork()?.registry ?? null),
      apps: designAppServers,
    },
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    store: designCanvasStore,
    broadcast: broadcastDesignCanvasUpdate,
    // Index metadata only: these checks never need the transcript.
    getChat: (chatId) => chatStore.getMeta(chatId),
    grants: designGrants,
    views: designCanvasViews,
    senderWindowShown: (event, changed) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return () => false;
      if (!watchedWindows.has(window)) {
        watchedWindows.add(window);
        window.on("minimize", changed);
        window.on("restore", changed);
        window.on("hide", changed);
        window.on("show", changed);
      }
      // Electron's own state, not the document's: macOS can report an occluded window's document hidden.
      return () => !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    },
    whenSenderResets: (event, reset) => {
      const sender = event.sender;
      if (watchedSenders.has(sender)) return;
      watchedSenders.add(sender);
      // A main-frame navigation is a reload: every canvas in the window is gone.
      sender.on("did-navigate", reset);
      sender.on("render-process-gone", reset);
      sender.once("destroyed", reset);
    },
    sendFocus: (event, request) => {
      if (!event.sender.isDestroyed()) event.sender.send("designCanvas:focus", request);
    },
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
    artifactTitle: async (chatId, mediaId) => (await generativeUiArtifactStore.artifactFor(chatId, mediaId))?.title,
    exportArtifactSource: async (event, chatId, mediaId) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) throw new Error("The export window is unavailable.");
      return exportStoredHtmlArtifact({ chatId, mediaId, parent });
    },
  });
}
