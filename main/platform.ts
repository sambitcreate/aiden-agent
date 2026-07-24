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
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type IpcMain,
  type OpenDialogOptions,
} from "electron";
import type { NotificationChannel } from "../renderer/preload-channels.js";
import { writeDevLog } from "./services/dev-log.js";

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
  method(`[${scope}]`, ...values);
  // Mirrored to the dev log file when initialized (dev runs only).
  writeDevLog(level, scope, values);
}

export const logger = {
  debug: (scope: string, ...values: LogValue[]) => writeLog("debug", scope, values),
  info: (scope: string, ...values: LogValue[]) => writeLog("info", scope, values),
  warn: (scope: string, ...values: LogValue[]) => writeLog("warn", scope, values),
  error: (scope: string, ...values: LogValue[]) => writeLog("error", scope, values),
};

function broadcast(channel: NotificationChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export const ipcMain = {
  handle: electronIpcMain.handle.bind(electronIpcMain) as IpcMain["handle"],
  on: electronIpcMain.on.bind(electronIpcMain) as IpcMain["on"],
  removeHandler: electronIpcMain.removeHandler.bind(electronIpcMain) as IpcMain["removeHandler"],
  broadcast,
};

let nativeHandlersRegistered = false;

export function registerNativeHandlers(): void {
  if (nativeHandlersRegistered) return;
  nativeHandlersRegistered = true;

  electronIpcMain.handle("aiden:dialog:open", async (event, options?: OpenDialogOptions) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    return parent
      ? dialog.showOpenDialog(parent, options ?? {})
      : dialog.showOpenDialog(options ?? {});
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
  electronIpcMain.handle(
    "aiden:media:status",
    (_event, mediaType: "microphone" | "camera" | "screen") =>
      systemPreferences.getMediaAccessStatus(mediaType),
  );
  electronIpcMain.handle("aiden:media:request", (_event, mediaType: "microphone" | "camera") =>
    systemPreferences.askForMediaAccess(mediaType),
  );
  electronIpcMain.handle("aiden:accessibility:status", () =>
    systemPreferences.isTrustedAccessibilityClient(false),
  );
  electronIpcMain.handle("aiden:accessibility:request", () =>
    systemPreferences.isTrustedAccessibilityClient(true),
  );

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
  safeStorage,
  screen,
  shell,
  systemPreferences,
};
