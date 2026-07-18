import { BrowserWindow, logger } from "@glaze/core/backend";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";

let settingsWindow: BrowserWindow | null = null;

export async function openSettingsWindow(): Promise<void> {
  // If window exists and is not destroyed, just show it
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    logger.debug("settings", "Settings window already exists, showing it");
    settingsWindow.show();
    return;
  }

  logger.info("settings", "Creating settings window");

  settingsWindow = new BrowserWindow({
    windowKey: "settings",
    width: 520,
    height: 300,
    minWidth: 400,
    minHeight: 200,
    title: "Settings",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  const url = await getWindowUrl("settings-window.html");
  logger.info("settings", "Loading settings URL", { url });

  await settingsWindow.loadURL(url);
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
