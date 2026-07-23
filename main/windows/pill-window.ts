// Floating transcribe pill: a small frameless, transparent, always-on-top
// window that lives for the app's lifetime and surfaces over whichever app is
// focused while global dictation runs. Recording capture happens in this
// window's renderer, so dictation works even when the main window is closed.

import { BrowserWindow, logger, screen } from "../platform.js";
import type { IpcMainInvokeEvent } from "electron";
import { getPillPreloadPath, getWindowUrl } from "./window-paths.js";
import { isTrustedPillSender } from "./pill-window-security.js";

const PILL_WIDTH = 280;
const PILL_HEIGHT = 56;
/** Gap between the pill and the bottom of the usable work area (Dock-aware). */
const PILL_BOTTOM_OFFSET = 15;

let pillWindow: BrowserWindow | null = null;
let loading: Promise<BrowserWindow> | null = null;
let pillUrl = "";

function positionPill(window: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  window.setBounds({
    x: Math.round(workArea.x + (workArea.width - PILL_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - PILL_HEIGHT - PILL_BOTTOM_OFFSET),
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
  });
}

async function createPillWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    show: false,
    webPreferences: {
      preload: getPillPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The pill records while unfocused/hidden; never throttle its renderer.
      backgroundThrottling: false,
    },
  });

  // Float above other apps (including fullscreen spaces) without stealing focus.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setAlwaysOnTop(true, "status");

  window.on("closed", () => {
    pillWindow = null;
  });

  const loaded = new Promise<BrowserWindow>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve(window));
    window.webContents.once("did-fail-load", (_event, code, description) =>
      reject(new Error(`Pill window failed to load (${code}): ${description}`)),
    );
  });

  const url = getWindowUrl("pill.html");
  pillUrl = url;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== pillUrl) event.preventDefault();
  });
  logger.info("pill", "Loading dictation pill", { url });
  void window.loadURL(url);
  return loaded;
}

/**
 * Show the pill over the display containing the mouse cursor, resolving once
 * its renderer is ready to receive dictation state broadcasts.
 */
export async function showPill(): Promise<boolean> {
  let created = false;
  if (!pillWindow || pillWindow.isDestroyed()) {
    created = true;
    if (!loading) {
      loading = createPillWindow().finally(() => {
        loading = null;
      });
    }
    pillWindow = await loading;
  }
  positionPill(pillWindow);
  pillWindow.showInactive();
  return created;
}

export function hidePill(): void {
  if (pillWindow && !pillWindow.isDestroyed()) pillWindow.hide();
}

export function destroyPill(): void {
  if (pillWindow && !pillWindow.isDestroyed()) pillWindow.destroy();
  pillWindow = null;
}

export function isCurrentPillEvent(event: IpcMainInvokeEvent): boolean {
  const current = pillWindow && !pillWindow.isDestroyed() ? pillWindow.webContents.id : null;
  const frame = event.senderFrame;
  if (!frame) return false;
  return isTrustedPillSender(current, pillUrl, {
    webContentsId: event.sender.id,
    frameUrl: frame.url,
    isMainFrame: frame === event.sender.mainFrame,
  });
}
