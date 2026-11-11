// Production wiring for the design canvas. No logic here: the store and the
// handlers are tested directly. Constructing the store does no I/O, so chat
// deletion can clean up a canvas even while the design-mode flag is off.
import path from "node:path";
import { app, ipcMain } from "../../platform.js";
import { DesignCanvasSnapshots } from "./canvas-snapshots.js";
import { DesignModeConsent } from "./design-mode-tool.js";
import { DesignGrantRegistry } from "./grants.js";
import { DesignCanvasStore } from "./store.js";
import { DESIGN_FILES_CHANGED_CHANNEL, DesignFileWatcher } from "./watch.js";

export const designCanvasStore = new DesignCanvasStore({
  root: () => path.join(app.getPath("userData"), "design-canvases"),
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
