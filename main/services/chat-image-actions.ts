// Actions on an image shown in a chat: save it to Downloads, copy it to the
// clipboard, and reveal a saved copy in Finder. The renderer names the image
// only by chat and attachment id; the bytes always come from the stored chat,
// never from the renderer.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  isCanonicalRasterImageMimeType,
  type CanonicalRasterImageMimeType,
} from "../../renderer/shared/attachment-contract.js";
import type { Chat } from "./types.js";

const MAX_ID_LENGTH = 256;
const MAX_FILE_STEM = 120;
/**
 * Most UTF-8 bytes a file name stem may take. Linux file systems cap a name at 255 bytes, so a
 * stem of 180 leaves room for a time prefix, a hash, an extension and a " (999)" suffix.
 */
export const MAX_FILE_STEM_BYTES = 180;
const MAX_UNIQUE_ATTEMPTS = 1000;
const EXTENSIONS: Readonly<Record<CanonicalRasterImageMimeType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export interface ChatImageActionDeps {
  /** The chat as stored; an image may be a file reference instead of carrying its bytes. */
  getChat(chatId: string): Promise<Pick<Chat, "messages"> | null>;
  /** One stored image's bytes by hash, when the chat keeps images as files. */
  readImage?(sha256: string, size: number): Promise<Uint8Array | undefined>;
  downloadsDir(): string;
  /** Throws when the bytes cannot be decoded as an image. */
  writeClipboardImage(bytes: Buffer): void;
  showItemInFolder(filePath: string): void;
}

interface ImageRef {
  chatId: string;
  attachmentId: string;
}

function parseImageRef(input: unknown): ImageRef {
  const value = input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
  const keys = value ? Object.keys(value) : [];
  const valid = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= MAX_ID_LENGTH;
  if (!value || keys.some((key) => key !== "chatId" && key !== "attachmentId") || !valid(value.chatId) || !valid(value.attachmentId))
    throw new Error("Invalid image request.");
  return { chatId: value.chatId as string, attachmentId: value.attachmentId as string };
}

/**
 * A file name safe for any folder: no separators, C0/C1 control characters,
 * bidirectional overrides or isolates (which can disguise an extension in
 * Finder), or leading dots.
 */
export function safeImageFileStem(name: string): string {
  return safeFileNameStem(name.replace(/\.[a-z0-9]{1,5}$/iu, ""));
}

/** `safeImageFileStem` for text that has no extension to strip, such as a title. */
export function safeFileNameStem(name: string, fallback = "Image"): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+/u, "");
  return truncateFileNameText(cleaned, MAX_FILE_STEM, MAX_FILE_STEM_BYTES).trim() || fallback;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest prefix of `text` within `maxUnits` UTF-16 units and `maxBytes` UTF-8 bytes,
 * cut only between graphemes, so no code point, emoji or accented letter is split.
 */
export function truncateFileNameText(text: string, maxUnits: number, maxBytes: number): string {
  if (text.length <= maxUnits && Buffer.byteLength(text) <= maxBytes) return text;
  let units = 0;
  let bytes = 0;
  let kept = "";
  for (const { segment } of graphemes.segment(text)) {
    units += segment.length;
    bytes += Buffer.byteLength(segment);
    if (units > maxUnits || bytes > maxBytes) break;
    kept += segment;
  }
  return kept;
}

export function createChatImageActions(deps: ChatImageActionDeps) {
  const saved = new Set<string>();

  async function image(input: unknown) {
    const ref = parseImageRef(input);
    const chat = await deps.getChat(ref.chatId);
    if (!chat) throw new Error("The chat is no longer available.");
    for (const message of chat.messages) {
      const attachment = message.attachments?.find((candidate) => candidate.id === ref.attachmentId);
      if (!attachment) continue;
      if (attachment.kind !== "image" || !isCanonicalRasterImageMimeType(attachment.mimeType)) break;
      const bytes = attachment.data
        ? Buffer.from(attachment.data, "base64")
        : attachment.sha256 && deps.readImage
          ? await deps.readImage(attachment.sha256, attachment.size)
          : undefined;
      if (!bytes) break;
      return { attachment, mimeType: attachment.mimeType, bytes: Buffer.from(bytes) };
    }
    throw new Error("This image isn't saved in the chat yet. Try again when the response finishes.");
  }

  return {
    /** Writes a new file in Downloads (never overwriting) and returns its path. */
    async saveToDownloads(input: unknown): Promise<{ path: string }> {
      const { attachment, mimeType, bytes } = await image(input);
      const dir = deps.downloadsDir();
      const stem = safeImageFileStem(attachment.name);
      const extension = EXTENSIONS[mimeType];
      for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
        const filePath = path.join(dir, `${attempt === 0 ? stem : `${stem} (${attempt})`}.${extension}`);
        let handle: fs.FileHandle;
        try {
          handle = await fs.open(filePath, "wx", 0o644);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw new Error("Aiden couldn't save the image to Downloads.");
        }
        try {
          await handle.writeFile(bytes);
        } catch {
          await handle.close().catch(() => undefined);
          await fs.rm(filePath, { force: true }).catch(() => undefined);
          throw new Error("Aiden couldn't save the image to Downloads.");
        }
        await handle.close();
        saved.add(filePath);
        return { path: filePath };
      }
      throw new Error("Aiden couldn't find a free file name in Downloads.");
    },
    async copy(input: unknown): Promise<true> {
      const { bytes } = await image(input);
      try {
        deps.writeClipboardImage(bytes);
      } catch {
        throw new Error("Aiden couldn't copy this image.");
      }
      return true;
    },
    /**
     * The image's base64 bytes, for reusing it in a new message (a fork's
     * composer). The window otherwise loads stored images by link.
     */
    async data(input: unknown): Promise<{ data: string }> {
      const { bytes } = await image(input);
      return { data: bytes.toString("base64") };
    },
    /** Reveals only a file this app session saved. */
    showSaved(input: unknown): true {
      if (typeof input !== "string" || !saved.has(input)) throw new Error("That saved image isn't available.");
      deps.showItemInFolder(input);
      return true;
    },
  };
}

type Handle = (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void;

export function registerChatImageActionHandlers(ipc: { handle: Handle }, deps: ChatImageActionDeps): void {
  const actions = createChatImageActions(deps);
  ipc.handle("chats:saveImageToDownloads", (_event, input) => actions.saveToDownloads(input));
  ipc.handle("chats:copyImage", (_event, input) => actions.copy(input));
  ipc.handle("chats:showSavedImage", (_event, filePath) => actions.showSaved(filePath));
  ipc.handle("chats:imageData", (_event, input) => actions.data(input));
}
