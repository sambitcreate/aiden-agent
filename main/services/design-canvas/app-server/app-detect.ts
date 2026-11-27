/**
 * Finds a workspace's web app candidates on disk (spec §6.2.1, plan R1–R7)
 * and hands what it reads to the pure rules in `app-server-core.ts`.
 *
 * Every read is bounded and never follows a symlink: files open with
 * `O_NOFOLLOW | O_NONBLOCK` and must be regular files under a size cap;
 * folders are checked with `lstat`, so a symlinked `packages/` pointing at
 * `/` is never listed. Nothing here throws for a bad file: a bad candidate
 * gets a reason. Paths in the result are POSIX and relative to the root.
 */
import { constants as fsConstants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DENO_MARKERS,
  INSTALL_MARKERS,
  LOCKFILES,
  classifyPackage,
  decidePackageManager,
  installedMarkerManagers,
  lockfileManagers,
  matchesWorkspacePattern,
  parsePackageJson,
  parsePackageManagerField,
  parseWorkspacePattern,
  safeScriptNames,
  workspacePatterns,
  type DetectedApp,
  type PackageClassification,
  type PackageJson,
  type PackageManagerSignals,
  type WebAppDetection,
} from "./app-server-core.js";

const PACKAGE_JSON_CAP = 512 * 1024;
const PNPM_WORKSPACE_CAP = 64 * 1024;
const YARN_LOCK_HEAD = 512;
const MAX_FOLDER_ENTRIES = 200;
const MAX_CANDIDATES = 100;
const MAX_WALK_LEVELS = 5;
const MAX_NAME = 214;
const FIXED_CONTAINERS = ["apps", "packages"];
const FIXED_FOLDERS = ["web", "frontend", "site"];
const RUNNER_FILES = ["nx.json", "turbo.json", "lerna.json"];

/**
 * A regular file's text, or null when it is missing, not a regular file
 * (symlink, FIFO, socket, device, folder) or longer than `cap` bytes. With
 * `head`, a longer file gives its first `cap` bytes instead.
 */
export async function readBounded(filePath: string, cap: number, options: { head?: boolean } = {}): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > cap) {
      if (!options.head) return null;
      length = cap;
    }
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function lstatKind(filePath: string): Promise<"dir" | "other" | null> {
  try {
    const info = await lstat(filePath);
    return info.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  return (await lstatKind(filePath)) !== null;
}

/** `stat` follows links: a symlinked `node_modules` counts, a dangling one doesn't. */
async function isFolderFollowingLinks(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function isScannableName(name: string): boolean {
  return name !== "node_modules" && !name.startsWith(".") && name.length > 0;
}

/** Real (non-symlink) subfolders, sorted by name, at most 200. */
async function listFolders(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isScannableName(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_FOLDER_ENTRIES);
}

/** Every segment is a real folder, never a symlink, dot folder or node_modules. */
async function isRealFolderPath(root: string, segments: readonly string[]): Promise<boolean> {
  let current = root;
  for (const segment of segments) {
    if (!isScannableName(segment)) return false;
    current = path.join(current, segment);
    if ((await lstatKind(current)) !== "dir") return false;
  }
  return true;
}

function toAbsolute(root: string, rel: string): string {
  return rel === "." ? root : path.join(root, ...rel.split("/"));
}

interface FolderSignals {
  pkgPresent: boolean;
  lockfiles: string[];
  pnpmWorkspaceFile: boolean;
  denoMarker: boolean;
  yarnrc: boolean;
  pnp: boolean;
  runnerFile: boolean;
  git: boolean;
  lockHead: string | null;
  markers: string[];
  nodeModules: boolean;
}

async function folderSignals(dir: string, options: { deno: boolean }): Promise<FolderSignals> {
  const names = [
    "package.json",
    ...LOCKFILES.map(([file]) => file),
    "pnpm-workspace.yaml",
    ".yarnrc.yml",
    ".pnp.cjs",
    ".git",
    ...RUNNER_FILES,
    ...(options.deno ? DENO_MARKERS : []),
  ];
  const present = new Set<string>();
  await Promise.all(names.map(async (name) => ((await exists(path.join(dir, name))) ? present.add(name) : undefined)));
  const markers: string[] = [];
  await Promise.all(
    INSTALL_MARKERS.map(async ([file]) => ((await exists(path.join(dir, "node_modules", file))) ? markers.push(file) : undefined)),
  );
  return {
    pkgPresent: present.has("package.json"),
    lockfiles: LOCKFILES.map(([file]) => file).filter((file) => present.has(file)),
    pnpmWorkspaceFile: present.has("pnpm-workspace.yaml"),
    denoMarker: DENO_MARKERS.some((file) => present.has(file)),
    yarnrc: present.has(".yarnrc.yml"),
    pnp: present.has(".pnp.cjs"),
    runnerFile: RUNNER_FILES.some((file) => present.has(file)),
    git: present.has(".git"),
    lockHead: present.has("yarn.lock") ? await readBounded(path.join(dir, "yarn.lock"), YARN_LOCK_HEAD, { head: true }) : null,
    markers,
    nodeModules: await isFolderFollowingLinks(path.join(dir, "node_modules")),
  };
}

function hasOwnSignal(signals: FolderSignals): boolean {
  return signals.lockfiles.length > 0 || signals.pnpmWorkspaceFile;
}

function managerSignals(signals: FolderSignals, field: unknown, levelsUp: number): PackageManagerSignals {
  return {
    field: parsePackageManagerField(field),
    lockfiles: lockfileManagers(signals.lockfiles),
    installedMarkers: installedMarkerManagers(signals.markers),
    pnpmWorkspaceFile: signals.pnpmWorkspaceFile,
    denoMarker: signals.denoMarker,
    yarnFlavourHints: { yarnrc: signals.yarnrc, pnp: signals.pnp, lockHead: signals.lockHead },
    levelsUp,
  };
}

async function realOrNull(filePath: string | undefined): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await realpath(filePath);
  } catch {
    return null;
  }
}

function isSameOrAncestor(candidate: string, of: string): boolean {
  const rel = path.relative(candidate, of);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Whether `rel` (POSIX, relative to `dir`) is one of the workspaces `dir` declares. */
async function declaresMember(dir: string, rel: string): Promise<boolean> {
  const patterns = workspacePatterns(await readPackage(dir), await readPnpmWorkspace(dir));
  return (
    patterns.include.some((pattern) => matchesWorkspacePattern(rel, pattern)) &&
    !patterns.exclude.some((pattern) => matchesWorkspacePattern(rel, pattern))
  );
}

/**
 * R6: looks above a workspace with no signals of its own for an enclosing
 * repo's lockfile. Stops at the first lockfile or pnpm-workspace.yaml, after
 * a folder holding `.git`, after five levels, and before home, `stopAt` or
 * anything above them. The signal counts only when that folder's
 * `workspaces` or pnpm-workspace.yaml lists the workspace; otherwise it is a
 * stray or unrelated lockfile, and the workspace gets npm's plain install.
 * Reads names, the yarn.lock head, and that folder's package.json and
 * pnpm-workspace.yaml through the bounded reader.
 */
async function enclosingSignals(
  root: string,
  limits: { stopAt?: string; homeDir: string },
): Promise<{ signals: FolderSignals; levelsUp: number } | null> {
  const realRoot = await realOrNull(root);
  if (!realRoot) return null;
  const fences = (await Promise.all([realOrNull(limits.stopAt), realOrNull(limits.homeDir)])).filter(
    (fence): fence is string => fence !== null,
  );
  let dir = realRoot;
  for (let level = 1; level <= MAX_WALK_LEVELS; level++) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    if (fences.some((fence) => isSameOrAncestor(dir, fence))) return null;
    const signals = await folderSignals(dir, { deno: false });
    if (hasOwnSignal(signals)) {
      const rel = path.relative(dir, realRoot).split(path.sep).join("/");
      return (await declaresMember(dir, rel)) ? { signals, levelsUp: level } : null;
    }
    if (signals.git) return null;
  }
  return null;
}

function packageName(pkg: PackageJson | null): string | undefined {
  if (typeof pkg?.name !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const name = pkg.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, MAX_NAME);
  return name || undefined;
}

async function readPackage(dir: string): Promise<PackageJson | null> {
  const text = await readBounded(path.join(dir, "package.json"), PACKAGE_JSON_CAP);
  return text === null ? null : parsePackageJson(text);
}

async function readPnpmWorkspace(root: string): Promise<unknown> {
  const text = await readBounded(path.join(root, "pnpm-workspace.yaml"), PNPM_WORKSPACE_CAP);
  if (text === null) return null;
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
}

/** R1: candidate folders (relative, POSIX) and whether a workspace pattern matched them. */
async function findCandidates(
  root: string,
  patterns: { include: string[]; exclude: string[] },
): Promise<Map<string, boolean>> {
  const found = new Map<string, boolean>();
  // A Deno project has no package.json; it is still listed, so its manager can be reported unsupported.
  const consider = async (rel: string, viaPattern: boolean) => {
    const dir = toAbsolute(root, rel);
    let admitted = await exists(path.join(dir, "package.json"));
    for (const marker of DENO_MARKERS) {
      if (admitted) break;
      admitted = await exists(path.join(dir, marker));
    }
    if (admitted) found.set(rel, (found.get(rel) ?? false) || viaPattern);
  };

  await consider(".", false);
  for (const container of FIXED_CONTAINERS) {
    if (!(await isRealFolderPath(root, [container]))) continue;
    for (const name of await listFolders(path.join(root, container))) await consider(`${container}/${name}`, false);
  }
  for (const folder of FIXED_FOLDERS) {
    if (await isRealFolderPath(root, [folder])) await consider(folder, false);
  }

  for (const pattern of patterns.include) {
    const shape = parseWorkspacePattern(pattern);
    if (!shape || !(await isRealFolderPath(root, shape.parent))) continue;
    if (!shape.wildcard) {
      if (await isRealFolderPath(root, [...shape.parent, shape.last])) await consider(pattern, true);
      continue;
    }
    const parentRel = shape.parent.join("/");
    for (const name of await listFolders(path.join(root, ...shape.parent))) {
      const rel = parentRel ? `${parentRel}/${name}` : name;
      if (matchesWorkspacePattern(rel, pattern)) await consider(rel, true);
    }
  }
  for (const rel of [...found.keys()]) {
    if (rel !== "." && patterns.exclude.some((pattern) => matchesWorkspacePattern(rel, pattern))) found.delete(rel);
  }
  return found;
}

/**
 * The workspace's app candidates, each classified (R4), with its package
 * manager (R5), install root (R6) and install state (R7). `stopAt` and
 * `homeDir` bound the enclosing walk; tests set both to their temp folder.
 */
export async function detectWebApp(root: string, options: { stopAt?: string; homeDir?: string } = {}): Promise<WebAppDetection> {
  try {
    if (!(await stat(root)).isDirectory()) return { apps: [], truncated: false };
  } catch {
    return { apps: [], truncated: false };
  }
  const rootPkg = await readPackage(root);
  const patterns = workspacePatterns(rootPkg, await readPnpmWorkspace(root));
  const found = await findCandidates(root, patterns);
  const ordered = [...found.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const truncated = ordered.length > MAX_CANDIDATES;

  const rootSignals = await folderSignals(root, { deno: true });
  const rootHasSignal =
    hasOwnSignal(rootSignals) || rootSignals.denoMarker || parsePackageManagerField(rootPkg?.packageManager) !== null;
  const enclosing =
    rootHasSignal || rootSignals.git ? null : await enclosingSignals(root, { stopAt: options.stopAt, homeDir: options.homeDir ?? homedir() });

  const apps: DetectedApp[] = [];
  for (const rel of ordered.slice(0, MAX_CANDIDATES)) {
    const dir = toAbsolute(root, rel);
    const pkg = rel === "." ? rootPkg : await readPackage(dir);
    const own = rel === "." ? rootSignals : await folderSignals(dir, { deno: true });
    const member = rel !== "." && !hasOwnSignal(own) && found.get(rel) === true;
    const installRoot = member ? "." : rel;
    const installSignals = member ? rootSignals : own;
    const field = pkg?.packageManager ?? (member ? rootPkg?.packageManager : undefined);

    let signals = managerSignals(installSignals, field, 0);
    let installed = installSignals.nodeModules || installSignals.pnp;
    const empty = signals.field === null && signals.lockfiles.size === 0 && !signals.pnpmWorkspaceFile && !signals.denoMarker;
    if (empty && enclosing) {
      signals = managerSignals(enclosing.signals, undefined, enclosing.levelsUp);
      installed ||= enclosing.signals.nodeModules || enclosing.signals.pnp;
    }

    const noPackageJson = pkg === null && !(await exists(path.join(dir, "package.json")));
    const classification: PackageClassification = noPackageJson
      ? { kind: "none", reason: "no-package-json", usesReact: false }
      : classifyPackage(pkg, {
      workspaceRunnerFile: own.runnerFile,
      workspaceRoot: rel === "." && patterns.include.length > 0,
    });
    const name = packageName(pkg);
    apps.push({
      root: rel,
      ...(name ? { name } : {}),
      ...classification,
      scripts: pkg ? safeScriptNames(pkg) : [],
      packageManager: decidePackageManager(signals),
      installRoot,
      installed,
    });
  }
  return { apps, truncated };
}
