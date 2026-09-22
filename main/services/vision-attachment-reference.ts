import type { Attachment } from "./types.js";

/**
 * Produce a generation-local opaque reference for an attached image. The
 * reference deliberately contains no filesystem path, URL, chat identity, or
 * provider information and is only resolved against the current tool closure.
 */
export function visionAttachmentAlias(attachment: Pick<Attachment, "id">): string {
  return `image_${attachment.id.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96)}`;
}
