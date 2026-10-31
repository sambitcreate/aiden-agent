// Image bytes of chat attachments, one file per image, beside the chats.
//
// A chat file keeps each image's id, name, type, size, pixel size and the
// SHA-256 of its bytes; the bytes live once in `chats/images/<2 hex>/<sha256>`.
// Files are content-addressed, so a copied or forked chat shares its source's
// files and saving a chat never rewrites an image. A file is published with an
// exclusive hard link, so two writers of the same image never replace each
// other, and is only ever removed by `sweep` once no chat refers to it and it
// has not been stored or reused for the grace window.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncDirectory as syncDirectoryPath, writeFileAtomic } from "./durable-fs.js";

export const CHAT_IMAGES_DIRECTORY = "images";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHARD = /^[0-9a-f]{2}$/u;
/** Leftover staging files from `writeFileAtomic` (`.<sha>.<uuid>.tmp`). */
const STAGING = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/u;

export function isImageSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function imageSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hashes of image attachments that carry their bytes inline in this process:
 * either just stored, or read back for a main-process caller. Kept off the
 * attachment's own fields so it keeps the exact shape every consumer
 * validates; the window projection uses it to send a link instead of bytes.
 */
const inlineImageHashes = new WeakMap<object, string>();

export function rememberImageHash(attachment: object, sha256: string): void {
  inlineImageHashes.set(attachment, sha256);
}

/** The stored file hash of an image attachment, whether it is a reference or carries its bytes. */
export function storedImageHashOf(attachment: { sha256?: string }): string | undefined {
  return attachment.sha256 ?? inlineImageHashes.get(attachment);
}

export interface ChatImageSweepOptions {
  /** Files younger than this are kept: a chat that refers to them may still be on its way to disk. */
  graceMs: number;
  /** Hashes a write in this process started referring to after the sweep's chat scan began. */
  isProtected?: (sha256: string) => boolean;
  now?: () => number;
}

export interface ChatImageStoreIo {
  syncDirectory(directory: string): Promise<void>;
}

export function createChatImageStore(
  resolveChatsDir: () => Promise<string>,
  io: Partial<ChatImageStoreIo> = {},
) {
  const syncDirectory = io.syncDirectory ?? syncDirectoryPath;
  // Directories whose own entry is known to be durable in their parent.
  const durableDirectories = new Set<string>();
  // A put and a sweep never cross on one hash: the sweep skips a hash with a
  // put in flight, and a put waits for a removal already under way.
  const putsInFlight = new Map<string, number>();
  const removals = new Map<string, Promise<void>>();

  async function imagesDirectory(): Promise<string> {
    return path.join(await resolveChatsDir(), CHAT_IMAGES_DIRECTORY);
  }

  async function filePath(sha256: string): Promise<string> {
    if (!isImageSha256(sha256)) throw new Error("Invalid image hash.");
    return path.join(await imagesDirectory(), sha256.slice(0, 2), sha256);
  }

  /** Create `directory` and make its entry durable in its parent, once per process. */
  async function ensureDurableDirectory(directory: string): Promise<void> {
    if (durableDirectories.has(directory)) return;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(path.dirname(directory));
    durableDirectories.add(directory);
  }

  async function regularFileSize(target: string): Promise<number | undefined> {
    try {
      const stat = await fs.lstat(target);
      return stat.isFile() ? stat.size : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  return {
    /** Absolute path of an image's file, for streaming it. */
    path: filePath,

    /**
     * Store an image's bytes and return their hash. Storing bytes that are
     * already there writes nothing.
     */
    async put(bytes: Uint8Array): Promise<string> {
      const sha256 = imageSha256(bytes);
      putsInFlight.set(sha256, (putsInFlight.get(sha256) ?? 0) + 1);
      try {
        await removals.get(sha256);
        const target = await filePath(sha256);
        if ((await regularFileSize(target)) === bytes.byteLength) {
          // Reused bytes count as fresh for the sweep's grace window.
          const now = new Date();
          await fs.utimes(target, now, now).catch(() => undefined);
          return sha256;
        }
        const images = await imagesDirectory();
        await ensureDurableDirectory(images);
        await ensureDurableDirectory(path.dirname(target));
        try {
          await writeFileAtomic(target, bytes, { exclusive: true, mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Another writer published the same bytes first, or a damaged file
          // holds the name: replace only the latter.
          if ((await regularFileSize(target)) !== bytes.byteLength) {
            await fs.rm(target, { force: true });
            await writeFileAtomic(target, bytes, { exclusive: true, mode: 0o600 });
          }
        }
        return sha256;
      } finally {
        const remaining = (putsInFlight.get(sha256) ?? 1) - 1;
        if (remaining > 0) putsInFlight.set(sha256, remaining);
        else putsInFlight.delete(sha256);
      }
    },

    /** The image's bytes, or undefined when its file is missing or not the recorded size. */
    async read(sha256: string, expectedSize: number): Promise<Buffer | undefined> {
      const target = await filePath(sha256);
      if ((await regularFileSize(target)) !== expectedSize) return undefined;
      try {
        const bytes = await fs.readFile(target);
        return bytes.byteLength === expectedSize ? bytes : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },

    /** Whether the image's file exists with the recorded size. */
    async has(sha256: string, expectedSize: number): Promise<boolean> {
      return (await regularFileSize(await filePath(sha256))) === expectedSize;
    },

    /**
     * Remove image files no chat refers to. `referenced` must come from a
     * scan of every chat that started before this call; files written since
     * are kept by the grace window and `isProtected`.
     */
    async sweep(
      referenced: ReadonlySet<string>,
      options: ChatImageSweepOptions,
    ): Promise<{ removed: number; deferred: number }> {
      const now = options.now ?? Date.now;
      const images = await imagesDirectory();
      let shards: string[];
      try {
        shards = await fs.readdir(images);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, deferred: 0 };
        throw error;
      }
      let removed = 0;
      // Unused images kept for now because they are recent or protected.
      let deferred = 0;
      for (const shard of shards) {
        if (!SHARD.test(shard)) continue;
        const directory = path.join(images, shard);
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }
        let changed = false;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const name = entry.name;
          const image = SHA256_HEX.test(name) && name.startsWith(shard);
          if (!image && !STAGING.test(name)) continue;
          if (image && referenced.has(name)) continue;
          if (image && options.isProtected?.(name)) {
            deferred += 1;
            continue;
          }
          const target = path.join(directory, name);
          let stat: import("node:fs").Stats;
          try {
            stat = await fs.lstat(target);
          } catch {
            continue;
          }
          // Re-check right before removing: a write may have started using it.
          if (
            now() - stat.mtimeMs < options.graceMs ||
            (image && (putsInFlight.has(name) || options.isProtected?.(name)))
          ) {
            if (image) deferred += 1;
            continue;
          }
          const removal = fs.rm(target, { force: true });
          if (image) removals.set(name, removal.catch(() => undefined));
          try {
            await removal;
          } finally {
            if (image) removals.delete(name);
          }
          changed = true;
          if (image) removed += 1;
        }
        if (changed) await syncDirectory(directory).catch(() => undefined);
      }
      return { removed, deferred };
    },
  };
}

export type ChatImageStore = ReturnType<typeof createChatImageStore>;
