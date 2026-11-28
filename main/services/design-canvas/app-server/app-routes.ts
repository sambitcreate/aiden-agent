// Route discovery's disk walk (design mode v2 Phase 3b, S78). The app root is
// confined to the workspace before any read: every segment of it is `lstat`ed
// and must be a real folder, never a link. Inside, no link is ever followed,
// and every read is confined (`confinedRead`): the two parsed files are read
// through one no-follow handle whose inode must be the one at the file's own
// real path afterwards; folders are listed the same way on Linux
// (`/proc/self/fd`). The one residual is a folder listing on macOS; see
// `confinedRead`. The walk is breadth-first and capped (depth, entries,
// routes); the rules live in `app-routes-core.ts`. Nothing here runs code.

import type { Dirent, Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FrameworkId } from "../../../../renderer/shared/design-app.js";
import { isAppRoot } from "../../../../renderer/shared/design-canvas/app-frame.js";
import { isPathInside } from "../../../shared/path-containment.js";
import {
  conventionsFor,
  parseReactRouterConfig,
  parseTanStackRouteTree,
  ROUTE_LIMITS,
  routeFromFile,
  routesFromFiles,
  type RouteConvention,
} from "./app-routes-core.js";

/** What one open handle read, with that handle's device and inode. */
export type HandleRead<T> = { value: T; dev: number; ino: number };

export type RouteFs = {
  /** A folder listed by path: used where no handle listing exists (macOS), and by tests. */
  readdir(dir: string): Promise<Dirent[]>;
  lstat(target: string): Promise<Stats>;
  realpath(target: string): Promise<string>;
  /** A file's text, at most `cap` bytes, read through one O_NOFOLLOW handle. */
  readFile(file: string, cap: number): Promise<HandleRead<string> | null>;
  /** A folder listed through one O_NOFOLLOW handle; present only where the platform can (Linux). */
  listOpened?(dir: string): Promise<HandleRead<Dirent[]> | null>;
};

/** A regular file's text through one no-follow handle, with the handle's identity; null when it is a link, not a file or over `cap`. */
export async function readRouteFile(file: string, cap: number): Promise<HandleRead<string> | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > cap) return null;
    return { value: buffer.subarray(0, length).toString("utf8"), dev: info.dev, ino: info.ino };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Linux: a folder listed through one no-follow handle. `/proc/self/fd/N`
 * names the open folder itself, so the entries are that inode's whatever the
 * path names meanwhile.
 */
export async function listOpenedDir(dir: string): Promise<HandleRead<Dirent[]> | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isDirectory()) return null;
    const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    return { value: entries, dev: info.dev, ino: info.ino };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const DEFAULT_FS: RouteFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  lstat: (target) => lstat(target),
  realpath: (target) => realpath(target),
  readFile: (file, cap) => readRouteFile(file, cap),
  ...(process.platform === "linux" ? { listOpened: listOpenedDir } : {}),
};

/** The real route fs, with a caller's overrides; a caller's own path listing (a test's spy) replaces the Linux handle listing. */
export function routeFs(overrides: Partial<RouteFs> = {}): RouteFs {
  const fs: RouteFs = { ...DEFAULT_FS, ...overrides };
  if (overrides.readdir && !overrides.listOpened) delete fs.listOpened;
  return fs;
}

const CONVENTION_FOLDERS: Record<RouteConvention, readonly string[]> = {
  "next-app": ["app", "src/app"],
  "next-pages": ["pages", "src/pages"],
  tanstack: ["src/routes"],
  "react-router-flat": ["app/routes"],
  astro: ["src/pages"],
};

type Kind = "dir" | "missing" | "other";

async function kindOf(fs: RouteFs, target: string): Promise<Kind> {
  try {
    const info = await fs.lstat(target);
    return info.isDirectory() && !info.isSymbolicLink() ? "dir" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "other";
  }
}

/** The app root's real folder inside the workspace, or null when it or a parent is a link, not a folder, or outside. */
export async function confinedRoot(fs: RouteFs, workspaceRoot: string, appRoot: string): Promise<string | null> {
  if (!isAppRoot(appRoot)) return null;
  let realWorkspace: string;
  try {
    realWorkspace = await fs.realpath(workspaceRoot);
  } catch {
    return null;
  }
  let current = realWorkspace;
  for (const segment of appRoot === "." ? [] : appRoot.split("/")) {
    current = path.join(current, segment);
    if ((await kindOf(fs, current)) !== "dir") return null;
  }
  try {
    const real = await fs.realpath(current);
    return isPathInside(realWorkspace, real) ? real : null;
  } catch {
    return null;
  }
}

/** A convention folder's path when each of its segments is a real folder; null (skip it) when one is missing, a link or a file. */
async function conventionFolder(fs: RouteFs, root: string, relative: string): Promise<string | null> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if ((await kindOf(fs, current)) !== "dir") return null;
  }
  return current;
}

/**
 * `read`'s value, only while `target` is a real folder or file, no link, at
 * its own real path, and the inode it read is the one there afterwards:
 *
 * - before the read, an `lstat` must show the kind wanted, not a link;
 * - after it, a second `lstat` must show the same device and inode, which
 *   must also be the read's own (a handle's `fstat`), and `realpath` must give
 *   the path back unchanged, so no component above it is a link.
 *
 * A read through a handle is bound to the inode it opened, so a path swapped
 * for a link and put back around the read (renamed aside, linked out, renamed
 * back) is caught: the handle's inode isn't the one at the real path. This
 * holds for the two parsed files everywhere and for folder listings on Linux.
 *
 * The residual: Node can't list a folder through a handle on macOS (no
 * `fdopendir`/`openat`; `/dev/fd/N` refuses a folder), so there the listing
 * is by path and takes its identity from the `lstat` before it. A process
 * that renames a folder aside, links it out and renames it back within one
 * `readdir` would get the outside folder's names listed. Names only: each
 * becomes a route string shown as text; no outside file is read, nothing is
 * written or run, and the app frame still loads the dev server's own URL.
 */
async function confinedRead<T>(
  fs: RouteFs,
  target: string,
  kind: "dir" | "file",
  read: (before: Stats) => Promise<HandleRead<T> | null>,
): Promise<T | null> {
  const isKind = (info: Stats) => (kind === "dir" ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink();
  try {
    const before = await fs.lstat(target);
    if (!isKind(before)) return null;
    const result = await read(before);
    if (!result) return null;
    const after = await fs.lstat(target);
    if (!isKind(after) || after.dev !== before.dev || after.ino !== before.ino) return null;
    if (result.dev !== after.dev || result.ino !== after.ino) return null;
    return (await fs.realpath(target)) === target ? result.value : null;
  } catch {
    return null;
  }
}

async function readRealDir(fs: RouteFs, dir: string): Promise<Dirent[] | null> {
  return confinedRead(fs, dir, "dir", async (before) =>
    fs.listOpened ? fs.listOpened(dir) : { value: await fs.readdir(dir), dev: before.dev, ino: before.ino },
  );
}

export type Budget = { entries: number; truncated: boolean };

function abortError(): Error {
  const error = new Error("The route listing was cancelled.");
  error.name = "AbortError";
  return error;
}

/** Every file under `folder`, as POSIX paths relative to `root`, breadth-first, skipping links, node_modules and hidden folders. */
async function walk(fs: RouteFs, root: string, folder: string, budget: Budget, signal: AbortSignal | undefined): Promise<string[]> {
  const files: string[] = [];
  let level: string[] = [folder];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth >= ROUTE_LIMITS.depth) {
      budget.truncated = true;
      break;
    }
    const next: string[] = [];
    for (const dir of level) {
      if (signal?.aborted) throw abortError();
      const entries = await readRealDir(fs, dir);
      if (!entries) continue;
      for (const entry of entries) {
        if (budget.entries >= ROUTE_LIMITS.entries) {
          budget.truncated = true;
          return files;
        }
        budget.entries += 1;
        if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) next.push(full);
        else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
    level = next;
  }
  return files;
}

/** Every file under a convention's folders, as POSIX paths relative to `root` (the app root), within `budget`. */
export async function conventionFiles(
  fs: RouteFs,
  root: string,
  convention: RouteConvention,
  budget: Budget,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const files: string[] = [];
  for (const relative of CONVENTION_FOLDERS[convention]) {
    const folder = await conventionFolder(fs, root, relative);
    if (folder) files.push(...(await walk(fs, root, folder, budget, signal)));
  }
  return files;
}

async function walkConvention(fs: RouteFs, root: string, convention: RouteConvention, budget: Budget, signal: AbortSignal | undefined): Promise<string[]> {
  return routesFromFiles(convention, await conventionFiles(fs, root, convention, budget, signal));
}

/** A parsed file's text: null when it is missing (`"missing"`), and `"refused"` when it is a link, not a file or too big. */
export async function readParsedFile(fs: RouteFs, root: string, relative: string): Promise<string | "missing" | "refused"> {
  const folder = await conventionFolder(fs, root, path.posix.dirname(relative));
  if (!folder) return "missing";
  const file = path.join(folder, path.posix.basename(relative));
  const kind = await kindOf(fs, file);
  if (kind === "missing") return "missing";
  // Read through one handle, which must be the file at its own real path afterwards.
  const text = await confinedRead(fs, file, "file", () => fs.readFile(file, ROUTE_LIMITS.fileBytes));
  return text ?? "refused";
}

/**
 * The route patterns an app's files declare (S78–S80). Null when the framework
 * has no convention, when the app root or one of its parents is a link or not a
 * folder or lies outside the workspace, or when a React Router `app/routes.ts`
 * can't be read as literal calls: each of those means the `/`-plus-canvas.json
 * fallback. A convention folder that is missing, a link or a file is skipped.
 */
export async function discoverRoutes(
  workspaceRoot: string,
  appRoot: string,
  framework: FrameworkId | undefined,
  options: { signal?: AbortSignal; fs?: Partial<RouteFs> } = {},
): Promise<{ patterns: string[]; truncated: boolean } | null> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  const conventions = conventionsFor(framework);
  if (conventions.length === 0) return null;
  const fs = routeFs(options.fs);
  const root = await confinedRoot(fs, workspaceRoot, appRoot);
  if (!root) return null;
  const budget: Budget = { entries: 0, truncated: false };
  const patterns: string[] = [];
  for (const convention of conventions) {
    if (signal?.aborted) throw abortError();
    if (convention === "tanstack") {
      const tree = await readParsedFile(fs, root, "src/routeTree.gen.ts");
      const parsed = tree === "missing" || tree === "refused" ? null : parseTanStackRouteTree(tree);
      patterns.push(...(parsed ?? (await walkConvention(fs, root, convention, budget, signal))));
      continue;
    }
    if (convention === "react-router-flat" && framework === "react-router") {
      const config = await readParsedFile(fs, root, "app/routes.ts");
      if (config === "refused") return null;
      if (config !== "missing") {
        const parsed = parseReactRouterConfig(config);
        if (!parsed) return null;
        if ("routes" in parsed) {
          patterns.push(...parsed.routes);
          continue;
        }
      }
    }
    patterns.push(...(await walkConvention(fs, root, convention, budget, signal)));
  }
  const unique = [...new Set(patterns)];
  if (unique.length > ROUTE_LIMITS.routes) budget.truncated = true;
  return { patterns: unique.slice(0, ROUTE_LIMITS.routes), truncated: budget.truncated };
}

/** The pattern a written workspace file maps to under `appRoot`, by its path alone (S83); no disk read. */
export function routeForWrittenFile(appRoot: string, framework: FrameworkId | undefined, workspaceRelPath: string): string | null {
  let relative: string;
  if (appRoot === ".") relative = workspaceRelPath;
  else if (workspaceRelPath.startsWith(`${appRoot}/`)) relative = workspaceRelPath.slice(appRoot.length + 1);
  else return null;
  for (const convention of conventionsFor(framework)) {
    const route = routeFromFile(convention, relative);
    if (route !== null) return route;
  }
  return null;
}
