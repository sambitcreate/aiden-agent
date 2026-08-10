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
const TEXT_TRUNCATION_SUFFIX = "\n… [truncated]";

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

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
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
      await beforeConsistencyCheck?.(filePath);
      await assertFileUnchanged(handle, stat, name);
      await assertPickedPathIdentity(identity, stat);
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
    await beforeConsistencyCheck?.(filePath);
    await assertFileUnchanged(handle, stat, name);
    await assertPickedPathIdentity(identity, stat);
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
