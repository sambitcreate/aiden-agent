import { BrowserWindow, ipcMain, screen } from "../platform.js";
import { designModeEnabled } from "../services/studio/feature-flags.js";
import { widenWindowForDesign } from "../windows/design-window-core.js";

/** Design mode asks to widen the window it is shown in when it is too narrow. */
export function registerDesignWindowHandlers(): void {
  ipcMain.handle("app:widenForDesign", (event) => {
    if (!designModeEnabled()) throw new Error("Design mode is not available.");
    return widenWindowForDesign(
      BrowserWindow.fromWebContents(event.sender),
      (bounds) => screen.getDisplayMatching(bounds).workArea,
    );
  });
}
