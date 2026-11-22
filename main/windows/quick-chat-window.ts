// System-wide Floating Chat Starter (Quick Chat) BrowserWindow.
//
// Uses `type: "panel"` + `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`
// on macOS so it floats cleanly over full-screen Spaces without hiding Aiden's Dock icon.
// Marked as an auxiliary window so it never keeps the process alive on Linux/Windows
// after the last main window closes, and is destroyed in both auxiliary release and quit.

import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, logger, registerBroadcastReceiver, screen } from "../platform.js";
import { QUICK_CHAT_NOTIFICATION_CHANNELS } from "../../renderer/quick-chat-preload-channels.js";
import type {
  QuickChatHandoffCompletePayload,
  QuickChatOpenSource,
  QuickChatWindowMode,
} from "../../renderer/shared/quick-chat.js";
import { configStore } from "../services/config-store.js";
import { captureAnalyticsReporter } from "../services/analytics/analytics-report.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { markAuxiliaryWindow } from "./auxiliary-windows.js";
import { canPositionFloatingWindow } from "./pill-window-platform.js";
import { getQuickChatPreloadPath, getWindowUrl } from "./window-paths.js";
import {
  QUICK_CHAT_STAGE_SIZES,
  computeQuickChatInitialBounds,
  computeQuickChatTransitionBounds,
  shouldHideQuickChatOnBlur,
} from "./quick-chat-window-core.js";
import { isTrustedQuickChatSender } from "./quick-chat-window-security.js";

const DEFAULT_BLUR_SUPPRESS_MS = 500;
const MAX_BLUR_SUPPRESS_MS = 10_000;

let quickChatWindow: BrowserWindow | null = null;
let loading: Promise<BrowserWindow> | null = null;
/** Track the window mid-load so destroyQuickChat() can tear it down safely. */
let loadingWindow: BrowserWindow | null = null;
let quickChatUrl = "";
let destroying = false;
let currentMode: QuickChatWindowMode = "starter";
let suppressBlurUntil = 0;
let cachedKeepOpenOnBlur = true;
/** Chat IDs explicitly created within this Quick Chat session (never unrelated chats). */
const authorizedQuickChatIds = new Set<string>();

export function authorizeQuickChatConversation(chatId: string): void {
  if (chatId) authorizedQuickChatIds.add(chatId);
}

export function revokeQuickChatConversation(chatId: string): void {
  authorizedQuickChatIds.delete(chatId);
}

export function isQuickChatAuthorizedConversation(chatId: string): boolean {
  return authorizedQuickChatIds.has(chatId);
}

export function assertQuickChatConversationAccess(
  event: IpcMainInvokeEvent,
  chatId: string,
): void {
  if (isCurrentQuickChatEvent(event) && !authorizedQuickChatIds.has(chatId)) {
    throw new Error("Unauthorized Quick Chat conversation access.");
  }
}

function cursorWorkArea() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function windowWorkArea(window: BrowserWindow) {
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return display.workArea;
}

export function syncQuickChatSettings(settings: { quickChatKeepOpenOnBlur?: boolean }): void {
  cachedKeepOpenOnBlur = settings.quickChatKeepOpenOnBlur !== false;
}

async function refreshKeepOpenOnBlurSetting(): Promise<boolean> {
  try {
    const settings = await configStore.getSettings();
    syncQuickChatSettings(settings);
  } catch {
    // Keep prior cached preference on transient read failure.
  }
  return cachedKeepOpenOnBlur;
}

async function createQuickChatWindow(): Promise<BrowserWindow> {
  const initial = QUICK_CHAT_STAGE_SIZES.starter;
  const window = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: getQuickChatPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep active streams, approvals, and voice capture responsive while floating.
      backgroundThrottling: false,
    },
  });

  // Never count as an app window: must not keep Linux/Windows running after main closes.
  markAuxiliaryWindow(window);
  // Only receive notifications explicitly allowed for Quick Chat.
  registerBroadcastReceiver(window, QUICK_CHAT_NOTIFICATION_CHANNELS, (channel, payload) => {
    if (channel !== "chats:metadata-updated") return true;
    const chatId =
      typeof payload === "object" && payload !== null && "chatId" in payload
        ? (payload as { chatId?: unknown }).chatId
        : undefined;
    return typeof chatId === "string" && authorizedQuickChatIds.has(chatId);
  });

  // CRITICAL on macOS: `skipTransformProcessType: true` prevents Electron from
  // hiding Aiden's Dock icon when showing over full-screen Spaces.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    ...(process.platform === "darwin" ? { skipTransformProcessType: true } : {}),
  });
  window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");

  loadingWindow = window;
  window.on("close", (event) => {
    if (!destroying) {
      event.preventDefault();
      hideQuickChat();
    }
  });
  window.on("blur", () => {
    if (quickChatWindow !== window || window.isDestroyed() || !window.isVisible()) return;
    if (
      shouldHideQuickChatOnBlur({
        mode: currentMode,
        keepOpenOnBlur: cachedKeepOpenOnBlur,
        now: Date.now(),
        suppressBlurUntil,
      })
    ) {
      hideQuickChat();
    }
  });
  window.on("closed", () => {
    if (quickChatWindow === window) quickChatWindow = null;
    if (loadingWindow === window) loadingWindow = null;
    currentMode = "starter";
    authorizedQuickChatIds.clear();
  });

  const loaded = new Promise<BrowserWindow>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve(window));
    window.once("closed", () => reject(new Error("Quick Chat window closed before it loaded")));
    window.webContents.once("did-fail-load", (_event, code, description, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      if (!window.isDestroyed()) window.destroy();
      reject(new Error(`Quick Chat window failed to load (${code}): ${description}`));
    });
  });

  const url = getWindowUrl("quick-chat.html");
  quickChatUrl = url;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== quickChatUrl) event.preventDefault();
  });
  logger.info("quick-chat", "Loading floating chat starter window", { url });
  void window.loadURL(url);
  return loaded;
}

async function ensureQuickChat(): Promise<{ window: BrowserWindow; created: boolean }> {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    return { window: quickChatWindow, created: false };
  }
  if (!loading) {
    loading = createQuickChatWindow().finally(() => {
      loading = null;
      loadingWindow = null;
    });
  }
  quickChatWindow = await loading;
  return { window: quickChatWindow, created: true };
}

/** Pre-warm the hidden Quick Chat window after app startup so the first hotkey feels instant. */
export async function prepareQuickChat(): Promise<boolean> {
  return (await ensureQuickChat()).created;
}

export function isQuickChatVisible(): boolean {
  return Boolean(quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible());
}

export function suppressQuickChatBlurHide(durationMs = DEFAULT_BLUR_SUPPRESS_MS): void {
  const clamped = Math.max(0, Math.min(Math.round(durationMs), MAX_BLUR_SUPPRESS_MS));
  suppressBlurUntil = Math.max(suppressBlurUntil, Date.now() + clamped);
}

export function resetQuickChatBlurSuppression(): void {
  suppressBlurUntil = 0;
}

export function notifyQuickChatOpened(source: QuickChatOpenSource): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  quickChatWindow.webContents.send("quickChat:opened", { source });
}

export function notifyQuickChatHandoffComplete(payload: QuickChatHandoffCompletePayload): void {
  if (payload.kind === "chat") {
    authorizedQuickChatIds.delete(payload.chatId);
  }
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  quickChatWindow.webContents.send("quickChat:handoff-complete", payload);
}

/**
 * Show and focus the floating window on the display containing the mouse cursor.
 * If already hidden, places it cleanly for its current mode (`starter` or `modal`).
 */
export async function showQuickChat(source: QuickChatOpenSource = "hotkey"): Promise<void> {
  const report = captureAnalyticsReporter();
  const [{ window }] = await Promise.all([ensureQuickChat(), refreshKeepOpenOnBlurSetting()]);
  suppressQuickChatBlurHide(DEFAULT_BLUR_SUPPRESS_MS);
  if (canPositionFloatingWindow()) {
    const workArea = cursorWorkArea();
    const bounds = computeQuickChatInitialBounds(workArea, currentMode);
    window.setBounds(bounds, false);
  }
  window.show();
  window.focus();
  notifyQuickChatOpened(source);
  report("floating_chat_opened", { source });
}

export function hideQuickChat(): void {
  suppressBlurUntil = 0;
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
    quickChatWindow.hide();
  }
}

export async function toggleQuickChat(source: QuickChatOpenSource = "hotkey"): Promise<boolean> {
  if (isQuickChatVisible()) {
    hideQuickChat();
    return false;
  }
  await showQuickChat(source);
  return true;
}

/**
 * Atomically resize & reposition the floating stage (`starter` <-> `starter-popover` <-> `modal`)
 * anchored to the bottom edge so the composer bar does not jump.
 */
export function setQuickChatMode(mode: QuickChatWindowMode): void {
  currentMode = mode;
  void refreshKeepOpenOnBlurSetting();
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  suppressQuickChatBlurHide(DEFAULT_BLUR_SUPPRESS_MS);
  if (!canPositionFloatingWindow()) {
    const size = QUICK_CHAT_STAGE_SIZES[mode];
    quickChatWindow.setSize(size.width, size.height, false);
    return;
  }
  const currentBounds = quickChatWindow.getBounds();
  const workArea = windowWorkArea(quickChatWindow);
  const nextBounds = computeQuickChatTransitionBounds(currentBounds, workArea, mode);
  quickChatWindow.setBounds(nextBounds, false);
}

export function destroyQuickChat(): void {
  destroying = true;
  suppressBlurUntil = 0;
  authorizedQuickChatIds.clear();
  try {
    if (quickChatWindow && !quickChatWindow.isDestroyed()) quickChatWindow.destroy();
    quickChatWindow = null;
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.destroy();
    loadingWindow = null;
    currentMode = "starter";
  } finally {
    destroying = false;
  }
}

export function isCurrentQuickChatEvent(event: IpcMainInvokeEvent): boolean {
  const activeWindow =
    quickChatWindow && !quickChatWindow.isDestroyed()
      ? quickChatWindow
      : loadingWindow && !loadingWindow.isDestroyed()
        ? loadingWindow
        : null;
  if (!activeWindow || !quickChatUrl) return false;
  try {
    // Reuses full frame/process/detachment verification from rendererDocumentOwner.
    rendererDocumentOwner(event, () => new Error("Invalid Quick Chat sender."));
    const frame = event.senderFrame;
    if (!frame || frame.isDestroyed()) return false;
    return isTrustedQuickChatSender(activeWindow.webContents.id, quickChatUrl, {
      webContentsId: event.sender.id,
      frameUrl: frame.url,
      isMainFrame: frame === event.sender.mainFrame,
    });
  } catch {
    return false;
  }
}
