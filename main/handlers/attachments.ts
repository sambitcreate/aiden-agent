// Reading user-attached files + bundled model capability lookups.

import { BrowserWindow, dialog, ipcMain } from "../platform.js";
import {
  attachmentIngestionRepresentationBytes,
  AttachmentIngestionAdmission,
  isImageAttachmentPath,
  materializeClipboardAttachments,
  readPickedAttachments,
  validateClipboardAttachmentPayload,
} from "../services/attachments.js";
import { providerModelInfo } from "../services/provider-model-info.js";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../renderer/shared/attachment-contract.js";
import {
  rendererDocumentOwner,
  type RendererDocumentOwner,
} from "../services/renderer-document-owner.js";

const attachmentIngestionAdmission = new AttachmentIngestionAdmission();

async function runOwnedAttachmentIngestion<T>(
  owner: RendererDocumentOwner,
  attachmentCount: number,
  representationBytes: number,
  operation: (isActive: () => boolean) => T | Promise<T>,
): Promise<T> {
  const lease = attachmentIngestionAdmission.acquire(
    owner.documentId,
    attachmentCount,
    representationBytes,
  );
  const isActive = (): boolean => lease.isActive() && !owner.isDestroyed();
  let removeOwnerInvalidation = (): void => undefined;
  try {
    removeOwnerInvalidation = owner.onInvalidated(lease.cancel);
    if (!isActive()) throw new Error("The renderer document is no longer active.");
    const result = await operation(isActive);
    // Keep accounting through one main-loop turn so simultaneous invoke bursts
    // cannot each materialize an unaccounted Base64 result before delivery.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!isActive()) throw new Error("The renderer document is no longer active.");
    return result;
  } finally {
    removeOwnerInvalidation();
    lease.release();
  }
}

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
        return await runOwnedAttachmentIngestion(
          owner,
          remainingSlots,
          attachmentIngestionRepresentationBytes(remainingInlineBytes, remainingSlots),
          async (isActive) => {
            const result = await dialog.showOpenDialog(parent, {
              properties: ["openFile", "multiSelections"],
            });
            if (!isActive()) throw new Error("The renderer document is no longer active.");
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
              isActive,
              maxBatchBytes: remainingInlineBytes,
            });
            return {
              attachments,
              skipped: Math.max(0, result.filePaths.length - selectedPaths.length),
            };
          },
        );
      } finally {
        pickerActive = false;
      }
    },
  );

  ipcMain.handle(
    "aiden:attachments:dropped-read",
    async (
      event,
      value: unknown,
      remainingSlots: unknown,
      includeImages: unknown,
      remainingInlineBytes: unknown,
    ) => {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_ATTACHMENTS_PER_MESSAGE ||
        !Number.isSafeInteger(remainingSlots) ||
        (remainingSlots as number) < 1 ||
        (remainingSlots as number) > MAX_ATTACHMENTS_PER_MESSAGE ||
        typeof includeImages !== "boolean" ||
        !Number.isSafeInteger(remainingInlineBytes) ||
        (remainingInlineBytes as number) < 1 ||
        (remainingInlineBytes as number) > MAX_ATTACHMENT_INLINE_BYTES
      ) {
        throw new Error("Invalid dropped attachment request.");
      }
      const paths = [...new Set(value)].filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      );
      if (paths.length !== value.length) throw new Error("Invalid dropped attachment request.");
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted attachment drop."));
      const selected = paths
        .filter((filePath) => includeImages || !isImageAttachmentPath(filePath))
        .slice(0, remainingSlots as number);
      if (selected.length === 0) return [];
      return runOwnedAttachmentIngestion(
        owner,
        selected.length,
        attachmentIngestionRepresentationBytes(remainingInlineBytes as number, selected.length),
        (isActive) =>
          readPickedAttachments(selected, {
            isActive,
            maxBatchBytes: remainingInlineBytes as number,
          }),
      );
    },
  );

  ipcMain.handle(
    "aiden:attachments:clipboard-read",
    async (event, value: unknown, remainingSlots: unknown, remainingInlineBytes: unknown) => {
      const owner = rendererDocumentOwner(event, () => new Error("Untrusted clipboard image."));
      const payload = validateClipboardAttachmentPayload(
        value,
        remainingSlots,
        remainingInlineBytes,
      );
      return runOwnedAttachmentIngestion(
        owner,
        payload.images.length,
        payload.representationBytes,
        (isActive) => materializeClipboardAttachments(payload, isActive),
      );
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
