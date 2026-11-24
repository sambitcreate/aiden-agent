// Production wiring for the design canvas. No logic here: the store and the
// handlers are tested directly. Constructing the store does no I/O, so
// workspace cleanup can remove a canvas even while the design-mode flag is off.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { persistedChatWorkspaceId } from "../../../renderer/shared/chat-workspace.js";
import { app, ipcMain, logger } from "../../platform.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import { DesignCanvasSnapshots } from "./canvas-snapshots.js";
import { createDesignCanvasCarry } from "./carry.js";
import { createDesignChatCleanup, createDesignWorkspaceCleanup } from "./cleanup.js";
import { DesignModeConsent } from "./design-mode-tool.js";
import { runDesignMdWorker } from "./design-md/lint-client.js";
import { createDesignAppRoots } from "./design-md/locate.js";
import { DesignMdOffers } from "./design-md/offers.js";
import { DesignMdReader } from "./design-md/reader.js";
import { DesignSystemOffers } from "./design-system-offers.js";
import { DesignGrantRegistry } from "./grants.js";
import { createDesignLiveChats } from "./liveness.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL, DesignCanvasStore, DesignChatCanvases, type DesignCanvasUpdated } from "./store.js";
import { createDesignTitleFollow } from "./title-follow.js";
import { DesignCanvasViews } from "./views.js";
import { DESIGN_FILES_CHANGED_CHANNEL, DesignFileWatcher } from "./watch.js";
import { PendingEntries, RecentWrittenPages } from "./written-pages.js";

/** One canvas file per workspace, under `userData/design-canvases/`. */
export const designWorkspaceCanvasStore = new DesignCanvasStore({
  root: () => path.join(app.getPath("userData"), "design-canvases"),
});

/** Whether the chat still exists and is in that workspace: a chat that moved away is not live there. */
async function designChatIsLive(chatId: string, workspaceId: string): Promise<boolean> {
  const meta = await chatStore.getMeta(chatId);
  return meta !== null && persistedChatWorkspaceId(meta.workspaceId) === workspaceId;
}

/** Which of `chatIds` are live in the workspace, for claims on its canvas: one chat index read per check. */
export const designLiveChats = createDesignLiveChats(chatStore);

/** The workspace canvases seen through chats: what handlers, tools and placements use. */
export const designCanvasStore = new DesignChatCanvases({
  store: designWorkspaceCanvasStore,
  workspaceIdOf: async (chatId) => {
    const meta = await chatStore.getMeta(chatId);
    return meta ? persistedChatWorkspaceId(meta.workspaceId) : null;
  },
  workspaceExists: async (workspaceId) => (await configStore.getWorkspace(workspaceId)) !== undefined,
  chatIsLive: designChatIsLive,
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

/** A page made for a chat follows the chat's title; entry runs it once more after claiming. */
export const designTitleFollow = createDesignTitleFollow({
  canvases: designCanvasStore,
  titleOf: async (chatId) => (await chatStore.getMeta(chatId))?.title,
  broadcast: broadcastDesignCanvasUpdate,
  onError: (error) => logger.warn("design", "Could not rename the chat's canvas page.", error),
});
chatStore.onTitleChanged((chatId) => void designTitleFollow.follow(chatId));

/**
 * Each chat's canvas view (page, viewports, the latest Aiden page change), as
 * its canvas reports it and Aiden's tools change it. Persisted per workspace
 * under `userData/design-canvas-views/`; whether a canvas is open is memory only.
 */
export const designCanvasViews = new DesignCanvasViews({
  root: () => path.join(app.getPath("userData"), "design-canvas-views"),
  onError: (error) => logger.warn("design", "Could not read or save design canvas views.", error),
});

/** What a deleted chat leaves on its workspace's canvas: its comments and its view go, the canvas stays. */
export const designCanvasChatCleanup = createDesignChatCleanup({
  store: designWorkspaceCanvasStore,
  views: designCanvasViews,
  broadcast: broadcastDesignCanvasUpdate,
});

/** A No workspace chat attached with its files copied brings its canvas pages along. */
export const designCanvasCarry = createDesignCanvasCarry({
  store: designWorkspaceCanvasStore,
  views: designCanvasViews,
  broadcast: broadcastDesignCanvasUpdate,
  newId: randomUUID,
  isLive: designLiveChats,
});

/** A removed workspace's canvas, its corrupt copies and its chats' views of it. */
export const designCanvasWorkspaceCleanup = createDesignWorkspaceCleanup({
  store: designWorkspaceCanvasStore,
  views: designCanvasViews,
});

/**
 * Removes a workspace's canvas files for paths that drop a workspace record
 * outside the workspace service (managed-worktree delete, and its recovery at
 * startup). The record is already gone, so a failure only leaves clutter.
 */
export async function removeDesignCanvasWorkspace(workspaceId: string): Promise<void> {
  await designCanvasWorkspaceCleanup.removeWorkspace(workspaceId).catch((error: unknown) => {
    logger.warn("design", "Could not remove the workspace's design canvas.", error);
  });
}

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

/** Each chat's running design-mode entry, which its turn's canvas writes wait for. Memory only. */
export const designPendingEntries = new PendingEntries();

/** HTML pages each chat's replies wrote in this run, for opening design mode mid-reply. Memory only. */
export const recentWrittenPages = new RecentWrittenPages();

/** Workspaces already offered a tokens file from their own colours and fonts. */
export const designSystemOffers = new DesignSystemOffers({
  file: () => path.join(app.getPath("userData"), "design-system-offers.json"),
  onSaveError: (error) => logger.warn("design", "Could not record the design-system offer.", error),
});

/**
 * The DESIGN.md linter. Lazy: no worker starts until the first check, and the
 * linter itself loads only inside that worker, never on the main thread.
 */
export const designMdLinter: typeof runDesignMdWorker = (request, options = {}) =>
  runDesignMdWorker(request, {
    log: (message) => logger.warn("design", message),
    ...options,
  });

/** Each app's DESIGN.md, linted once per change in this run. Memory only. */
export const designMdReader = new DesignMdReader({
  run: designMdLinter,
  report: reportAnalyticsEvent,
  log: (message) => logger.warn("design", message),
});

/** Workspaces and app roots already offered a DESIGN.md draft (HMACs only). */
export const designMdOffers = new DesignMdOffers({
  file: () => path.join(app.getPath("userData"), "design-md-offers.json"),
  onSaveError: (error) => logger.warn("design", "Could not record the DESIGN.md offer.", error),
});

/** The app roots each workspace's design turns describe, cached on its manifests. Memory only. */
export const designAppRoots = createDesignAppRoots();
