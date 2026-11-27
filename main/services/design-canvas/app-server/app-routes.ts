// Route discovery's disk walk (design mode v2 Phase 3b, S78). The app root is
// confined to the workspace before any read: every segment of it is `lstat`ed
// and must be a real folder, never a link. Inside, no link is ever followed —
// not a folder, not a file, not the two parsed files, which `readBounded`
// opens with O_NOFOLLOW, and each folder is read only while it is still a real
// folder at its own real path (`readRealDir`). The walk is breadth-first and capped (depth, entries,
// routes); the rules live in `app-routes-core.ts`. Nothing here runs code.

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FrameworkId } from "../../../../renderer/shared/design-app.js";
import { isAppRoot } from "../../../../renderer/shared/design-canvas/app-frame.js";
import { isPathInside } from "../../../shared/path-containment.js";
import { readBounded } from "./app-detect.js";
import {
  conventionsFor,
  parseReactRouterConfig,
  parseTanStackRouteTree,
  ROUTE_LIMITS,
  routeFromFile,
  routesFromFiles,
  type RouteConvention,
} from "./app-routes-core.js";

export type RouteFs = {
  readdir(dir: string): Promise<Dirent[]>;
  lstat(target: string): Promise<Stats>;
  realpath(target: string): Promise<string>;
  readBounded(file: string, cap: number): Promise<string | null>;
};

const DEFAULT_FS: RouteFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  lstat: (target) => lstat(target),
  realpath: (target) => realpath(target),
  readBounded: (file, cap) => readBounded(file, cap),
};

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
async function confinedRoot(fs: RouteFs, workspaceRoot: string, appRoot: string): Promise<string | null> {
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
 * A folder's entries, only while it is the real folder it was when queued or
 * checked. Node can't list a folder through a no-follow handle, so the read is
 * fenced instead: right before it, an `lstat` must show a folder, not a link;
 * right after it, a second `lstat` must show the same folder (device and
 * inode) and its real path must be the path itself, so no link sits anywhere
 * above it under `root`. A folder swapped for a link at any point is skipped.
 */
async function readRealDir(fs: RouteFs, dir: string): Promise<Dirent[] | null> {
  return inRealDir(fs, dir, () => fs.readdir(dir));
}

/** `read`'s answer, only while `dir` stayed the same real folder at its own real path around it; null otherwise. */
async function inRealDir<T>(fs: RouteFs, dir: string, read: () => Promise<T>): Promise<T | null> {
  try {
    const before = await fs.lstat(dir);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const value = await read();
    const after = await fs.lstat(dir);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) return null;
    return (await fs.realpath(dir)) === dir ? value : null;
  } catch {
    return null;
  }
}

type Budget = { entries: number; truncated: boolean };

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

async function walkConvention(fs: RouteFs, root: string, convention: RouteConvention, budget: Budget, signal: AbortSignal | undefined): Promise<string[]> {
  const files: string[] = [];
  for (const relative of CONVENTION_FOLDERS[convention]) {
    const folder = await conventionFolder(fs, root, relative);
    if (folder) files.push(...(await walk(fs, root, folder, budget, signal)));
  }
  return routesFromFiles(convention, files);
}

/** A parsed file's text: null when it is missing (`"missing"`), and `"refused"` when it is a link, not a file or too big. */
async function readParsedFile(fs: RouteFs, root: string, relative: string): Promise<string | "missing" | "refused"> {
  const folder = await conventionFolder(fs, root, path.posix.dirname(relative));
  if (!folder) return "missing";
  const file = path.join(folder, path.posix.basename(relative));
  const kind = await kindOf(fs, file);
  if (kind === "missing") return "missing";
  // O_NOFOLLOW guards the file; the fence guards the folders above it.
  const text = await inRealDir(fs, folder, () => fs.readBounded(file, ROUTE_LIMITS.fileBytes));
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
  const fs: RouteFs = { ...DEFAULT_FS, ...options.fs };
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
