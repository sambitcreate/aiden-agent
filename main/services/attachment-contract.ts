import type { Attachment } from "./types.js";
import {
  imageBytesMatchMime,
  isCanonicalRasterImageMimeType,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
} from "./attachments.js";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../renderer/shared/attachment-contract.js";

const MAX_ATTACHMENT_ID_CHARS = 256;
const MAX_ATTACHMENT_NAME_CHARS = 512;
const MAX_MIME_TYPE_CHARS = 128;
const MAX_LEGACY_TEXT_CHARS = MAX_TEXT_CHARS + "\n… [truncated]".length;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_LEGACY_ATTACHMENT_INLINE_BYTES = MAX_ATTACHMENTS_PER_MESSAGE * MAX_IMAGE_BYTES;
const MAX_IMAGE_SIGNATURE_BYTES = 4096;
const IMAGE_ATTACHMENT_KEYS = new Set(["id", "name", "mimeType", "kind", "size", "data"]);
const TEXT_ATTACHMENT_KEYS = new Set(["id", "name", "mimeType", "kind", "size", "text"]);

type AttachmentParseMode = "append" | "stored";

function base64DecodedBytes(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  let padding = 0;
  if (value.endsWith("=")) padding += 1;
  if (value.endsWith("==")) padding += 1;
  const bodyEnd = value.length - padding;
  for (let index = 0; index < bodyEnd; index += 1) {
    const code = value.charCodeAt(index);
    if (base64Value(code) === undefined) return undefined;
  }
  for (let index = bodyEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return undefined;
  }
  if (padding > 2) return undefined;
  const finalValue = base64Value(value.charCodeAt(bodyEnd - 1));
  if (finalValue === undefined) return undefined;
  if ((padding === 2 && (finalValue & 15) !== 0) || (padding === 1 && (finalValue & 3) !== 0)) {
    return undefined;
  }
  return (value.length / 4) * 3 - padding;
}

function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
}

function boundedString(
  value: unknown,
  field: string,
  maxChars: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxChars) {
    throw new Error(`Invalid attachment ${field}.`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > expected.size || !expected.has(key)) return false;
  }
  return count === expected.size;
}

function decodedBase64Prefix(value: string): Buffer {
  const encodedChars = Math.min(value.length, Math.ceil(MAX_IMAGE_SIGNATURE_BYTES / 3) * 4);
  return Buffer.from(value.slice(0, encodedChars), "base64");
}

function parseAttachment(value: unknown, index: number, mode: AttachmentParseMode): Attachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid attachment at index ${index}.`);
  }
  const attachment = value as Record<string, unknown>;
  if (
    mode === "append" &&
    ((attachment.kind === "text" && !hasExactKeys(attachment, TEXT_ATTACHMENT_KEYS)) ||
      (attachment.kind === "image" && !hasExactKeys(attachment, IMAGE_ATTACHMENT_KEYS)))
  ) {
    throw new Error(`Invalid attachment fields at index ${index}.`);
  }
  const id = boundedString(attachment.id, "id", MAX_ATTACHMENT_ID_CHARS);
  const name = boundedString(attachment.name, "name", MAX_ATTACHMENT_NAME_CHARS);
  const mimeType = boundedString(attachment.mimeType, "mimeType", MAX_MIME_TYPE_CHARS);
  if (!Number.isSafeInteger(attachment.size) || (attachment.size as number) < 0) {
    throw new Error("Invalid attachment size.");
  }
  const size = attachment.size as number;

  if (attachment.kind === "text") {
    const text = boundedString(attachment.text, "text", MAX_LEGACY_TEXT_CHARS, true);
    return { id, name, mimeType, kind: "text", size, text };
  }
  if (attachment.kind === "image") {
    const data = attachment.data;
    const decodedBytes =
      typeof data === "string" && data.length <= MAX_IMAGE_BASE64_CHARS
        ? base64DecodedBytes(data)
        : undefined;
    if (
      (mode === "append"
        ? !isCanonicalRasterImageMimeType(mimeType)
        : !mimeType.startsWith("image/")) ||
      decodedBytes === undefined
    ) {
      throw new Error("Invalid image attachment data.");
    }
    if (decodedBytes > MAX_IMAGE_BYTES || decodedBytes !== size) {
      throw new Error("Invalid image attachment size.");
    }
    if (
      mode === "append" &&
      isCanonicalRasterImageMimeType(mimeType) &&
      !imageBytesMatchMime(decodedBase64Prefix(data as string), mimeType)
    ) {
      throw new Error("Image attachment bytes do not match the declared image type.");
    }
    return { id, name, mimeType, kind: "image", size, data: data as string };
  }
  throw new Error("Invalid attachment kind.");
}

function parseAttachmentsWithLimit(
  value: unknown,
  aggregateLimit: number,
  mode: AttachmentParseMode,
): Attachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error("Invalid message attachments.");
  }
  let declaredImageBytes = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (record.kind !== "image" || !Number.isSafeInteger(record.size)) continue;
    declaredImageBytes += Math.max(0, record.size as number);
    if (declaredImageBytes > aggregateLimit) {
      throw new Error("Message attachments exceed the aggregate inline-data limit.");
    }
  }
  const parsed: Attachment[] = [];
  let inlineBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const attachment = parseAttachment(value[index], index, mode);
    inlineBytes +=
      attachment.kind === "image"
        ? attachment.size
        : Buffer.byteLength(attachment.text ?? "", "utf8");
    if (inlineBytes > aggregateLimit) {
      throw new Error("Message attachments exceed the aggregate inline-data limit.");
    }
    parsed.push(attachment);
  }
  return parsed;
}

export function parseAttachments(value: unknown): Attachment[] | undefined {
  return parseAttachmentsWithLimit(value, MAX_ATTACHMENT_INLINE_BYTES, "append");
}

export function safeStoredAttachments(value: unknown): Attachment[] | undefined {
  try {
    // Histories created before aggregate and raster admission shipped may use
    // the former image envelope or contain up to twenty individually valid
    // 8 MiB images. Preserve those bytes on reads and unrelated rewrites; only
    // new renderer appends use the exact raster contract and stricter cap.
    return parseAttachmentsWithLimit(value, MAX_LEGACY_ATTACHMENT_INLINE_BYTES, "stored");
  } catch {
    return undefined;
  }
}

export function attachmentInlineBytes(attachments: readonly Attachment[] | undefined): number {
  let bytes = 0;
  for (const attachment of attachments ?? []) {
    bytes +=
      attachment.kind === "image"
        ? attachment.size
        : Buffer.byteLength(attachment.text ?? "", "utf8");
  }
  return bytes;
}

/**
 * Conservative size of the parsed attachment representation retained across
 * asynchronous persistence. Images are charged by their encoded Base64 text,
 * not only their smaller decoded byte count.
 */
export function attachmentRepresentationBytes(
  attachments: readonly Attachment[] | undefined,
): number {
  let bytes = 0;
  for (const attachment of attachments ?? []) {
    bytes += Buffer.byteLength(attachment.id, "utf8");
    bytes += Buffer.byteLength(attachment.name, "utf8");
    bytes += Buffer.byteLength(attachment.mimeType, "utf8");
    bytes +=
      attachment.kind === "image"
        ? (attachment.data ?? "").length
        : Buffer.byteLength(attachment.text ?? "", "utf8");
    // Account for fixed object keys, kind, size, JSON punctuation, and a small
    // amount of allocator overhead without attempting engine-specific sizing.
    bytes += 128;
  }
  return bytes;
}
