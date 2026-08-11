// Reads files the user attaches in the composer. Images come back as base64
// (for vision models); everything else is read as UTF-8 text and inlined as
// context. Oversized files are rejected/truncated so we never bloat a chat.

import * as fs from "fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "path";
import type { Attachment } from "./types.js";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../renderer/shared/attachment-contract.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_TEXT_CHARS = 100_000;
export const MAX_TEXT_READ_BYTES = MAX_TEXT_CHARS * 4;
export const MAX_ATTACHMENT_BATCH_BYTES = MAX_ATTACHMENT_INLINE_BYTES;
export const MAX_CLIPBOARD_IMAGES = MAX_ATTACHMENTS_PER_MESSAGE;
const ATTACHMENT_REPRESENTATION_OVERHEAD_BYTES = 1024;
export const MAX_ATTACHMENT_INGESTION_REPRESENTATION_BYTES =
  Math.ceil(MAX_ATTACHMENT_BATCH_BYTES / 3) * 4 +
  MAX_ATTACHMENTS_PER_MESSAGE * ATTACHMENT_REPRESENTATION_OVERHEAD_BYTES;
const TEXT_TRUNCATION_SUFFIX = "\n… [truncated]";

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

export function isCanonicalRasterImageMimeType(
  value: unknown,
): value is CanonicalRasterImageMimeType {
  return typeof value === "string" && CANONICAL_RASTER_IMAGE_MIME_TYPE_SET.has(value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isoBaseMediaBrands(bytes: Uint8Array): Set<string> {
  if (bytes.byteLength < 12 || ascii(bytes, 4, 4) !== "ftyp") return new Set();
  const brands = new Set<string>([ascii(bytes, 8, 4)]);
  const declaredBoxBytes =
    bytes[0]! * 0x1000000 + bytes[1]! * 0x10000 + bytes[2]! * 0x100 + bytes[3]!;
  const availableBoxBytes = Math.min(
    bytes.byteLength,
    declaredBoxBytes >= 16 ? declaredBoxBytes : bytes.byteLength,
  );
  for (let offset = 16; offset + 4 <= availableBoxBytes; offset += 4) {
    brands.add(ascii(bytes, offset, 4));
  }
  return brands;
}

/** Match the canonical raster MIME to the bytes that main will retain and later generate with. */
export function imageBytesMatchMime(
  bytes: Uint8Array,
  mimeType: CanonicalRasterImageMimeType,
): boolean {
  switch (mimeType) {
    case "image/png":
      return (
        bytes.byteLength >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
    case "image/bmp":
      return bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
    case "image/heic": {
      const brands = isoBaseMediaBrands(bytes);
      return ["heic", "heix", "hevc", "hevx", "heim", "heis"].some((brand) => brands.has(brand));
    }
    case "image/heif": {
      const brands = isoBaseMediaBrands(bytes);
      return ["mif1", "msf1", "heif"].some((brand) => brands.has(brand));
    }
  }
}

export function attachmentIngestionRepresentationBytes(
  inlineBytes: number,
  attachmentCount: number,
): number {
  if (
    !Number.isSafeInteger(inlineBytes) ||
    inlineBytes < 1 ||
    inlineBytes > MAX_ATTACHMENT_BATCH_BYTES ||
    !Number.isSafeInteger(attachmentCount) ||
    attachmentCount < 1 ||
    attachmentCount > MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    throw new Error("Invalid attachment ingestion reservation.");
  }
  return (
    Math.ceil(inlineBytes / 3) * 4 + attachmentCount * ATTACHMENT_REPRESENTATION_OVERHEAD_BYTES
  );
}

export interface AttachmentIngestionAdmissionOptions {
  maxActivePerDocument?: number;
  maxGlobalActive?: number;
  maxGlobalAttachments?: number;
  maxGlobalRepresentationBytes?: number;
}

export interface AttachmentIngestionLease {
  isActive(): boolean;
  cancel(): void;
  release(): void;
}

interface AttachmentIngestionRecord {
  documentId: string;
  attachmentCount: number;
  representationBytes: number;
  cancelled: boolean;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid attachment admission ${name}.`);
  }
  return value;
}

function hasExactObjectKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > expected.size || !expected.has(key)) return false;
  }
  return count === expected.size;
}

/** Process-owned accounting for renderer-triggered picker, drop, and clipboard ingestion. */
export class AttachmentIngestionAdmission {
  private readonly records = new Set<AttachmentIngestionRecord>();
  private readonly activeByDocument = new Map<string, number>();
  private readonly maxActivePerDocument: number;
  private readonly maxGlobalActive: number;
  private readonly maxGlobalAttachments: number;
  private readonly maxGlobalRepresentationBytes: number;
  private activeAttachments = 0;
  private activeRepresentationBytes = 0;

  constructor(options: AttachmentIngestionAdmissionOptions = {}) {
    this.maxActivePerDocument = positiveSafeInteger(
      options.maxActivePerDocument ?? 1,
      "per-document limit",
    );
    this.maxGlobalActive = positiveSafeInteger(options.maxGlobalActive ?? 2, "global limit");
    this.maxGlobalAttachments = positiveSafeInteger(
      options.maxGlobalAttachments ?? MAX_ATTACHMENTS_PER_MESSAGE * 2,
      "attachment limit",
    );
    this.maxGlobalRepresentationBytes = positiveSafeInteger(
      options.maxGlobalRepresentationBytes ?? MAX_ATTACHMENT_INGESTION_REPRESENTATION_BYTES * 2,
      "representation limit",
    );
  }

  acquire(
    documentId: string,
    attachmentCount: number,
    representationBytes: number,
  ): AttachmentIngestionLease {
    if (
      typeof documentId !== "string" ||
      documentId.length === 0 ||
      !Number.isSafeInteger(attachmentCount) ||
      attachmentCount < 1 ||
      attachmentCount > MAX_ATTACHMENTS_PER_MESSAGE ||
      !Number.isSafeInteger(representationBytes) ||
      representationBytes < 1 ||
      representationBytes > MAX_ATTACHMENT_INGESTION_REPRESENTATION_BYTES
    ) {
      throw new Error("Invalid attachment ingestion reservation.");
    }
    if ((this.activeByDocument.get(documentId) ?? 0) >= this.maxActivePerDocument) {
      throw new Error("Another attachment request is already running for this window.");
    }
    if (
      this.records.size >= this.maxGlobalActive ||
      attachmentCount > this.maxGlobalAttachments - this.activeAttachments ||
      representationBytes > this.maxGlobalRepresentationBytes - this.activeRepresentationBytes
    ) {
      throw new Error("Too many attachment requests are in progress. Try again in a moment.");
    }

    const record: AttachmentIngestionRecord = {
      documentId,
      attachmentCount,
      representationBytes,
      cancelled: false,
    };
    this.records.add(record);
    this.activeByDocument.set(documentId, (this.activeByDocument.get(documentId) ?? 0) + 1);
    this.activeAttachments += attachmentCount;
    this.activeRepresentationBytes += representationBytes;

    const release = (): void => {
      if (!this.records.delete(record)) return;
      const remainingForDocument = (this.activeByDocument.get(documentId) ?? 1) - 1;
      if (remainingForDocument === 0) this.activeByDocument.delete(documentId);
      else this.activeByDocument.set(documentId, remainingForDocument);
      this.activeAttachments -= attachmentCount;
      this.activeRepresentationBytes -= representationBytes;
    };
    return {
      isActive: () => this.records.has(record) && !record.cancelled,
      cancel: () => {
        if (this.records.has(record)) record.cancelled = true;
      },
      release,
    };
  }
}

interface PathIdentityEntry {
  path: string;
  dev: number;
  ino: number;
  directory: boolean;
  fixedAliasTarget?: string;
}

interface PickedPathIdentity {
  openPath: string;
  lexicalEntries: PathIdentityEntry[];
  selected: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  };
}

const FIXED_SYSTEM_ALIASES = new Map<string, string>([
  ["/etc", "/private/etc"],
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
]);

const IMAGE_MIME: Record<string, CanonicalRasterImageMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
};

const CLIPBOARD_IMAGE_NAME: Record<CanonicalRasterImageMimeType, string> = {
  "image/png": "Pasted image.png",
  "image/jpeg": "Pasted image.jpg",
  "image/gif": "Pasted image.gif",
  "image/webp": "Pasted image.webp",
  "image/bmp": "Pasted image.bmp",
  "image/heic": "Pasted image.heic",
  "image/heif": "Pasted image.heif",
};

export function isImageAttachmentPath(filePath: string): boolean {
  return Boolean(IMAGE_MIME[path.extname(filePath).slice(1).toLowerCase()]);
}

function newId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readBounded(
  handle: fs.FileHandle,
  byteLimit: number,
  expectedSize: number,
): Promise<Buffer> {
  const bytesToRead = Math.min(expectedSize, byteLimit);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let offset = 0;
  while (offset < bytesToRead) {
    const { bytesRead } = await handle.read(buffer, offset, bytesToRead - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

async function assertFileUnchanged(
  handle: fs.FileHandle,
  initial: Awaited<ReturnType<fs.FileHandle["stat"]>>,
  name: string,
): Promise<void> {
  const current = await handle.stat();
  if (
    current.size !== initial.size ||
    current.mtimeMs !== initial.mtimeMs ||
    current.ctimeMs !== initial.ctimeMs
  ) {
    throw new Error(`${name} changed while it was being attached. Please select it again.`);
  }
}

function truncateTextWithSuffix(text: string): string {
  let end = MAX_TEXT_CHARS - TEXT_TRUNCATION_SUFFIX.length;
  const finalCodeUnit = text.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${TEXT_TRUNCATION_SUFFIX}`;
}

async function assertPathEntries(entries: readonly PathIdentityEntry[]): Promise<void> {
  for (const expected of entries) {
    const current = await fs.lstat(expected.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error("The selected file path changed. Please select it again.");
    }
    if (expected.fixedAliasTarget) {
      if (
        !current.isSymbolicLink() ||
        path.resolve(path.dirname(expected.path), await fs.readlink(expected.path)) !==
          expected.fixedAliasTarget
      ) {
        throw new Error("The selected file path changed. Please select it again.");
      }
    } else if (current.isSymbolicLink() || (expected.directory && !current.isDirectory())) {
      throw new Error("The selected file path changed. Please select it again.");
    }
  }
}

async function capturePickedPathIdentity(
  filePath: string,
  afterLexicalCapture?: (filePath: string) => void | Promise<void>,
): Promise<PickedPathIdentity> {
  if (!path.isAbsolute(filePath)) throw new Error("The selected file path is invalid.");
  const normalizedPath = path.normalize(filePath);
  const root = path.parse(normalizedPath).root;
  const lexicalEntries: PathIdentityEntry[] = [];
  let selected: PickedPathIdentity["selected"] | undefined;
  let lexical = root;
  for (const segment of normalizedPath.slice(root.length).split(path.sep).filter(Boolean)) {
    lexical = path.join(lexical, segment);
    const stat = await fs.lstat(lexical);
    const directory = lexical !== normalizedPath;
    if (!stat.isSymbolicLink()) {
      if (directory && !stat.isDirectory()) {
        throw new Error("The selected file path contains a non-directory ancestor.");
      }
      lexicalEntries.push({ path: lexical, dev: stat.dev, ino: stat.ino, directory });
      if (!directory) {
        selected = {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        };
      }
      continue;
    }
    const expectedTarget = FIXED_SYSTEM_ALIASES.get(lexical);
    const linkTarget = path.resolve(path.dirname(lexical), await fs.readlink(lexical));
    if (expectedTarget !== linkTarget) {
      throw new Error("The selected file path contains an unsafe symbolic link.");
    }
    lexicalEntries.push({
      path: lexical,
      dev: stat.dev,
      ino: stat.ino,
      directory,
      fixedAliasTarget: linkTarget,
    });
  }
  if (!selected) throw new Error("The selected file path is not a regular file.");
  await afterLexicalCapture?.(filePath);
  await assertPathEntries(lexicalEntries);
  // Open this exact lexical path later and compare the resulting descriptor
  // with the selected file snapshot. Even if an ancestor is redirected only
  // during open(), a different target cannot pass the descriptor comparison.
  return { openPath: normalizedPath, lexicalEntries, selected };
}

async function assertPickedPathIdentity(
  identity: PickedPathIdentity,
  opened: Awaited<ReturnType<fs.FileHandle["stat"]>>,
): Promise<void> {
  await assertPathEntries(identity.lexicalEntries);
  const selected = identity.selected;
  if (
    opened.dev !== selected.dev ||
    opened.ino !== selected.ino ||
    opened.size !== selected.size ||
    opened.mtimeMs !== selected.mtimeMs ||
    opened.ctimeMs !== selected.ctimeMs
  ) {
    throw new Error("The selected file path changed. Please select it again.");
  }
}

async function readOne(
  filePath: string,
  remainingBatchBytes: number,
  isActive: () => boolean,
  afterLexicalCapture?: (filePath: string) => void | Promise<void>,
  beforeOpen?: (filePath: string) => void | Promise<void>,
  beforeConsistencyCheck?: (filePath: string) => void | Promise<void>,
): Promise<{ attachment: Attachment; bytesRead: number }> {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  let identity: PickedPathIdentity;
  try {
    identity = await capturePickedPathIdentity(filePath, afterLexicalCapture);
    await beforeOpen?.(filePath);
  } catch {
    throw new Error(`${name || "The selected file"} couldn't be read safely.`);
  }
  if (!isActive()) throw new Error("The renderer document is no longer active.");
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      identity.openPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(`${name || "The selected file"} couldn't be read.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${name || "The selected file"} isn't a regular file.`);
    await assertPickedPathIdentity(identity, stat);
    if (!isActive()) throw new Error("The renderer document is no longer active.");

    const imageMime = IMAGE_MIME[ext];
    if (imageMime) {
      if (stat.size === 0) throw new Error(`${name} is empty and can't be attached as an image.`);
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(`${name} is too large to attach (max 8 MB).`);
      }
      if (stat.size > remainingBatchBytes) {
        throw new Error(
          `The selected attachments exceed the ${MAX_ATTACHMENT_BATCH_BYTES / 1024 / 1024} MB batch limit.`,
        );
      }
      const buf = await readBounded(handle, MAX_IMAGE_BYTES + 1, stat.size);
      if (buf.length !== stat.size) {
        throw new Error(`${name} changed while it was being attached. Please select it again.`);
      }
      if (!isActive()) throw new Error("The renderer document is no longer active.");
      await beforeConsistencyCheck?.(filePath);
      await assertFileUnchanged(handle, stat, name);
      await assertPickedPathIdentity(identity, stat);
      if (!isActive()) throw new Error("The renderer document is no longer active.");
      if (!imageBytesMatchMime(buf, imageMime)) {
        throw new Error(`${name} doesn't match its image file type.`);
      }
      return {
        attachment: {
          id: newId(),
          name,
          mimeType: imageMime,
          kind: "image",
          size: stat.size,
          data: buf.toString("base64"),
        },
        bytesRead: buf.length,
      };
    }

    const textReadLimit = Math.min(MAX_TEXT_READ_BYTES, remainingBatchBytes);
    if (textReadLimit <= 0) {
      throw new Error(
        `The selected attachments exceed the ${MAX_ATTACHMENT_BATCH_BYTES / 1024 / 1024} MB batch limit.`,
      );
    }
    const buf = await readBounded(handle, textReadLimit, stat.size);
    if (buf.length !== Math.min(stat.size, textReadLimit)) {
      throw new Error(`${name} changed while it was being attached. Please select it again.`);
    }
    if (!isActive()) throw new Error("The renderer document is no longer active.");
    await beforeConsistencyCheck?.(filePath);
    await assertFileUnchanged(handle, stat, name);
    await assertPickedPathIdentity(identity, stat);
    if (!isActive()) throw new Error("The renderer document is no longer active.");
    if (buf.includes(0)) {
      throw new Error(`${name} isn't a supported text or image file.`);
    }
    let text: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      text = decoder.decode(buf, { stream: stat.size > buf.length });
    } catch {
      throw new Error(`${name} isn't valid UTF-8 text.`);
    }
    const needsTruncation = stat.size > buf.length || text.length > MAX_TEXT_CHARS;
    const truncated = needsTruncation ? truncateTextWithSuffix(text) : text;
    const inlineBytes = Buffer.byteLength(truncated, "utf8");
    if (inlineBytes > remainingBatchBytes) {
      throw new Error(
        `The selected attachments exceed the ${MAX_ATTACHMENT_BATCH_BYTES / 1024 / 1024} MB batch limit.`,
      );
    }
    return {
      attachment: {
        id: newId(),
        name,
        mimeType: "text/plain",
        kind: "text",
        size: stat.size,
        text: truncated,
      },
      bytesRead: inlineBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Read only paths returned directly by the main-owned native picker. */
export interface PickedAttachmentReadOptions {
  isActive?: () => boolean;
  /** Production may narrow, but never widen, the fixed process limit. */
  maxBatchBytes?: number;
  /** Deterministic filesystem-race hook used only by tests. */
  afterLexicalCapture?: (filePath: string) => void | Promise<void>;
  /** Deterministic filesystem-race hook used only by tests. */
  beforeOpen?: (filePath: string) => void | Promise<void>;
  /** Deterministic filesystem-race hook used only by tests. */
  beforeConsistencyCheck?: (filePath: string) => void | Promise<void>;
}

export async function readPickedAttachments(
  paths: readonly string[],
  options: PickedAttachmentReadOptions = {},
): Promise<Attachment[]> {
  if (paths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files can be attached to one message.`);
  }
  const isActive = options.isActive ?? (() => true);
  const maxBatchBytes = options.maxBatchBytes ?? MAX_ATTACHMENT_BATCH_BYTES;
  if (
    !Number.isSafeInteger(maxBatchBytes) ||
    maxBatchBytes < 1 ||
    maxBatchBytes > MAX_ATTACHMENT_BATCH_BYTES
  ) {
    throw new Error("Invalid attachment batch limit.");
  }
  const attachments: Attachment[] = [];
  let bytesRead = 0;
  for (const filePath of paths) {
    if (!isActive()) throw new Error("The renderer document is no longer active.");
    const result = await readOne(
      filePath,
      maxBatchBytes - bytesRead,
      isActive,
      options.afterLexicalCapture,
      options.beforeOpen,
      options.beforeConsistencyCheck,
    );
    bytesRead += result.bytesRead;
    attachments.push(result.attachment);
  }
  if (!isActive()) throw new Error("The renderer document is no longer active.");
  return attachments;
}

interface ValidatedClipboardImage {
  mimeType: CanonicalRasterImageMimeType;
  bytes: Uint8Array;
}

const CLIPBOARD_IMAGE_KEYS = new Set(["mimeType", "bytes"]);

export interface ValidatedClipboardAttachmentPayload {
  images: readonly ValidatedClipboardImage[];
  inlineBytes: number;
  representationBytes: number;
}

/** Validate renderer-cloned clipboard metadata before reserving conversion capacity. */
export function validateClipboardAttachmentPayload(
  value: unknown,
  remainingSlots: unknown,
  remainingInlineBytes: unknown,
): ValidatedClipboardAttachmentPayload {
  if (
    !Number.isSafeInteger(remainingSlots) ||
    (remainingSlots as number) < 1 ||
    (remainingSlots as number) > MAX_CLIPBOARD_IMAGES ||
    !Number.isSafeInteger(remainingInlineBytes) ||
    (remainingInlineBytes as number) < 1 ||
    (remainingInlineBytes as number) > MAX_ATTACHMENT_BATCH_BYTES ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > (remainingSlots as number)
  ) {
    throw new Error("Invalid clipboard image payload.");
  }

  const images: ValidatedClipboardImage[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Invalid clipboard image payload.");
    }
    const record = candidate as Record<string, unknown>;
    if (
      !hasExactObjectKeys(record, CLIPBOARD_IMAGE_KEYS) ||
      !isCanonicalRasterImageMimeType(record.mimeType) ||
      !(record.bytes instanceof Uint8Array) ||
      record.bytes.byteLength === 0 ||
      record.bytes.byteLength > MAX_IMAGE_BYTES
    ) {
      throw new Error("Invalid clipboard image payload.");
    }
    totalBytes += record.bytes.byteLength;
    if (totalBytes > (remainingInlineBytes as number)) {
      throw new Error("Clipboard images exceed the remaining attachment data limit.");
    }
    images.push({ mimeType: record.mimeType, bytes: record.bytes });
  }
  return {
    images,
    inlineBytes: totalBytes,
    representationBytes: attachmentIngestionRepresentationBytes(totalBytes, images.length),
  };
}

/** Convert admitted in-memory clipboard images without granting filesystem authority. */
export function materializeClipboardAttachments(
  payload: ValidatedClipboardAttachmentPayload,
  isActive: () => boolean = () => true,
): Attachment[] {
  const attachments: Attachment[] = [];
  for (const image of payload.images) {
    if (!isActive()) throw new Error("The renderer document is no longer active.");
    const bytes = Buffer.from(image.bytes);
    if (bytes.byteLength === 0 || !imageBytesMatchMime(bytes, image.mimeType)) {
      throw new Error("Clipboard image bytes do not match the declared image type.");
    }
    attachments.push({
      id: newId(),
      name: CLIPBOARD_IMAGE_NAME[image.mimeType],
      mimeType: image.mimeType,
      kind: "image",
      size: bytes.byteLength,
      data: bytes.toString("base64"),
    });
  }
  if (!isActive()) throw new Error("The renderer document is no longer active.");
  return attachments;
}

/** Validate and convert bounded clipboard images for non-IPC callers and focused tests. */
export function readClipboardAttachments(
  value: unknown,
  remainingSlots: unknown,
  remainingInlineBytes: unknown,
  isActive: () => boolean = () => true,
): Attachment[] {
  return materializeClipboardAttachments(
    validateClipboardAttachmentPayload(value, remainingSlots, remainingInlineBytes),
    isActive,
  );
}
