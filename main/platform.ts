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
  type OpenDialogOptions,
} from "electron";
import type { NotificationChannel } from "../renderer/preload-channels.js";
import { writeDevLog } from "./services/dev-log.js";
import {
  performanceDiagnosticsEnabled,
  recordDiagnosticCounter,
} from "./services/performance-diagnostics.js";
import { estimateDiagnosticPayloadBytes } from "./services/performance-diagnostics-core.js";

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
  const started = performanceDiagnosticsEnabled ? performance.now() : 0;
  let recipients = 0;
  let errors = 0;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send(channel, payload);
        recipients += 1;
      } catch {
        // Notifications are best effort. A renderer can disappear between the
        // liveness check and send without turning a committed main mutation
        // into a retryable failure.
        errors += 1;
      }
    }
  }
  if (performanceDiagnosticsEnabled) {
    recordDiagnosticCounter(`ipc-out:${channel}`, {
      count: recipients,
      errors,
      bytesOut: estimateDiagnosticPayloadBytes(payload) * recipients,
      durationMs: performance.now() - started,
    });
  }
}

const handle: IpcMain["handle"] = (channel, listener) => {
  electronIpcMain.handle(channel, async (event, ...args) => {
    const started = performanceDiagnosticsEnabled ? performance.now() : 0;
    const bytesIn = performanceDiagnosticsEnabled ? estimateDiagnosticPayloadBytes(args) : 0;
    try {
      const result = await listener(event, ...args);
      if (performanceDiagnosticsEnabled) {
        recordDiagnosticCounter(`ipc:${channel}`, {
          bytesIn,
          bytesOut: estimateDiagnosticPayloadBytes(result),
          durationMs: performance.now() - started,
        });
      }
      return result;
    } catch (error) {
      if (performanceDiagnosticsEnabled) {
        recordDiagnosticCounter(`ipc:${channel}`, {
          bytesIn,
          durationMs: performance.now() - started,
          errors: 1,
        });
      }
      throw error;
    }
  });
};

export const ipcMain = {
  handle,
  on: electronIpcMain.on.bind(electronIpcMain) as IpcMain["on"],
  removeHandler: electronIpcMain.removeHandler.bind(electronIpcMain) as IpcMain["removeHandler"],
  broadcast,
};

let nativeHandlersRegistered = false;

export function registerNativeHandlers(): void {
  if (nativeHandlersRegistered) return;
  nativeHandlersRegistered = true;

  handle("aiden:dialog:open", async (event, options?: OpenDialogOptions) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    return parent
      ? dialog.showOpenDialog(parent, options ?? {})
      : dialog.showOpenDialog(options ?? {});
  });

  handle("aiden:theme:get", () => ({
    themeSource: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
    shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
  }));
  handle("aiden:theme:set", (_event, source: unknown) => {
    if (source !== "system" && source !== "light" && source !== "dark") {
      throw new Error("Invalid native theme source.");
    }
    nativeTheme.themeSource = source;
    return true;
  });
  handle("aiden:media:status", (_event, mediaType: "microphone" | "camera" | "screen") =>
    systemPreferences.getMediaAccessStatus(mediaType),
  );
  handle("aiden:media:request", (_event, mediaType: "microphone" | "camera") =>
    systemPreferences.askForMediaAccess(mediaType),
  );
  handle("aiden:accessibility:status", () => systemPreferences.isTrustedAccessibilityClient(false));
  handle("aiden:accessibility:request", () => systemPreferences.isTrustedAccessibilityClient(true));

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
