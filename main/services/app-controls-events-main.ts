import { ipcMain } from "../platform.js";
import { chatProgressEvents } from "./chat-progress-events.js";
/** Settings and chat controls share one read-only foreground invalidation path. */
export function publishAppControlsChanged(): void {
  ipcMain.broadcast("settings:controls-changed", {});
  chatProgressEvents.appControlsChanged();
}
