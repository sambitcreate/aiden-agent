// The disk side of "which file owns a page" (design mode v2 Phase 3c, S95):
// the owner walk over 3b's confined, no-follow route walker and caps (S78),
// a raw-bytes read that never follows a link, and the confined target a copy
// or a restore may be written to. Nothing here runs code or overwrites a
// file; the rules live in `app-page-files-core.ts` and `app-routes-core.ts`.

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, writeFile } from "node:fs/promises";
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
  mkdir: async (dir) => {
    await mkdir(dir);
  },
  rmdir: (dir) => rmdir(dir),
  writeFile: (file, bytes, mode) => writeFile(file, bytes, { flag: "wx", mode }),
};

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
): Promise<{ ok: true; absolute: string; createdFolder?: string } | { ok: false; reason: "exists" | "outside" | "link" | "io" }> {
  const fs: PageFileFs = { ...DEFAULT_PAGE_FS, ...options.fs };
  const target = await confinedTarget(workspaceReal, workspaceRelPath, { create: options.create, fs });
  if (!target.ok) return target;
  try {
    await fs.writeFile(target.absolute, bytes, mode);
    return target;
  } catch (error) {
    if (target.createdFolder) await fs.rmdir(target.createdFolder).catch(() => undefined);
    return { ok: false, reason: errorCode(error) === "EEXIST" ? "exists" : "io" };
  }
}
