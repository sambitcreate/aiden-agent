import {
  BrowserWindow,
  Notification,
  ShareMenu,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain as electronIpcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type IpcMain,
  type IpcMainInvokeEvent,
} from "electron";
import type { NotificationChannel } from "../renderer/preload-channels.js";
import {
  diagnosticJournalProfile,
  formatDiagnosticConsole,
  writeLegacyDiagnostic,
} from "./services/diagnostic-journal.js";
import { hostPlatformCapabilities } from "./services/host-platform-capabilities.js";
import {
  createBroadcastReceivers,
  parseMediaRequestType,
  parseMediaStatusType,
  parseOpenDialogOptions,
} from "./native-ipc-core.js";
import { rendererDocumentOwner } from "./services/renderer-document-owner.js";

type LogValue = unknown;

function writeLog(
  level: "debug" | "info" | "warn" | "error",
  scope: string,
  values: LogValue[],
): void {
  const method =
    level === "debug"
      ? console.debug
      : level === "info"
        ? console.info
        : level === "warn"
          ? console.warn
          : console.error;
  const event = writeLegacyDiagnostic(level, scope, values);
  if (diagnosticJournalProfile() === "production" && (level === "debug" || level === "info")) {
    return;
  }
  try {
    method(formatDiagnosticConsole(event));
  } catch {
    // Diagnostic sinks must never become an application failure source.
  }
}

export const logger = {
  debug: (scope: string, ...values: LogValue[]) => writeLog("debug", scope, values),
  info: (scope: string, ...values: LogValue[]) => writeLog("info", scope, values),
  warn: (scope: string, ...values: LogValue[]) => writeLog("warn", scope, values),
  error: (scope: string, ...values: LogValue[]) => writeLog("error", scope, values),
};

const broadcastObservers = new Set<(channel: NotificationChannel) => void>();

/**
 * Observe renderer notifications in the main process (the Remote host feed
 * uses this to learn that chats, workspaces or Bots changed). Payloads are
 * deliberately not forwarded.
 */
export function onBroadcast(observer: (channel: NotificationChannel) => void): () => void {
  broadcastObservers.add(observer);
  return () => broadcastObservers.delete(observer);
}

const broadcastReceivers = createBroadcastReceivers<BrowserWindow>();

/**
 * Opt a window into renderer notifications. Only windows with an Aiden
 * preload register: the main window for every channel, the dictation pill for
 * the few it listens to. Registration ends when the window closes.
 */
export function registerBroadcastReceiver(
  window: BrowserWindow,
  channels: ReadonlySet<string> | null = null,
): void {
  broadcastReceivers.register(
    window,
    {
      isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
      send: (channel, payload) => window.webContents.send(channel, payload),
    },
    channels,
  );
  window.once("closed", () => broadcastReceivers.unregister(window));
}

function broadcast(channel: NotificationChannel, payload: unknown): void {
  for (const observer of [...broadcastObservers]) {
    try {
      observer(channel);
    } catch (error) {
      logger.warn("ipc", `A ${channel} observer failed.`, error);
    }
  }
  broadcastReceivers.deliver(channel, payload, (error) => {
    logger.warn("ipc", `Could not deliver ${channel} notification.`, error);
  });
}

export const ipcMain = {
  handle: electronIpcMain.handle.bind(electronIpcMain) as IpcMain["handle"],
  on: electronIpcMain.on.bind(electronIpcMain) as IpcMain["on"],
  removeHandler: electronIpcMain.removeHandler.bind(electronIpcMain) as IpcMain["removeHandler"],
  broadcast,
};

let nativeHandlersRegistered = false;
const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

async function waitForAccessibilityTrust(): Promise<boolean> {
  if (!hostPlatformCapabilities().accessibilityPaste) return false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return systemPreferences.isTrustedAccessibilityClient(false);
}

/** Native requests come only from the active main frame of an Aiden window. */
function requireNativeSender(event: IpcMainInvokeEvent): void {
  rendererDocumentOwner(event, () => new Error("Native request came from an inactive renderer."));
}

export function registerNativeHandlers(): void {
  if (nativeHandlersRegistered) return;
  nativeHandlersRegistered = true;

  electronIpcMain.handle("aiden:dialog:open", async (event, input?: unknown) => {
    requireNativeSender(event);
    const options = parseOpenDialogOptions(input);
    const parent = BrowserWindow.fromWebContents(event.sender);
    return parent
      ? dialog.showOpenDialog(parent, options)
      : dialog.showOpenDialog(options);
  });

  electronIpcMain.handle("aiden:theme:get", () => ({
    themeSource: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
    shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
  }));
  electronIpcMain.handle("aiden:theme:set", (_event, source: unknown) => {
    if (source !== "system" && source !== "light" && source !== "dark") {
      throw new Error("Invalid native theme source.");
    }
    nativeTheme.themeSource = source;
    return true;
  });
  electronIpcMain.handle("aiden:media:status", (event, input: unknown) => {
    requireNativeSender(event);
    const mediaType = parseMediaStatusType(input);
    return process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus(mediaType)
      : "unknown";
  });
  electronIpcMain.handle("aiden:media:request", (event, input: unknown) => {
    requireNativeSender(event);
    const mediaType = parseMediaRequestType(input);
    return process.platform === "darwin"
      ? systemPreferences.askForMediaAccess(mediaType)
      : true;
  });
  electronIpcMain.handle("aiden:accessibility:status", () =>
    hostPlatformCapabilities().accessibilityPaste
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : false,
  );
  electronIpcMain.handle("aiden:accessibility:request", async (event) => {
    if (!hostPlatformCapabilities().accessibilityPaste) return false;
    const parent = BrowserWindow.fromWebContents(event.sender);
    parent?.show();
    parent?.focus();
    app.focus({ steal: true });
    if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
    systemPreferences.isTrustedAccessibilityClient(true);
    return waitForAccessibilityTrust();
  });
  electronIpcMain.handle("aiden:accessibility:open-settings", async () => {
    if (!hostPlatformCapabilities().accessibilityPaste) return false;
    await shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
    return true;
  });

  nativeTheme.on("updated", () => {
    broadcast("aiden:theme:changed", {
      themeSource: nativeTheme.themeSource,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
      shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
    });
  });
}

export {
  app,
  BrowserWindow,
  Notification,
  ShareMenu,
  clipboard,
  dialog,
  globalShortcut,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  systemPreferences,
};
