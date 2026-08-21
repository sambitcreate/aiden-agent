export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const MAX_ATTACHMENT_INLINE_BYTES = 16 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export const CANONICAL_RASTER_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
] as const;

export type CanonicalRasterImageMimeType = (typeof CANONICAL_RASTER_IMAGE_MIME_TYPES)[number];

const CANONICAL_RASTER_IMAGE_MIME_TYPE_SET = new Set<string>(CANONICAL_RASTER_IMAGE_MIME_TYPES);

/** Closed raster allowlist shared by main ingestion and renderer presentation. */
export function isCanonicalRasterImageMimeType(
  value: unknown,
): value is CanonicalRasterImageMimeType {
  return typeof value === "string" && CANONICAL_RASTER_IMAGE_MIME_TYPE_SET.has(value);
}

export interface AttachmentPickResult<T> {
  attachments: T[];
  skipped: number;
}

export function attachmentSlotsRemaining(currentCount: number): number {
  const normalizedCurrent = Number.isSafeInteger(currentCount)
    ? Math.max(0, currentCount)
    : MAX_ATTACHMENTS_PER_MESSAGE;
  return Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - normalizedCurrent);
}

interface InlineAttachmentLike {
  kind: "image" | "text";
  size: number;
  text?: string;
}

export function attachmentInlineBytesRemaining(
  attachments: readonly InlineAttachmentLike[],
): number {
  let used = 0;
  for (const attachment of attachments) {
    const bytes =
      attachment.kind === "image"
        ? attachment.size
        : new TextEncoder().encode(attachment.text ?? "").byteLength;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return 0;
    used += bytes;
    if (used >= MAX_ATTACHMENT_INLINE_BYTES) return 0;
  }
  return MAX_ATTACHMENT_INLINE_BYTES - used;
}
