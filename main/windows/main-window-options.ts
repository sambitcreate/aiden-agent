import type { BrowserWindowConstructorOptions } from "electron";

export function mainWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  dark = false,
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
    },
  };
  if (platform !== "darwin") {
    return {
      ...shared,
      // Linux compositors own the native title bar and window shadow. An
      // opaque semantic surface avoids transparency artifacts under Wayland.
      backgroundColor: dark ? "#181b21" : "#f6f7f9",
      titleBarStyle: "default",
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
