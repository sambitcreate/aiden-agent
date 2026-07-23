// Reads files the user attaches in the composer. Images come back as base64
// (for vision models); everything else is read as UTF-8 text and inlined as
// context. Oversized files are rejected/truncated so we never bloat a chat.

import * as fs from "fs/promises";
import * as path from "path";
import type { Attachment } from "./types.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_TEXT_CHARS = 100_000;
const TEXT_TRUNCATION_SUFFIX = "\n… [truncated]";

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

function newId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readOne(filePath: string): Promise<Attachment | null> {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const imageMime = IMAGE_MIME[ext];
  if (imageMime) {
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`${name} is too large to attach (max 8 MB).`);
    }
    const buf = await fs.readFile(filePath);
    return {
      id: newId(),
      name,
      mimeType: imageMime,
      kind: "image",
      size: stat.size,
      data: buf.toString("base64"),
    };
  }

  // Treat everything else as text; reject obvious binaries (contain NUL bytes).
  const buf = await fs.readFile(filePath);
  if (buf.includes(0)) {
    throw new Error(`${name} isn't a supported text or image file.`);
  }
  const text = buf.toString("utf-8");
  const truncated =
    text.length > MAX_TEXT_CHARS
      ? `${text.slice(0, MAX_TEXT_CHARS - TEXT_TRUNCATION_SUFFIX.length)}${TEXT_TRUNCATION_SUFFIX}`
      : text;
  return {
    id: newId(),
    name,
    mimeType: "text/plain",
    kind: "text",
    size: stat.size,
    text: truncated,
  };
}

/** Read attachments for the given file paths, skipping unreadable ones. */
export async function readAttachments(paths: string[]): Promise<Attachment[]> {
  const results = await Promise.all(paths.map((p) => readOne(p)));
  return results.filter((a): a is Attachment => a !== null);
}
