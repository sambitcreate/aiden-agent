import { randomBytes } from "node:crypto";
import {
  attachmentInlineBytes,
  attachmentRepresentationBytes,
  parseAttachments,
} from "./attachment-contract.js";
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
} from "./attachments.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { Attachment } from "./types.js";
import { MAX_ATTACHMENT_INLINE_BYTES } from "../../renderer/shared/attachment-contract.js";

export const MAX_AIDEN_REMOTE_ATTACHMENTS_PER_TURN = 10;
export const MAX_AIDEN_REMOTE_ATTACHMENT_REQUEST_BYTES = 12 * 1_048_576;
export const AIDEN_REMOTE_ATTACHMENT_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_ATTACHMENTS = 256;
const MAX_PENDING_ATTACHMENTS_PER_DEVICE = 40;
const MAX_PENDING_ATTACHMENTS_PER_CHAT = 20;
const MAX_PENDING_REPRESENTATION_BYTES = 64 * 1_048_576;
const MAX_REMOTE_IMAGE_DIMENSION = 16_384;
const MAX_REMOTE_IMAGE_PIXELS = 40_000_000;
const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{43}$/u;
const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
]);

export interface AidenRemoteAttachmentProjection {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "text";
  size: number;
  expiresAt: string;
}

interface PendingAttachmentRecord {
  id: string;
  deviceId: string;
  chatId: string;
  attachment: Attachment;
  expiresAt: number;
  representationBytes: number;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > expected.size || !expected.has(key)) return false;
  }
  return count === expected.size;
}

function validDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const cleaned = value.trim();
  if (!cleaned || Array.from(cleaned).length > 255 || cleaned.includes("/") || cleaned.includes("\\")) {
    return false;
  }
  for (let index = 0; index < cleaned.length; index += 1) {
    const code = cleaned.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function readUInt16BE(bytes: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16BE(offset) : undefined;
}

function readUInt32BE(bytes: Buffer, offset: number): number | undefined {
  return offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32BE(offset) : undefined;
}

function jpegDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = readUInt16BE(bytes, offset);
    if (segmentLength === undefined || segmentLength < 2 || offset + segmentLength > bytes.length) {
      return undefined;
    }
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) return undefined;
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      return width && height ? [width, height] : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

function imageDimensions(bytes: Buffer, mimeType: string): [number, number] | undefined {
  if (mimeType === "image/png") {
    if (
      bytes.length < 24 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      return undefined;
    }
    const width = readUInt32BE(bytes, 16);
    const height = readUInt32BE(bytes, 20);
    return width && height ? [width, height] : undefined;
  }
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  return undefined;
}

function validateDimensions(bytes: Buffer, mimeType: string): void {
  const dimensions = imageDimensions(bytes, mimeType);
  if (
    !dimensions ||
    dimensions[0] > MAX_REMOTE_IMAGE_DIMENSION ||
    dimensions[1] > MAX_REMOTE_IMAGE_DIMENSION ||
    dimensions[0] * dimensions[1] > MAX_REMOTE_IMAGE_PIXELS
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The image dimensions are invalid or too large.",
      400,
    );
  }
}

function parseUpload(input: unknown, id: string): Attachment {
  const record = ownRecord(input);
  if (!record || !validDisplayName(record.name) || typeof record.kind !== "string") {
    throw new AidenRemoteServiceError("invalid_request", "The attachment upload is invalid.", 400);
  }
  const name = record.name.trim();
  try {
    if (record.kind === "image") {
      if (
        !exactKeys(record, new Set(["name", "mimeType", "kind", "data"])) ||
        (record.mimeType !== "image/png" && record.mimeType !== "image/jpeg") ||
        typeof record.data !== "string" ||
        record.data.length === 0 ||
        record.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      ) {
        throw new Error("invalid image envelope");
      }
      const bytes = Buffer.from(record.data, "base64");
      const attachment = parseAttachments([{
        id,
        name,
        mimeType: record.mimeType,
        kind: "image",
        size: bytes.length,
        data: record.data,
      }])?.[0];
      if (!attachment) throw new Error("invalid image attachment");
      validateDimensions(bytes, attachment.mimeType);
      return attachment;
    }

    if (
      record.kind !== "text" ||
      !exactKeys(record, new Set(["name", "mimeType", "kind", "text"])) ||
      typeof record.mimeType !== "string" ||
      !TEXT_MIME_TYPES.has(record.mimeType.toLowerCase()) ||
      typeof record.text !== "string" ||
      Array.from(record.text).length > MAX_TEXT_CHARS ||
      Buffer.byteLength(record.text, "utf8") > MAX_TEXT_CHARS * 4
    ) {
      throw new Error("invalid text envelope");
    }
    const attachment = parseAttachments([{
      id,
      name,
      mimeType: record.mimeType.toLowerCase(),
      kind: "text",
      size: Buffer.byteLength(record.text, "utf8"),
      text: record.text,
    }])?.[0];
    if (!attachment) throw new Error("invalid text attachment");
    return attachment;
  } catch (error) {
    if (error instanceof AidenRemoteServiceError) throw error;
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The attachment data does not match its declared type or limits.",
      400,
    );
  }
}

function projection(record: PendingAttachmentRecord): AidenRemoteAttachmentProjection {
  return {
    id: record.id,
    name: record.attachment.name,
    mimeType: record.attachment.mimeType,
    kind: record.attachment.kind,
    size: record.attachment.size,
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

export class AidenRemoteAttachmentStore {
  private readonly records = new Map<string, PendingAttachmentRecord>();
  private retainedRepresentationBytes = 0;

  constructor(private readonly options: {
    now?: () => number;
    randomId?: () => string;
    maxEntries?: number;
    maxRepresentationBytes?: number;
  } = {}) {}

  upload(deviceId: string, chatId: string, input: unknown): AidenRemoteAttachmentProjection {
    const now = this.now();
    this.prune(now);
    const id = this.nextId();
    const attachment = parseUpload(input, id);
    const representationBytes = attachmentRepresentationBytes([attachment]);
    const maxEntries = this.options.maxEntries ?? MAX_PENDING_ATTACHMENTS;
    const maxRepresentationBytes =
      this.options.maxRepresentationBytes ?? MAX_PENDING_REPRESENTATION_BYTES;
    let deviceCount = 0;
    let chatCount = 0;
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId) deviceCount += 1;
      if (record.deviceId === deviceId && record.chatId === chatId) chatCount += 1;
    }
    if (
      this.records.size >= maxEntries ||
      deviceCount >= MAX_PENDING_ATTACHMENTS_PER_DEVICE ||
      chatCount >= MAX_PENDING_ATTACHMENTS_PER_CHAT ||
      representationBytes > maxRepresentationBytes - this.retainedRepresentationBytes
    ) {
      throw new AidenRemoteServiceError(
        "handle_capacity",
        "Aiden's temporary attachment capacity is full. Try again shortly.",
        429,
        true,
      );
    }
    const record: PendingAttachmentRecord = {
      id,
      deviceId,
      chatId,
      attachment,
      expiresAt: now + AIDEN_REMOTE_ATTACHMENT_TTL_MS,
      representationBytes,
    };
    this.records.set(id, record);
    this.retainedRepresentationBytes += representationBytes;
    return projection(record);
  }

  consume(deviceId: string, chatId: string, input: unknown): Attachment[] | undefined {
    if (input === undefined) return undefined;
    const { selected, now } = this.select(deviceId, chatId, input);
    const attachments = selected.map((record) => structuredClone(record.attachment));
    if (attachmentInlineBytes(attachments) > MAX_ATTACHMENT_INLINE_BYTES) {
      throw new AidenRemoteServiceError("payload_too_large", "The attachments exceed the turn limit.", 413);
    }
    for (const record of selected) this.removeRecord(record);
    this.prune(now);
    return attachments;
  }

  /** Validate one-shot references without consuming them during model admission. */
  requiresImageInput(deviceId: string, chatId: string, input: unknown): boolean {
    if (input === undefined) return false;
    return this.select(deviceId, chatId, input).selected.some(
      (record) => record.attachment.kind === "image",
    );
  }

  private select(
    deviceId: string,
    chatId: string,
    input: unknown,
  ): { selected: PendingAttachmentRecord[]; now: number } {
    if (
      !Array.isArray(input) ||
      input.length === 0 ||
      input.length > MAX_AIDEN_REMOTE_ATTACHMENTS_PER_TURN
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The attachment references are invalid.", 400);
    }
    const ids: string[] = [];
    const unique = new Set<string>();
    for (const candidate of input) {
      if (typeof candidate !== "string" || !ATTACHMENT_ID.test(candidate) || unique.has(candidate)) {
        throw new AidenRemoteServiceError("invalid_request", "The attachment references are invalid.", 400);
      }
      unique.add(candidate);
      ids.push(candidate);
    }

    const now = this.now();
    const selected: PendingAttachmentRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) {
        throw new AidenRemoteServiceError("handle_invalid", "That attachment is no longer available.", 409);
      }
      if (record.expiresAt <= now) {
        this.removeRecord(record);
        throw new AidenRemoteServiceError("handle_expired", "That attachment expired. Attach it again.", 409);
      }
      if (record.deviceId !== deviceId) {
        throw new AidenRemoteServiceError("handle_wrong_device", "That attachment belongs to another device.", 403);
      }
      if (record.chatId !== chatId) {
        throw new AidenRemoteServiceError("handle_invalid", "That attachment belongs to another chat.", 409);
      }
      selected.push(record);
    }
    return { selected, now };
  }

  remove(deviceId: string, chatId: string, id: string): void {
    if (!ATTACHMENT_ID.test(id)) {
      throw new AidenRemoteServiceError("invalid_request", "The attachment reference is invalid.", 400);
    }
    const record = this.records.get(id);
    if (!record) return;
    if (record.deviceId !== deviceId) {
      throw new AidenRemoteServiceError("handle_wrong_device", "That attachment belongs to another device.", 403);
    }
    if (record.chatId !== chatId) {
      throw new AidenRemoteServiceError("handle_invalid", "That attachment belongs to another chat.", 409);
    }
    this.removeRecord(record);
  }

  revokeDevice(deviceId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.deviceId === deviceId) this.removeRecord(record);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nextId(): string {
    const id = this.options.randomId?.() ?? `att_${randomBytes(32).toString("base64url")}`;
    if (!ATTACHMENT_ID.test(id) || this.records.has(id)) {
      throw new AidenRemoteServiceError("internal_error", "Aiden could not allocate an attachment reference.", 500);
    }
    return id;
  }

  private prune(now: number): void {
    for (const record of [...this.records.values()]) {
      if (record.expiresAt <= now) this.removeRecord(record);
    }
  }

  private removeRecord(record: PendingAttachmentRecord): void {
    if (!this.records.delete(record.id)) return;
    this.retainedRepresentationBytes = Math.max(
      0,
      this.retainedRepresentationBytes - record.representationBytes,
    );
  }
}
