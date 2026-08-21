// Fixed-purpose attachment bridge. Unlike the generic renderer IPC surface,
// none of these methods accepts a renderer-authored filesystem path.

import type { Attachment } from "./lib/types.js";
import { NATIVE_INVOKE_CHANNELS } from "./preload-channels.js";

export const PRELOAD_MAX_ATTACHMENT_PATHS = 20;
export const PRELOAD_MAX_CLIPBOARD_IMAGES = 20;
export const PRELOAD_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PRELOAD_MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

const CLIPBOARD_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
]);

export interface PreloadClipboardImage {
  mimeType: string;
  bytes: Uint8Array;
}

interface AttachmentBridgeDependencies {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  getPathForFile(file: File): string;
}

export interface AttachmentPreloadBridge {
  readDroppedFiles(
    files: readonly File[],
    remainingSlots: number,
    includeImages: boolean,
    remainingInlineBytes: number,
  ): Promise<Attachment[]>;
  readClipboardImages(
    images: readonly PreloadClipboardImage[],
    remainingSlots: number,
    remainingInlineBytes: number,
  ): Promise<Attachment[]>;
}

function invalidClipboardPayload(): Error {
  return new Error("Invalid clipboard image payload.");
}

function validateRemainingLimits(remainingSlots: number, remainingInlineBytes: number): void {
  if (
    !Number.isSafeInteger(remainingSlots) ||
    remainingSlots < 1 ||
    remainingSlots > PRELOAD_MAX_ATTACHMENT_PATHS ||
    !Number.isSafeInteger(remainingInlineBytes) ||
    remainingInlineBytes < 1 ||
    remainingInlineBytes > PRELOAD_MAX_ATTACHMENT_BYTES
  ) {
    throw new Error("Invalid attachment limits.");
  }
}

/** Build the context-isolated bridge; dependency injection keeps its trust contract testable. */
export function createAttachmentPreloadBridge(
  dependencies: AttachmentBridgeDependencies,
): AttachmentPreloadBridge {
  return {
    readDroppedFiles: async (files, remainingSlots, includeImages, remainingInlineBytes) => {
      validateRemainingLimits(remainingSlots, remainingInlineBytes);
      if (
        !Array.isArray(files) ||
        files.length > PRELOAD_MAX_ATTACHMENT_PATHS ||
        typeof includeImages !== "boolean"
      ) {
        throw new Error("Invalid dropped file selection.");
      }
      const paths: string[] = [];
      for (const file of files) {
        try {
          const resolved = dependencies.getPathForFile(file);
          if (resolved) paths.push(resolved);
        } catch {
          // Synthetic renderer File objects and arbitrary non-File values have
          // no trusted OS path and are intentionally ignored.
        }
      }
      const uniquePaths = [...new Set(paths)].slice(0, remainingSlots);
      if (uniquePaths.length === 0) return [];
      return dependencies.invoke<Attachment[]>(
        NATIVE_INVOKE_CHANNELS.attachmentDroppedRead,
        uniquePaths,
        remainingSlots,
        includeImages,
        remainingInlineBytes,
      );
    },

    readClipboardImages: async (images, remainingSlots, remainingInlineBytes) => {
      validateRemainingLimits(remainingSlots, remainingInlineBytes);
      if (
        !Array.isArray(images) ||
        images.length === 0 ||
        images.length > PRELOAD_MAX_CLIPBOARD_IMAGES ||
        images.length > remainingSlots
      ) {
        throw invalidClipboardPayload();
      }
      let totalBytes = 0;
      const parsed = images.map((entry): PreloadClipboardImage => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !CLIPBOARD_IMAGE_MIME_TYPES.has(entry.mimeType) ||
          !(entry.bytes instanceof Uint8Array) ||
          entry.bytes.byteLength === 0 ||
          entry.bytes.byteLength > PRELOAD_MAX_IMAGE_BYTES
        ) {
          throw invalidClipboardPayload();
        }
        totalBytes += entry.bytes.byteLength;
        if (totalBytes > remainingInlineBytes) {
          throw new Error("Clipboard images exceed the aggregate byte limit.");
        }
        return { mimeType: entry.mimeType, bytes: entry.bytes };
      });
      return dependencies.invoke<Attachment[]>(
        NATIVE_INVOKE_CHANNELS.attachmentClipboardRead,
        parsed,
        remainingSlots,
        remainingInlineBytes,
      );
    },
  };
}
