// The disk side of "which file owns a page" (design mode v2 Phase 3c, S95):
// the owner walk over 3b's confined, no-follow route walker and caps (S78),
// a raw-bytes read that never follows a link, and the confined target a copy
// or a restore may be written to. Nothing here runs code or overwrites a
// file; the rules live in `app-page-files-core.ts` and `app-routes-core.ts`.

import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FrameworkId } from "../../../../renderer/shared/design-app.js";
import { isPathInside } from "../../../shared/path-containment.js";
import type { OwnerFile } from "./app-page-files-core.js";
import { conventionsFor, parseReactRouterConfig, routeFileEntries } from "./app-routes-core.js";
import { confinedRoot, conventionFiles, readParsedFile, type Budget, type RouteFs } from "./app-routes.js";

export type RouteFileWalk = {
  /** Each page pattern to the files that serve it; layouts are never here. */
  files: Map<string, OwnerFile[]>;
  /** Patterns of flat files that are their children's layout (TanStack `blog.tsx` beside `blog.$slug.tsx`). */
  layouts: Set<string>;
  /** The names of the walked files in a file's own folder (from this walk, no further read). */
  siblings: (appRelPath: string) => Promise<string[]>;
  /** The walk hit a cap, so ownership can't be proven. */
  truncated: boolean;
  /** React Router with a literal or unreadable `app/routes.ts`, or a framework with no file convention. */
  configRouter: boolean;
};

/**
 * Every page file of an app by pattern (S95's owner walk). Null when the app
 * root, or a folder above it, is a link, not a folder, or outside the
 * workspace. React Router mirrors `discoverRoutes`: with an `app/routes.ts`,
 * flat files are walked only when it reads as `flatRoutes()`.
 */
export async function routeFiles(
  fs: RouteFs,
  workspaceRoot: string,
  appRoot: string,
  framework: FrameworkId | undefined,
): Promise<RouteFileWalk | null> {
  const walked: string[] = [];
  const budget: Budget = { entries: 0, truncated: false };
  const result = (configRouter: boolean, files = new Map<string, OwnerFile[]>(), layouts = new Set<string>()): RouteFileWalk => ({
    files,
    layouts,
    siblings: async (appRelPath) => {
      const folder = path.posix.dirname(appRelPath);
      return walked.filter((file) => path.posix.dirname(file) === folder).map((file) => path.posix.basename(file));
    },
    truncated: budget.truncated,
    configRouter,
  });
  const conventions = conventionsFor(framework);
  if (conventions.length === 0) return result(true);
  const root = await confinedRoot(fs, workspaceRoot, appRoot);
  if (!root) return null;
  const files = new Map<string, OwnerFile[]>();
  const layouts = new Set<string>();
  for (const convention of conventions) {
    if (convention === "react-router-flat" && framework === "react-router") {
      const config = await readParsedFile(fs, root, "app/routes.ts");
      if (config === "refused") return result(true);
      if (config !== "missing") {
        const parsed = parseReactRouterConfig(config);
        // Only flat routes alone map a file to its route; under a prefix or beside other calls, it's the config's.
        if (!parsed || "routes" in parsed || parsed.mixed) return result(true);
      }
    }
    const relPaths = await conventionFiles(fs, root, convention, budget, undefined);
    walked.push(...relPaths);
    for (const entry of routeFileEntries(convention, relPaths)) {
      if (entry.layout) {
        layouts.add(entry.route);
        continue;
      }
      const owners = files.get(entry.route) ?? [];
      owners.push({ appRelPath: entry.relPath, convention });
      files.set(entry.route, owners);
    }
  }
  return result(false, files, layouts);
}

/**
 * A regular file's exact bytes and permission bits, through one
 * `O_NOFOLLOW | O_NONBLOCK` handle. Like 3b's parsed-file read, the inode it
 * read must be the one at `file` afterwards, and `file` must be its own real
 * path, so a link anywhere on it gives `not-regular`. Pass a real, absolute
 * path (as `confinedTarget` gives).
 */
export async function readRegularFileBytes(
  file: string,
  cap: number,
): Promise<{ ok: true; bytes: Buffer; mode: number } | { ok: false; reason: "too-large" | "not-regular" | "missing" | "io" }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    if (code === "ELOOP" || code === "EMLINK" || code === "ENXIO" || code === "EOPNOTSUPP") return { ok: false, reason: "not-regular" };
    return { ok: false, reason: "io" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-regular" };
    if (info.size > cap) return { ok: false, reason: "too-large" };
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > cap) return { ok: false, reason: "too-large" };
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) return { ok: false, reason: "not-regular" };
    if ((await realpath(file)) !== path.resolve(file)) return { ok: false, reason: "not-regular" };
    return { ok: true, bytes: Buffer.from(buffer.subarray(0, length)), mode: info.mode & 0o777 };
  } catch {
    return { ok: false, reason: "io" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** What `confinedTarget` and `writeConfinedFile` touch; tests inject parts (a case-insensitive volume's EEXIST). */
export type PageFileFs = {
  lstat(target: string): Promise<Stats>;
  realpath(target: string): Promise<string>;
  /** One folder, never recursive. */
  mkdir(dir: string): Promise<void>;
  /** Removes an empty folder only. */
  rmdir(dir: string): Promise<void>;
  /** Creates `file` with `wx`: never over anything already at the path, a link included. */
  writeFile(file: string, bytes: Buffer, mode: number): Promise<FileIdentity | void>;
};

const DEFAULT_PAGE_FS: PageFileFs = {
  lstat: (target) => lstat(target),
  realpath: (target) => realpath(target),
  mkdir: (dir) => makePageFolder(dir),
  rmdir: (dir) => rmdir(dir),
  writeFile: (file, bytes, mode) => createPageFile(file, bytes, mode),
};

/** Thrown when what was made would not be where its confined path says: a folder above it was swapped meanwhile. */
const MOVED = "EAIDENMOVED";
const moved = () => Object.assign(new Error("The folder moved while the file was made."), { code: MOVED });

/** Linux names an open folder itself through `/proc/self/fd`, so a name inside it is looked up in that inode, whatever the path says. */
const BY_HANDLE = process.platform === "linux";

/** A folder opened without following a link, while it is the folder at its own real path. */
async function openHeldFolder(dir: string): Promise<FileHandle> {
  const handle = await open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    if (!(await stillAt(handle, dir))) throw moved();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Whether `dir` is still the open folder: the same inode, at its own real path. */
async function stillAt(handle: FileHandle, dir: string): Promise<boolean> {
  try {
    const [held, now, real] = await Promise.all([handle.stat(), lstat(dir), realpath(dir)]);
    return real === dir && now.isDirectory() && held.dev === now.dev && held.ino === now.ino;
  } catch {
    return false;
  }
}

/** Whether `name` in the held folder is the inode `info` (looked up through the handle on Linux). */
async function holds(folder: FileHandle, file: string, info: Stats): Promise<boolean> {
  try {
    const entry = await lstat(BY_HANDLE ? `/proc/self/fd/${folder.fd}/${path.basename(file)}` : file);
    return entry.dev === info.dev && entry.ino === info.ino;
  } catch {
    return false;
  }
}

/**
 * One new folder, made in its parent's verified handle on Linux. On macOS it
 * is made by path; `confinedTarget`'s real-path check after it refuses a
 * folder an ancestor swap sent elsewhere, but the empty folder stays there
 * (no handle-relative mkdir in Node).
 */
async function makePageFolder(dir: string): Promise<void> {
  if (!BY_HANDLE) {
    await mkdir(dir);
    return;
  }
  const parent = await openHeldFolder(path.dirname(dir));
  try {
    await mkdir(`/proc/self/fd/${parent.fd}/${path.basename(dir)}`);
  } finally {
    await parent.close().catch(() => undefined);
  }
}

/** A file's identity on disk: what a rollback checks before it takes back a file this process made. */
export type FileIdentity = { dev: number; ino: number };

/**
 * macOS's `O_NOFOLLOW_ANY` (`sys/fcntl.h`, macOS 11 and later): the open fails
 * with ELOOP when any part of the path is a link, not only the last. Node has
 * no name for it, and it can't be combined with `O_NOFOLLOW`.
 */
const O_NOFOLLOW_ANY = 0x20000000;

/** What a test does to the path just before and just after the file is made, as a racing process would. */
export type CreateRace = { beforeCreate?: () => Promise<void>; afterCreate?: () => Promise<void> };

/**
 * Creates `file` empty with `O_EXCL`, then writes `bytes` through its own
 * handle, only where the confined path names (S95; Pullfrog r4724521914 and
 * r4724600691). Answers the new file's identity.
 *
 * - Linux: the folder is held open no-follow while it is the inode at its own
 *   real path, and the file is made through `/proc/self/fd/N/name`, so it
 *   lands in that folder whatever the path names meanwhile. If the folder was
 *   moved away by then, the file is taken back through the same handle before
 *   a byte is written: renamed aside to a random name and unlinked only once
 *   proved to be this inode (`takeBackFrom`), never by a check then an unlink.
 * - macOS: one `open` with `O_NOFOLLOW_ANY`, which refuses a link anywhere on
 *   the path, so the file is made at the literal confined path under real
 *   folders. A swap to a link at any moment answers `link` and makes nothing.
 *   A racer renaming real folders can only move what is already inside the
 *   workspace, which it could do anyway.
 * - Elsewhere: by path, with the folder and file identity checked after the
 *   create; a swap exactly across the create can leave one empty file where
 *   the link pointed. Neither desktop platform takes this path.
 *
 * A write that fails after the create takes the file back the same way on
 * Linux (or empties it through its own handle when the rename can't be made);
 * on macOS it is emptied through its handle and left (there is no handle-bound
 * unlink there), and the caller reports `io`.
 */
export async function createPageFile(file: string, bytes: Buffer, mode: number, race?: CreateRace): Promise<FileIdentity> {
  const create = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  if (process.platform === "darwin") {
    await race?.beforeCreate?.();
    let created: FileHandle;
    try {
      created = await open(file, create | O_NOFOLLOW_ANY, mode);
    } catch (error) {
      throw errorCode(error) === "ELOOP" ? moved() : error;
    }
    try {
      await race?.afterCreate?.();
      const info = await created.stat();
      try {
        await created.writeFile(bytes);
      } catch (error) {
        await created.truncate(0).catch(() => undefined);
        throw error;
      }
      return { dev: info.dev, ino: info.ino };
    } finally {
      await created.close().catch(() => undefined);
    }
  }
  const folder = await openHeldFolder(path.dirname(file));
  let created: FileHandle | undefined;
  const at = BY_HANDLE ? `/proc/self/fd/${folder.fd}/${path.basename(file)}` : file;
  try {
    await race?.beforeCreate?.();
    created = await open(at, create | fsConstants.O_NOFOLLOW, mode);
    await race?.afterCreate?.();
    const info = await created.stat();
    // Taken back only through the folder's handle, and only once proved to be this inode (never by path).
    const takeBack = async () => {
      if (!BY_HANDLE || !created) return;
      const own = created;
      const result = await takeBackFrom(folder, path.basename(file), (entry) => isInode(entry, info)).catch(() => "unrenamed" as const);
      if (result === "unrenamed") await own.truncate(0).catch(() => undefined);
    };
    if (!(await holds(folder, file, info)) || !(await stillAt(folder, path.dirname(file)))) {
      await takeBack();
      throw moved();
    }
    try {
      await created.writeFile(bytes);
    } catch (error) {
      await takeBack();
      throw error;
    }
    return { dev: info.dev, ino: info.ino };
  } finally {
    await created?.close().catch(() => undefined);
    await folder.close().catch(() => undefined);
  }
}

/** What `removeCreatedFile` did: `aside` names where a file that wasn't Aiden's was left when its name was taken again meanwhile. */
export type RemoveCreatedResult = "removed" | "missing" | "changed" | "emptied" | "unbound" | { aside: string };

/** Whether the entry at `at` is the file `created` names, holding exactly `bytes` (read through a no-follow handle). */
async function isOwnCopy(at: string, created: FileIdentity, bytes: Buffer): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(at, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== created.dev || info.ino !== created.ino || info.nlink !== 1 || info.size !== bytes.length) return false;
    return (await handle.readFile()).equals(bytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Takes back a file this process made with `createPageFile` (a rollback;
 * Pullfrog r4724860830), never deleting a file it hasn't proved is that one.
 * On Linux, through its folder's verified handle:
 *
 * 1. The name is renamed, in that folder, to a random name only Aiden knows.
 *    Rename is atomic, so whatever held the name is now there, and no other
 *    process will put anything at that name.
 * 2. Only if it is the inode the create made, with one link and exactly
 *    `bytes`, is it unlinked.
 * 3. Anything else goes back with `link` then `unlink`, which never replaces a
 *    file that took the name meanwhile. If the name was taken, or `link`
 *    can't be made (a folder), it stays at the random name: `{ aside }`.
 *
 * When the rename itself fails, the file is emptied through a handle opened
 * no-follow and proved to be that inode, rather than unlinked: `emptied`.
 * Elsewhere `unbound`: only a path-based removal exists, so the caller moves
 * the file to the Trash instead (recoverable, unlike an unlink sent elsewhere).
 */
export async function removeCreatedFile(file: string, created: FileIdentity, bytes: Buffer, race?: TakeBackRace): Promise<RemoveCreatedResult> {
  if (!BY_HANDLE) return "unbound";
  const folder = await openHeldFolder(path.dirname(file));
  try {
    const result = await takeBackFrom(folder, path.basename(file), (entry) => isOwnCopy(entry, created, bytes), race);
    return result === "unrenamed" ? await emptyOwnCopy(`/proc/self/fd/${folder.fd}/${path.basename(file)}`, created) : result;
  } finally {
    await folder.close().catch(() => undefined);
  }
}

/** What a test does to the name just before and just after the take-back renames it aside, as another process would. */
export type TakeBackRace = { beforeTake?: () => Promise<void>; afterTake?: () => Promise<void> };

/**
 * Linux only, through `folder`'s handle: renames `name` to a random name in
 * the same folder (atomic: whatever held the name is now there), unlinks it
 * only when `own` proves it, and otherwise links it back without replacing a
 * file that took the name meanwhile (`{ aside }` when it can't). `unrenamed`
 * when the rename itself fails; `missing` when nothing held the name.
 */
async function takeBackFrom(
  folder: FileHandle,
  name: string,
  own: (entry: string) => Promise<boolean>,
  race?: TakeBackRace,
): Promise<"removed" | "missing" | "changed" | "unrenamed" | { aside: string }> {
  const at = `/proc/self/fd/${folder.fd}/${name}`;
  const asideName = `.aiden-rollback-${randomBytes(16).toString("hex")}`;
  const aside = `/proc/self/fd/${folder.fd}/${asideName}`;
  await race?.beforeTake?.();
  try {
    await rename(at, aside);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unrenamed";
  }
  await race?.afterTake?.();
  if (await own(aside)) {
    await unlink(aside);
    return "removed";
  }
  try {
    await link(aside, at);
  } catch {
    return { aside: asideName };
  }
  await unlink(aside).catch(() => undefined);
  return "changed";
}

/** Whether the entry at `entry` is the inode `info` names, with no other link to it. */
async function isInode(entry: string, info: FileIdentity): Promise<boolean> {
  try {
    const now = await lstat(entry);
    return now.isFile() && now.dev === info.dev && now.ino === info.ino && now.nlink === 1;
  } catch {
    return false;
  }
}

/** Empties the file at `at` only through a handle proved to be `created`: what's left is an empty copy, never someone's file gone. */
async function emptyOwnCopy(at: string, created: FileIdentity): Promise<"emptied" | "changed"> {
  let handle: FileHandle;
  try {
    handle = await open(at, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return "changed";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== created.dev || info.ino !== created.ino) return "changed";
    await handle.truncate(0);
    return "emptied";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type TargetRefusal = { ok: false; reason: "outside" | "link" | "io" | "exists" };

/** Whether `real` is `parent` with only its last name in another case. */
function caseOnlyRename(parent: string, real: string): boolean {
  const name = path.basename(parent);
  const realName = path.basename(real);
  return path.dirname(real) === path.dirname(parent) && realName !== name && realName.toLowerCase() === name.toLowerCase();
}

function isWorkspaceRelPath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * Where a workspace-relative file may be read, trashed or written, without
 * following a link (S95). Every folder from `workspaceReal` down is `lstat`ed
 * and must be a real folder; the file itself must not be a link; and the
 * parent's real path must be its own path, inside the workspace. With
 * `create`, a missing parent (only the last folder) is made with one
 * non-recursive `mkdir`, and removed again if a later check refuses. That
 * last folder already taken, by a file or by a folder in another case on a
 * case-insensitive volume, is `exists`, as a taken file name is.
 *
 * `absolute` is `path.resolve(workspaceReal, workspaceRelPath)`, the key
 * callers lock with `withFileLock`.
 */
export async function confinedTarget(
  workspaceReal: string,
  workspaceRelPath: string,
  options: { create: boolean; fs?: Partial<PageFileFs> },
): Promise<{ ok: true; absolute: string; createdFolder?: string } | TargetRefusal> {
  const fs: PageFileFs = { ...DEFAULT_PAGE_FS, ...options.fs };
  if (!isWorkspaceRelPath(workspaceRelPath) || !path.isAbsolute(workspaceReal)) return { ok: false, reason: "outside" };
  try {
    if ((await fs.realpath(workspaceReal)) !== workspaceReal) return { ok: false, reason: "link" };
  } catch {
    return { ok: false, reason: "io" };
  }
  const folders = workspaceRelPath.split("/").slice(0, -1);
  let current = workspaceReal;
  let createdFolder: string | undefined;
  const refuse = async (reason: TargetRefusal["reason"]): Promise<TargetRefusal> => {
    if (createdFolder) await fs.rmdir(createdFolder).catch(() => undefined);
    return { ok: false, reason };
  };
  for (let index = 0; index < folders.length; index += 1) {
    current = path.join(current, folders[index]);
    let info: Stats;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || !options.create || index !== folders.length - 1) return { ok: false, reason: "io" };
      try {
        await fs.mkdir(current);
        createdFolder = current;
        continue;
      } catch (made) {
        if (errorCode(made) !== "EEXIST") return { ok: false, reason: "io" };
        try {
          info = await fs.lstat(current);
        } catch {
          return { ok: false, reason: "io" };
        }
      }
    }
    if (info.isSymbolicLink()) return refuse("link");
    // A new page's own folder already there as a file is a taken name, like the file itself would be.
    if (!info.isDirectory()) return refuse(options.create && index === folders.length - 1 ? "exists" : "io");
  }
  const absolute = path.resolve(workspaceReal, workspaceRelPath);
  try {
    if ((await fs.lstat(absolute)).isSymbolicLink()) return refuse("link");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return refuse("io");
  }
  const parent = path.dirname(absolute);
  try {
    const real = await fs.realpath(parent);
    // A case-insensitive volume finds `pricing-v2` as another page's `Pricing-v2`: a taken name, not a link.
    if (options.create && !createdFolder && folders.length > 0 && caseOnlyRename(parent, real)) return refuse("exists");
    if (real !== parent || !isPathInside(workspaceReal, real)) return refuse("link");
  } catch {
    return refuse("io");
  }
  return createdFolder ? { ok: true, absolute, createdFolder } : { ok: true, absolute };
}

/**
 * Writes a new file through `confinedTarget` with `wx`: `exists` when anything
 * is already at the path (a case-insensitive clash included), and a folder it
 * created is removed again when the write fails. The caller holds
 * `withFileLock(absolute)`.
 */
export async function writeConfinedFile(
  workspaceReal: string,
  workspaceRelPath: string,
  bytes: Buffer,
  mode: number,
  options: { create: boolean; fs?: Partial<PageFileFs> },
): Promise<{ ok: true; absolute: string; createdFolder?: string; created?: FileIdentity } | { ok: false; reason: "exists" | "outside" | "link" | "io" }> {
  const fs: PageFileFs = { ...DEFAULT_PAGE_FS, ...options.fs };
  const target = await confinedTarget(workspaceReal, workspaceRelPath, { create: options.create, fs });
  if (!target.ok) return target;
  try {
    const created = await fs.writeFile(target.absolute, bytes, mode);
    return created ? { ...target, created } : target;
  } catch (error) {
    if (target.createdFolder) await fs.rmdir(target.createdFolder).catch(() => undefined);
    const code = errorCode(error);
    return { ok: false, reason: code === "EEXIST" ? "exists" : code === MOVED ? "link" : "io" };
  }
}
