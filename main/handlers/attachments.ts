// Reading user-attached files + bundled model capability lookups.

import { BrowserWindow, dialog, ipcMain } from "../platform.js";
import { isImageAttachmentPath, readPickedAttachments } from "../services/attachments.js";
import { providerModelInfo } from "../services/provider-model-info.js";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../renderer/shared/attachment-contract.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";

export function registerAttachmentHandlers(): void {
  let pickerActive = false;
  ipcMain.handle(
    "attachments:pickAndRead",
    async (
      event,
      remainingSlots: unknown,
      includeImages: unknown,
      remainingInlineBytes: unknown,
    ) => {
      if (
        typeof remainingSlots !== "number" ||
        !Number.isSafeInteger(remainingSlots) ||
        remainingSlots < 1 ||
        remainingSlots > MAX_ATTACHMENTS_PER_MESSAGE ||
        typeof includeImages !== "boolean" ||
        typeof remainingInlineBytes !== "number" ||
        !Number.isSafeInteger(remainingInlineBytes) ||
        remainingInlineBytes < 1 ||
        remainingInlineBytes > MAX_ATTACHMENT_INLINE_BYTES
      ) {
        throw new Error("Invalid attachment picker request.");
      }
      if (pickerActive) throw new Error("Another attachment picker is already open.");

      const owner = rendererDocumentOwner(event, () => new Error("Untrusted attachment picker."));
      const parent = BrowserWindow.fromWebContents(event.sender);
      if (!parent || parent.isDestroyed()) {
        throw new Error("Attachment picker window is unavailable.");
      }

      pickerActive = true;
      try {
        const result = await dialog.showOpenDialog(parent, {
          properties: ["openFile", "multiSelections"],
        });
        if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
        if (result.canceled || result.filePaths.length === 0) {
          return { attachments: [], skipped: 0 };
        }
        const selectedPaths: string[] = [];
        for (const filePath of result.filePaths.slice(0, 200)) {
          if (!includeImages && isImageAttachmentPath(filePath)) continue;
          selectedPaths.push(filePath);
          if (selectedPaths.length === remainingSlots) break;
        }
        const attachments = await readPickedAttachments(selectedPaths, {
          isActive: () => !owner.isDestroyed(),
          maxBatchBytes: remainingInlineBytes,
        });
        return {
          attachments,
          skipped: Math.max(0, result.filePaths.length - selectedPaths.length),
        };
      } finally {
        pickerActive = false;
      }
    },
  );

  ipcMain.handle("models:info", async (_event, providerId: unknown, modelIds: unknown) => {
    const pid = typeof providerId === "string" ? providerId : "";
    const ids = Array.isArray(modelIds)
      ? modelIds.filter((m): m is string => typeof m === "string")
      : [];
    return providerModelInfo.infoMany(pid, ids);
  });
}
