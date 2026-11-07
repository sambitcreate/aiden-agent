import { BrowserWindow, ipcMain, screen, systemPreferences } from "../platform.js";
import { designModeEnabled } from "../services/studio/feature-flags.js";
import { canWidenForDesign, widenWindowForDesign, type Rectangle } from "../windows/design-window-core.js";

const workAreaFor = (bounds: Rectangle) => screen.getDisplayMatching(bounds).workArea;

/** macOS's Reduce Motion setting; other platforms always animate. */
function prefersReducedMotion(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion === true;
  } catch {
    return false;
  }
}

/** Design mode asks to widen the window it is shown in when it is too narrow. */
export function registerDesignWindowHandlers(): void {
  ipcMain.handle("app:widenForDesign", (event) => {
    if (!designModeEnabled()) throw new Error("Design mode is not available.");
    return widenWindowForDesign(BrowserWindow.fromWebContents(event.sender), workAreaFor, {
      reduceMotion: prefersReducedMotion(),
    });
  });
  ipcMain.handle("app:designWindowCanWiden", (event) => {
    if (!designModeEnabled()) return { canWiden: false };
    return { canWiden: canWidenForDesign(BrowserWindow.fromWebContents(event.sender), workAreaFor) };
  });
}
