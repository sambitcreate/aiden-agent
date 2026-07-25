// The Aiden assistant window: a compact, focusable, closable companion window
// modeled on the dictation pill's lifecycle but shaped like a small chat app.
// Unlike the pill it takes focus and can be closed, so it is recreated on demand
// rather than living for the app's lifetime.

import { BrowserWindow, logger, screen } from "../platform.js";
import type { IpcMainInvokeEvent } from "electron";
import { getAssistantPreloadPath, getWindowUrl } from "./window-paths.js";
import { isTrustedWindowSender } from "./window-sender.js";

const WIDTH = 400;
const HEIGHT = 640;
/** Gap between the window and the edges of the usable work area. */
const EDGE_MARGIN = 24;

let assistantWindow: BrowserWindow | null = null;
let loading: Promise<BrowserWindow> | null = null;
let assistantUrl = "";

function positionAssistant(window: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  const [width, height] = window.getSize();
  window.setBounds({
    x: Math.round(workArea.x + workArea.width - width - EDGE_MARGIN),
    y: Math.round(workArea.y + EDGE_MARGIN),
    width,
    height,
  });
}

async function createAssistantWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    titleBarStyle: "hidden",
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
    hasShadow: true,
    alwaysOnTop: false,
    focusable: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    closable: true,
    show: false,
    webPreferences: {
      preload: getAssistantPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.on("closed", () => {
    assistantWindow = null;
  });

  const loaded = new Promise<BrowserWindow>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve(window));
    window.webContents.once("did-fail-load", (_event, code, description) =>
      reject(new Error(`Assistant window failed to load (${code}): ${description}`)),
    );
  });

  const url = getWindowUrl("assistant.html");
  assistantUrl = url;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== assistantUrl) event.preventDefault();
  });
  logger.info("assistant", "Loading the Aiden assistant window", { url });
  void window.loadURL(url);
  return loaded;
}

async function ensureAssistantWindow(): Promise<BrowserWindow> {
  if (assistantWindow && !assistantWindow.isDestroyed()) return assistantWindow;
  if (!loading) {
    loading = createAssistantWindow().finally(() => {
      loading = null;
    });
  }
  assistantWindow = await loading;
  positionAssistant(assistantWindow);
  return assistantWindow;
}

/** Show and focus the assistant window, creating it if it is not open. */
export async function showAssistantWindow(): Promise<BrowserWindow> {
  const window = await ensureAssistantWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

export function hideAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.hide();
}

export async function toggleAssistantWindow(): Promise<void> {
  if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
    // Visible but behind another app: bring it forward rather than hiding it.
    if (assistantWindow.isFocused()) {
      assistantWindow.hide();
      return;
    }
    assistantWindow.focus();
    return;
  }
  await showAssistantWindow();
}

export function destroyAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.destroy();
  assistantWindow = null;
}

export function isCurrentAssistantEvent(event: IpcMainInvokeEvent): boolean {
  const current =
    assistantWindow && !assistantWindow.isDestroyed() ? assistantWindow.webContents.id : null;
  const frame = event.senderFrame;
  if (!frame) return false;
  return isTrustedWindowSender(current, assistantUrl, {
    webContentsId: event.sender.id,
    frameUrl: frame.url,
    isMainFrame: frame === event.sender.mainFrame,
  });
}
