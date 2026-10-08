/**
 * Where an agent may save a simulator screenshot: inside the chat's workspace
 * or the user's Downloads folder, and nowhere else. Paths are checked
 * lexically first and again after resolving symlinks, so neither `..` nor a
 * link inside an allowed folder can lead out of it. The file itself is opened
 * without following a final symlink.
 */
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface DeviceSaveRoots {
  /** The chat's workspace folder, when the chat has one with file access. */
  workspace?: string;
  /** The user's Downloads folder. */
  downloads?: string;
}

const MAX_SAVE_PATH_LENGTH = 1024;
export const DEVICE_SAVE_PATH_HINT =
  "Save screenshots inside this chat's workspace or the Downloads folder, as a .png file.";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a requested save path lexically. A relative path is relative to
 * the workspace. A path without an extension, or ending in a separator, is a
 * folder and gets `defaultName`. Throws when the result is outside every root.
 */
export function resolveDeviceSavePath(requested: unknown, roots: DeviceSaveRoots, defaultName: string): string {
  if (typeof requested !== "string" || !requested.trim() || requested.length > MAX_SAVE_PATH_LENGTH) {
    throw new Error(`A save path is required. ${DEVICE_SAVE_PATH_HINT}`);
  }
  if (/[\0\r\n]/u.test(requested)) throw new Error(`That save path is not allowed. ${DEVICE_SAVE_PATH_HINT}`);
  const allowed = [roots.workspace, roots.downloads].filter((root): root is string => Boolean(root && path.isAbsolute(root)));
  if (allowed.length === 0) throw new Error("Screenshots cannot be saved to a file in this chat.");
  let base: string;
  if (path.isAbsolute(requested)) base = requested;
  else if (roots.workspace && path.isAbsolute(roots.workspace)) base = path.join(roots.workspace, requested);
  else throw new Error(`Use an absolute path. ${DEVICE_SAVE_PATH_HINT}`);
  const folderLike = /[\\/]$/u.test(requested) || path.extname(requested) === "";
  const resolved = path.resolve(folderLike ? path.join(base, defaultName) : base);
  if (path.extname(resolved).toLowerCase() !== ".png") {
    throw new Error(`Screenshots are PNG files. ${DEVICE_SAVE_PATH_HINT}`);
  }
  if (!allowed.some((root) => inside(path.resolve(root), resolved) && resolved !== path.resolve(root))) {
    throw new Error(`That save path is outside the allowed folders. ${DEVICE_SAVE_PATH_HINT}`);
  }
  return resolved;
}

/**
 * Writes the PNG at a path `resolveDeviceSavePath` accepted. The parent folder
 * is created inside its root, then both are resolved through symlinks and
 * compared again before anything is written.
 */
export async function writeDeviceSaveFile(file: string, roots: DeviceSaveRoots, bytes: Uint8Array): Promise<string> {
  const allowed = [roots.workspace, roots.downloads].filter((root): root is string => Boolean(root && path.isAbsolute(root)));
  const root = allowed.find((candidate) => inside(path.resolve(candidate), file));
  if (!root) throw new Error(`That save path is outside the allowed folders. ${DEVICE_SAVE_PATH_HINT}`);
  const parent = path.dirname(file);
  const realRoot = await realpath(root);
  const escapes = () => new Error(`That save path leads outside the allowed folders. ${DEVICE_SAVE_PATH_HINT}`);
  // The deepest folder that already exists must resolve inside the root before any folder is created.
  let existing = parent;
  for (;;) {
    const resolved = await realpath(existing).catch(() => null);
    if (resolved !== null) {
      if (!inside(realRoot, resolved)) throw escapes();
      break;
    }
    const up = path.dirname(existing);
    if (up === existing) throw escapes();
    existing = up;
  }
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!inside(realRoot, realParent)) throw escapes();
  const target = path.join(realParent, path.basename(file));
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") {
      throw new Error(`That save path is a link, which is not allowed. ${DEVICE_SAVE_PATH_HINT}`);
    }
    throw error;
  });
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return target;
}
