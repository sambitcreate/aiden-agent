// Production wiring for the design canvas. No logic here: the store and the
// handlers are tested directly. Constructing the store does no I/O, so
// workspace cleanup can remove a canvas even while the design-mode flag is off.
import path from "node:path";
import { persistedChatWorkspaceId } from "../../../renderer/shared/chat-workspace.js";
import { app, ipcMain, logger } from "../../platform.js";
import { chatStore } from "../chat-store.js";
import { DesignCanvasSnapshots } from "./canvas-snapshots.js";
import { DesignModeConsent } from "./design-mode-tool.js";
import { DesignSystemOffers } from "./design-system-offers.js";
import { DesignGrantRegistry } from "./grants.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL, DesignCanvasStore, DesignChatCanvases, type DesignCanvasUpdated } from "./store.js";
import { DesignCanvasViews } from "./views.js";
import { DESIGN_FILES_CHANGED_CHANNEL, DesignFileWatcher } from "./watch.js";
import { RecentWrittenPages } from "./written-pages.js";

/** One canvas file per workspace, under `userData/design-canvases/`. */
export const designWorkspaceCanvasStore = new DesignCanvasStore({
  root: () => path.join(app.getPath("userData"), "design-canvases"),
});

/** The workspace canvases seen through chats: what handlers, tools and placements use. */
export const designCanvasStore = new DesignChatCanvases({
  store: designWorkspaceCanvasStore,
  workspaceIdOf: async (chatId) => {
    const meta = await chatStore.getMeta(chatId);
    return meta ? persistedChatWorkspaceId(meta.workspaceId) : null;
  },
});

/**
 * Tells every window that a workspace's canvas changed. The store call that
 * made the change returned the workspace it used, and that is the one named.
 * A broadcast that fails is logged: the change itself has landed.
 */
export function broadcastDesignCanvasUpdate(update: DesignCanvasUpdated): void {
  try {
    ipcMain.broadcast(DESIGN_CANVAS_UPDATED_CHANNEL, update);
  } catch (error) {
    logger.warn("design", "Could not announce a canvas change.", error);
  }
}

/**
 * Each chat's canvas view (page, viewports, the latest Aiden page change), as
 * its canvas reports it and Aiden's tools change it. Persisted per workspace
 * under `userData/design-canvas-views/`; whether a canvas is open is memory only.
 */
export const designCanvasViews = new DesignCanvasViews({
  root: () => path.join(app.getPath("userData"), "design-canvas-views"),
  onError: (error) => logger.warn("design", "Could not read or save design canvas views.", error),
});

/** Live `aiden-design://` grants. Memory only: a restart ends every grant. */
export const designGrants = new DesignGrantRegistry();

/**
 * Reloads frames when their workspace files change. A chat is watched only
 * while it holds a grant for that folder, so turning design mode off, deleting
 * the chat or removing its workspace (each revokes the grant) also stops it.
 */
export const designFileWatcher = new DesignFileWatcher({
  onChange: (update) => ipcMain.broadcast(DESIGN_FILES_CHANGED_CHANNEL, update),
  allowed: (chatId, root) => designGrants.holds(chatId, root),
});

/** Consent cards for Aiden's `design_mode` enter requests. Memory only. */
export const designModeConsent = new DesignModeConsent();

/** Pending `canvas_read` snapshot requests. Memory only. */
export const designCanvasSnapshots = new DesignCanvasSnapshots();

/** HTML pages each chat's replies wrote in this run, for opening design mode mid-reply. Memory only. */
export const recentWrittenPages = new RecentWrittenPages();

/** Workspaces already offered a tokens file from their own colours and fonts. */
export const designSystemOffers = new DesignSystemOffers({
  file: () => path.join(app.getPath("userData"), "design-system-offers.json"),
  onSaveError: (error) => logger.warn("design", "Could not record the design-system offer.", error),
});
