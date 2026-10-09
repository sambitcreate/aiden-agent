/**
 * Where an agent may save a simulator screenshot: inside the chat's workspace
 * or the user's Downloads folder, and nowhere else. Paths are checked
 * lexically first and again after resolving symlinks, so neither `..` nor a
 * link inside an allowed folder can lead out of it. Missing folders are
 * created one level at a time and no folder below the root may be a link.
 * The bytes are written by Aiden's native confined file helper, which holds
 * each folder open while it walks down from the root and replaces the file
 * through the held parent, so a folder swapped for a link after these checks
 * cannot redirect the write.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  captureManagedWorktreeRootIdentity,
  ManagedWorktreeFileIoError,
  saveConfinedWorkspaceFile,
} from "../managed-worktree-file-io.js";

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
 * Writes the PNG at a path `resolveDeviceSavePath` accepted. Walking down from
 * the root's real path, each folder is created alone if it is missing, then
 * checked with `lstat` (a link is refused) and `realpath` (it must still be
 * inside the root) before the next one. A link swapped in for a missing
 * folder therefore stops the walk instead of letting a recursive create
 * follow it out of the root.
 *
 * The walk only produces clear errors. The write itself never re-resolves the
 * checked path: the native helper reopens the root by the device and inode
 * captured before the walk, opens each folder beneath the previous descriptor
 * with `O_NOFOLLOW`, writes an `O_EXCL` temporary in the held parent and
 * renames it over the file through that descriptor. A folder replaced by a
 * link after the walk makes the helper refuse; a folder moved elsewhere after
 * the helper opened it takes the file with it, but nothing outside the root
 * is created, truncated or replaced. An existing file is replaced as a
 * directory entry, so a hard link to a file elsewhere keeps its contents.
 */
export async function writeDeviceSaveFile(file: string, roots: DeviceSaveRoots, bytes: Uint8Array): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Saving screenshots to a file needs macOS.");
  const allowed = [roots.workspace, roots.downloads].filter((root): root is string => Boolean(root && path.isAbsolute(root)));
  const root = allowed.find((candidate) => inside(path.resolve(candidate), file));
  if (!root) throw new Error(`That save path is outside the allowed folders. ${DEVICE_SAVE_PATH_HINT}`);
  const identity = await captureManagedWorktreeRootIdentity(root);
  const realRoot = identity.path;
  const escapes = () => new Error(`That save path leads outside the allowed folders. ${DEVICE_SAVE_PATH_HINT}`);
  const relative = path.relative(path.resolve(root), path.dirname(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw escapes();
  let current = realRoot;
  for (const name of relative ? relative.split(path.sep) : []) {
    const next = path.join(current, name);
    let stats = await lstat(next).catch(() => null);
    if (!stats) {
      await mkdir(next).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      stats = await lstat(next);
    }
    if (stats.isSymbolicLink()) {
      const resolved = await realpath(next).catch(() => null);
      if (resolved === null || !inside(realRoot, resolved)) throw escapes();
      throw new Error(`That save path goes through a link, which is not allowed. ${DEVICE_SAVE_PATH_HINT}`);
    }
    if (!stats.isDirectory()) throw new Error(`That save path names a file as a folder. ${DEVICE_SAVE_PATH_HINT}`);
    const real = await realpath(next);
    if (!inside(realRoot, real)) throw escapes();
    current = real;
  }
  const target = path.join(current, path.basename(file));
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error(`That save path is a link, which is not allowed. ${DEVICE_SAVE_PATH_HINT}`);
  }
  if (existing && !existing.isFile()) {
    throw new Error(`That save path names a folder or special file. ${DEVICE_SAVE_PATH_HINT}`);
  }
  const confined = path.relative(realRoot, target);
  if (!confined || confined.startsWith("..") || path.isAbsolute(confined)) throw escapes();
  try {
    await saveConfinedWorkspaceFile(identity, confined.split(path.sep).join("/"), Buffer.from(bytes));
  } catch (error) {
    if (error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_destination") {
      throw new Error(
        `That save path changed while the screenshot was being saved, so it was not written. ${DEVICE_SAVE_PATH_HINT}`,
      );
    }
    throw error;
  }
  return target;
}
