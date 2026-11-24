/**
 * Where an app's DESIGN.md lives (spec §6.9, R1) and which app roots a
 * design turn describes (R2).
 *
 * Lookup: an `apps[].designMd` entry for the app root, else the nearest entry
 * named exactly `DESIGN.md` from the app root up to the workspace root, never
 * above it. Names are compared from `readdir`, so `design.md` never matches,
 * even on a case-insensitive disk. Every path is checked before it's used, and
 * a symlink is followed only to a regular file inside the workspace.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../../shared/path-containment.js";
import { detectWebApp, readBounded } from "../app-server/app-detect.js";
import type { WebAppDetection } from "../app-server/app-server-core.js";
import { describedRoots, isSafeWorkspaceRelativePath, type CanvasConfig } from "../canvas-config.js";

export const DESIGN_MD_NAME = "DESIGN.md";
const MAX_RESOLVED_ROOTS = 8;
const PACKAGE_JSON_CAP = 512 * 1024;
const PNPM_WORKSPACE_CAP = 64 * 1024;

export type DesignMdSource = "config" | "app" | "ancestor" | "workspace";
export type LocatedDesignMd =
  | { path: string; source: DesignMdSource }
  | { missing: true; searched: string[] }
  | { invalid: "outside-workspace" | "unsafe-path" };

const abortError = () => new DOMException("The DESIGN.md lookup was cancelled.", "AbortError");

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** POSIX join for checked workspace-relative paths; root `.` adds nothing. */
export function joinRelative(folder: string, name: string): string {
  return folder === "." ? name : `${folder}/${name}`;
}

function parentFolder(folder: string): string {
  const index = folder.lastIndexOf("/");
  return index < 0 ? "." : folder.slice(0, index);
}

/** The app root and each folder above it, up to and including `.`. */
function foldersUp(appRoot: string): string[] {
  const folders = [appRoot];
  let folder = appRoot;
  while (folder !== ".") {
    folder = parentFolder(folder);
    folders.push(folder);
  }
  return folders;
}

type EntryCheck = "file" | "skip" | "outside";

/** A regular file, or a symlink whose real target is a regular file inside the workspace. */
async function checkEntry(realRoot: string, fullPath: string): Promise<EntryCheck> {
  let info;
  try {
    info = await lstat(fullPath);
  } catch {
    return "skip";
  }
  if (info.isFile()) return "file";
  if (!info.isSymbolicLink()) return "skip";
  let target: string;
  try {
    target = await realpath(fullPath);
  } catch {
    return "skip";
  }
  if (!isPathInside(realRoot, target)) return "outside";
  try {
    return (await stat(target)).isFile() ? "file" : "skip";
  } catch {
    return "skip";
  }
}

/** A folder's real path, when it's inside the workspace; `null` when it's missing; `false` when it leads out. */
async function realFolder(realRoot: string, folder: string): Promise<string | null | false> {
  try {
    const real = await realpath(path.join(realRoot, ...folder.split("/")));
    return isPathInside(realRoot, real) ? real : false;
  } catch {
    return null;
  }
}

/** R1: the DESIGN.md for `appRoot`, workspace-relative and POSIX. */
export async function locateDesignMd(
  workspaceRoot: string,
  appRoot: string,
  config: CanvasConfig | null,
  options: { signal?: AbortSignal } = {},
): Promise<LocatedDesignMd> {
  if (!isSafeWorkspaceRelativePath(appRoot)) return { invalid: "unsafe-path" };
  throwIfAborted(options.signal);
  let realRoot: string;
  try {
    realRoot = await realpath(workspaceRoot);
  } catch {
    return { missing: true, searched: [] };
  }

  const override = config?.apps.find((entry) => entry.root === appRoot && entry.designMd)?.designMd;
  if (override !== undefined) {
    if (!isSafeWorkspaceRelativePath(override, { extension: ".md" })) return { invalid: "unsafe-path" };
    const folder = await realFolder(realRoot, parentFolder(override));
    if (folder === false) return { invalid: "outside-workspace" };
    const check = folder === null ? "skip" : await checkEntry(realRoot, path.join(folder, path.posix.basename(override)));
    if (check === "outside") return { invalid: "outside-workspace" };
    return check === "file" ? { path: override, source: "config" } : { missing: true, searched: [override] };
  }

  const searched: string[] = [];
  for (const folder of foldersUp(appRoot)) {
    throwIfAborted(options.signal);
    // Each walked folder is a prefix of a checked root; check it again anyway.
    if (!isSafeWorkspaceRelativePath(folder)) return { invalid: "unsafe-path" };
    searched.push(folder);
    const real = await realFolder(realRoot, folder);
    if (real === false) return { invalid: "outside-workspace" };
    if (real === null) continue;
    let names: string[];
    try {
      names = await readdir(real);
    } catch {
      continue;
    }
    if (!names.includes(DESIGN_MD_NAME)) continue;
    const check = await checkEntry(realRoot, path.join(real, DESIGN_MD_NAME));
    if (check === "outside") return { invalid: "outside-workspace" };
    if (check === "skip") continue;
    const source: DesignMdSource = folder === "." ? "workspace" : folder === appRoot ? "app" : "ancestor";
    return { path: joinRelative(folder, DESIGN_MD_NAME), source };
  }
  return { missing: true, searched };
}

export type DesignAppRoots = (
  workspaceRoot: string,
  options: { signal?: AbortSignal; config: CanvasConfig | null },
) => Promise<{ roots: string[]; more: number }>;

async function manifestKey(workspaceRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const [name, cap] of [
    ["package.json", PACKAGE_JSON_CAP],
    ["pnpm-workspace.yaml", PNPM_WORKSPACE_CAP],
  ] as const) {
    const text = await readBounded(path.join(workspaceRoot, name), cap);
    hash.update(text === null ? "\u0000missing\u0000" : `${text.length}:${text}`);
  }
  return hash.digest("hex");
}

/**
 * R2 with a per-workspace detection cache, keyed on the root `package.json`
 * and `pnpm-workspace.yaml`. Unsafe roots are dropped and counted in `more`,
 * as are roots past the eighth.
 */
export function createDesignAppRoots(
  deps: { detect?: (workspaceRoot: string) => Promise<WebAppDetection> } = {},
): DesignAppRoots {
  const detect = deps.detect ?? ((workspaceRoot: string) => detectWebApp(workspaceRoot));
  const cache = new Map<string, { key: string; detection: WebAppDetection }>();
  return async (workspaceRoot, { signal, config }) => {
    throwIfAborted(signal);
    const root = path.resolve(workspaceRoot);
    const key = await manifestKey(root);
    let detection = cache.get(root)?.key === key ? cache.get(root)!.detection : undefined;
    if (!detection) {
      throwIfAborted(signal);
      detection = await detect(root);
      cache.delete(root);
      cache.set(root, { key, detection });
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
    }
    const all = describedRoots(config, detection);
    const safe = all.filter((candidate) => isSafeWorkspaceRelativePath(candidate));
    const roots = safe.slice(0, MAX_RESOLVED_ROOTS);
    return { roots, more: all.length - roots.length };
  };
}
