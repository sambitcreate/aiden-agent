// Settings → Storage IPC: read the cached inventory, preview a cleanup, run it.

import { ipcMain } from "../platform.js";
import { parseStorageCleanupRequest } from "../../renderer/shared/storage.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { storageUsageService } from "../services/storage-usage-main.js";

function storageOwner(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(
    event,
    () => new Error("Storage settings require the active application window."),
  );
}

export function registerStorageHandlers(): void {
  ipcMain.handle("storage:report", async (event) => {
    storageOwner(event);
    return storageUsageService.report();
  });

  // Awaiting a fresh scan is an explicit action from the page, never the first
  // paint: the cached report plus the `storage:changed` broadcast cover that.
  ipcMain.handle("storage:refresh", async (event) => {
    storageOwner(event);
    return storageUsageService.refresh();
  });

  ipcMain.handle("storage:preview", async (event, input: unknown) => {
    storageOwner(event);
    return storageUsageService.preview(parseStorageCleanupRequest(input));
  });

  ipcMain.handle("storage:cleanup", async (event, input: unknown) => {
    storageOwner(event);
    return storageUsageService.cleanup(parseStorageCleanupRequest(input));
  });
}
