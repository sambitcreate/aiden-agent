import type { BrowserWindowConstructorOptions } from "electron";
import { WINDOW_CHROME_ARGUMENT, type WindowChrome } from "../../renderer/shared/window-chrome.js";

export function mainWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  dark = false,
  chrome: WindowChrome = platform === "darwin" ? "mac" : "system",
): BrowserWindowConstructorOptions {
  const shared: BrowserWindowConstructorOptions = {
    width: 1000,
    height: 700,
    minWidth: 390,
    minHeight: 456,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload reads this synchronously so the first paint already lays
      // the top bar out for the right window controls.
      additionalArguments: [`${WINDOW_CHROME_ARGUMENT}${chrome}`],
    },
  };
  if (platform !== "darwin") {
    return {
      ...shared,
      // An opaque semantic surface avoids transparency artifacts under Wayland.
      backgroundColor: dark ? "#181b21" : "#f6f7f9",
      // "aiden": no desktop title bar or menu bar; the renderer draws the
      // window controls inside its own 52px top bar. "system": the
      // compositor owns the title bar and window shadow.
      titleBarStyle: chrome === "aiden" ? "hidden" : "default",
      transparent: false,
    };
  }
  return {
    ...shared,
    titleBarStyle: "hiddenInset",
    // Center the 12px macOS window controls in the renderer's 52px top bar.
    trafficLightPosition: { x: 14, y: 20 },
    backgroundColor: "#00000000",
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
  };
}
