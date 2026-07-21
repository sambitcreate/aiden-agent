// Reading user-attached files + bundled model capability lookups.

import { ipcMain } from "../platform.js";
import { readAttachments } from "../services/attachments.js";
import { providerModelInfo } from "../services/provider-model-info.js";

export function registerAttachmentHandlers(): void {
  ipcMain.handle("attachments:read", async (_event, paths: unknown) => {
    const list = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === "string")
      : [];
    return readAttachments(list);
  });

  ipcMain.handle("models:info", async (_event, providerId: unknown, modelIds: unknown) => {
    const pid = typeof providerId === "string" ? providerId : "";
    const ids = Array.isArray(modelIds)
      ? modelIds.filter((m): m is string => typeof m === "string")
      : [];
    return providerModelInfo.infoMany(pid, ids);
  });
}
