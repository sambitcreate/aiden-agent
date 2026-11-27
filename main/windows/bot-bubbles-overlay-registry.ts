// The pages that are Bot bubble overlays. Kept apart from the overlay manager
// so services deep in the Bot runtime can ask "is Aiden in front?" without
// importing the bubble service.

import { BrowserWindow } from "../platform.js";

/** Every overlay page main ever made (ids are never reused), so a closing overlay still counts. */
const overlayWebContentsIds = new Set<number>();

export function registerBotBubbleOverlayWebContents(webContentsId: number): void {
  overlayWebContentsIds.add(webContentsId);
}

export function isBotBubbleOverlayWebContents(webContentsId: number): boolean {
  return overlayWebContentsIds.has(webContentsId);
}

/**
 * Whether an Aiden window other than a bubble overlay has focus. Banners that
 * show only while Aiden isn't in front use this: a focused mini chat doesn't
 * mean the person can see the main window.
 */
export function isAidenAppWindowFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  return focused !== null && !focused.isDestroyed() && !isBotBubbleOverlayWebContents(focused.webContents.id);
}
