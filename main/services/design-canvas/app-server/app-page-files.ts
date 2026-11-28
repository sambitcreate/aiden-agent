// The disk side of "which file owns a page" (design mode v2 Phase 3c, S95):
// the owner walk over 3b's confined, no-follow route walker and caps (S78),
// a raw-bytes read that never follows a link, and the confined target a copy
// or a restore may be written to. Nothing here runs code or overwrites a
// file; the rules live in `app-page-files-core.ts` and `app-routes-core.ts`.

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, type FileHandle } from "node:fs/promises";
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
  writeFile(file: string, bytes: Buffer, mode: number): Promise<void>;
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

/**
 * macOS's `O_NOFOLLOW_ANY` (`sys/fcntl.h`, macOS 11 and later): the open fails
 * with ELOOP when any part of the path is a link, not only the last. Node has
 * no name for it, and it can't be combined with `O_NOFOLLOW`.
 */
const O_NOFOLLOW_ANY = 0x20000000;

/** What a test does to the path just before and just after the file is made, as a racing process would. */
export type CreateRace = { beforeCreate?: () => Promise<void>; afterCreate?: () => Promise<void> };

/** Marks an error after which the file this call made was emptied through its own handle and left where it was made. */
const leftEmpty = (error: unknown): unknown => {
  if (typeof error === "object" && error !== null) Object.assign(error, { aidenLeftEmpty: true });
  return error;
};

/**
 * Creates `file` empty with `O_EXCL`, then writes `bytes` through its own
 * handle, only where the confined path names (S95; Pullfrog r4724521914 and
 * r4724600691).
 *
 * - Linux: the folder is held open no-follow while it is the inode at its own
 *   real path, and the file is made through `/proc/self/fd/N/name`, so it
 *   lands in that folder whatever the path names meanwhile, and no byte is
 *   written unless that folder is still at its path.
 * - macOS: one `open` with `O_NOFOLLOW_ANY`, which refuses a link anywhere on
 *   the path, so the file is made at the literal confined path under real
 *   folders. A swap to a link at any moment answers `link` and makes nothing.
 *   A racer renaming real folders can only move what is already inside the
 *   workspace, which it could do anyway.
 * - Elsewhere: by path, with the folder and file identity checked after the
 *   create. Neither desktop platform takes this path.
 *
 * Nothing is ever removed (Pullfrog r4724929189): POSIX has no unlink bound
 * to an inode, so any check before an unlink can be raced into deleting
 * someone else's file. When the folder moved or the write fails after the
 * create, the file is emptied through its own handle (bound to the inode
 * this call made) and left where it was made; the error carries
 * `aidenLeftEmpty`, and the caller reports it.
 */
export async function createPageFile(file: string, bytes: Buffer, mode: number, race?: CreateRace): Promise<void> {
  const create = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const folder = process.platform === "darwin" ? undefined : await openHeldFolder(path.dirname(file));
  const at = folder && BY_HANDLE ? `/proc/self/fd/${folder.fd}/${path.basename(file)}` : file;
  let created: FileHandle | undefined;
  try {
    await race?.beforeCreate?.();
    try {
      created = await open(at, folder ? create | fsConstants.O_NOFOLLOW : create | O_NOFOLLOW_ANY, mode);
    } catch (error) {
      throw !folder && errorCode(error) === "ELOOP" ? moved() : error;
    }
    const handle = created;
    await race?.afterCreate?.();
    if (folder) {
      const info = await handle.stat();
      if (!(await holds(folder, file, info)) || !(await stillAt(folder, path.dirname(file)))) throw leftEmpty(moved());
    }
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.truncate(0).catch(() => undefined);
      throw leftEmpty(error);
    }
  } finally {
    await created?.close().catch(() => undefined);
    await folder?.close().catch(() => undefined);
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
 * non-recursive `mkdir`, and left in place if a later check refuses: Aiden
 * removes nothing on cleanup (Pullfrog r4724929189). That
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
  const refuse = async (reason: TargetRefusal["reason"]): Promise<TargetRefusal> => ({ ok: false, reason });
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
 * is already at the path (a case-insensitive clash included). Nothing is
 * removed when the write fails: a folder it made stays, and `empty` names the
 * workspace-relative file left empty where it was made, if one was. The caller
 * holds `withFileLock(absolute)`.
 */
export async function writeConfinedFile(
  workspaceReal: string,
  workspaceRelPath: string,
  bytes: Buffer,
  mode: number,
  options: { create: boolean; fs?: Partial<PageFileFs> },
): Promise<{ ok: true; absolute: string; createdFolder?: string } | { ok: false; reason: "exists" | "outside" | "link" | "io"; empty?: string }> {
  const fs: PageFileFs = { ...DEFAULT_PAGE_FS, ...options.fs };
  const target = await confinedTarget(workspaceReal, workspaceRelPath, { create: options.create, fs });
  if (!target.ok) return target;
  try {
    await fs.writeFile(target.absolute, bytes, mode);
    return target;
  } catch (error) {
    const code = errorCode(error);
    const reason = code === "EEXIST" ? "exists" : code === MOVED ? "link" : "io";
    return (error as { aidenLeftEmpty?: boolean })?.aidenLeftEmpty ? { ok: false, reason, empty: workspaceRelPath } : { ok: false, reason };
  }
}
