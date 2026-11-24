/**
 * Reads what a launch consent covers (plan 2b D5) from disk: the scripts that
 * will or may run, the package manager fields, and a hash of every file that
 * changes what installing or starting does. Every read is bounded and never
 * follows a link: a listed file that is a link, FIFO, device or folder, or is
 * over its cap, refuses the start rather than hashing something else.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { MAX_JOB_COMMAND_CHARS } from "../../follow-through/background-jobs.js";
import { readBounded } from "./app-detect.js";
import { launchFingerprint, type LaunchSurface } from "./app-launch-core.js";
import { installCommand, parsePackageJson, runScriptCommand, type DetectedApp, type PackageJson } from "./app-server-core.js";

const RC_CAP = 1024 * 1024;
const LOCK_CAP = 64 * 1024 * 1024;
const PACKAGE_JSON_CAP = 512 * 1024;
const RC_FILES = [".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml", ".pnpmfile.cjs", "bunfig.toml"];
const CONFIG_BASES = [
  "vite.config",
  "next.config",
  "astro.config",
  "react-router.config",
  "remix.config",
  "nuxt.config",
  "gatsby-config",
  "gatsby-node",
];
const CONFIG_EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"];
const CONFIG_FILES = [...CONFIG_BASES.flatMap((base) => CONFIG_EXTENSIONS.map((ext) => `${base}.${ext}`)), "angular.json"];
const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
const MAX_FILE_NAME = 200;

export type HashResult = { hash: string } | { unreadable: true } | { missing: true };

/**
 * SHA-256 of a regular file of at most `cap` bytes, opened with `O_NOFOLLOW |
 * O_NONBLOCK`, so a link or FIFO never redirects or blocks it.
 */
export async function hashBounded(filePath: string, cap: number): Promise<HashResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { unreadable: true };
  }
  try {
    if (!(await handle.stat()).isFile()) return { unreadable: true };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > cap) return { unreadable: true };
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { hash: hash.digest("hex") };
  } catch {
    return { unreadable: true };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface LaunchSurfaceRead {
  fingerprint: string;
  surface: LaunchSurface;
  /** What the card shows: every script that will or may run, with its text. */
  scripts: Array<{ name: string; text: string }>;
  /** The rc, workspace and config file names present, relative to the workspace; never their contents. */
  launchFiles: string[];
  packageName?: string;
  /** The lockfile's hash, or the install root's package.json hash with no lockfile (D6). */
  lockHash: string;
}

export type LaunchSurfaceProblem = { problem: "launch-file-unreadable"; file: string } | { problem: "script-too-long" };

class Refused extends Error {
  constructor(readonly result: LaunchSurfaceProblem) {
    super(result.problem);
  }
}

function scriptsOf(pkg: PackageJson | null): Record<string, unknown> {
  const scripts = pkg?.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
}

function scriptText(pkg: PackageJson | null, name: string): string | null {
  const value = scriptsOf(pkg)[name];
  return typeof value === "string" ? value : null;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The launch surface of a detected app, read now. `workspaceRoot` is the
 * workspace folder; names in the result are relative to it (`../` above it,
 * for the hash only).
 */
export async function readLaunchSurface(workspaceRoot: string, app: DetectedApp): Promise<LaunchSurfaceRead | LaunchSurfaceProblem> {
  try {
    return await readSurface(workspaceRoot, app);
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

async function readSurface(workspaceRoot: string, app: DetectedApp): Promise<LaunchSurfaceRead> {
  const realRoot = await realpath(workspaceRoot);
  const relName = (absolute: string) => path.relative(realRoot, absolute).split(path.sep).join("/") || ".";
  const appDir = await realpath(path.join(realRoot, ...app.root.split("/")));
  const installDir = await realpath(path.join(realRoot, ...app.installRoot.split("/")));
  if (!isInside(realRoot, appDir) || !isInside(realRoot, installDir)) throw new Error("The app is outside the workspace.");

  const files: Array<[string, string]> = [];
  const launchFiles: string[] = [];
  const seen = new Set<string>();
  const hashFile = async (absolute: string, cap: number, listed: boolean): Promise<string | null> => {
    const name = relName(absolute).slice(0, MAX_FILE_NAME);
    if (seen.has(absolute)) return files.find(([existing]) => existing === name)?.[1] ?? null;
    seen.add(absolute);
    const result = await hashBounded(absolute, cap);
    if ("unreadable" in result) throw new Refused({ problem: "launch-file-unreadable", file: name });
    const value = "hash" in result ? result.hash : "missing";
    files.push([name, value]);
    if (listed && value !== "missing" && !name.startsWith("..")) launchFiles.push(name);
    return "hash" in result ? result.hash : null;
  };

  const readPackage = async (dir: string): Promise<PackageJson | null> => {
    const file = path.join(dir, "package.json");
    const text = await readBounded(file, PACKAGE_JSON_CAP);
    if (text === null) throw new Refused({ problem: "launch-file-unreadable", file: relName(file) });
    return parsePackageJson(text);
  };
  const appPkg = await readPackage(appDir);
  const installPkg = installDir === appDir ? appPkg : await readPackage(installDir);

  // Scripts: the app's own, its pre and post, and both roots' install lifecycle scripts.
  const script = app.script;
  if (!script) throw new Error("This app has no dev script to run.");
  const scripts: Record<string, string | null> = {};
  const shown: Array<{ name: string; text: string }> = [];
  for (const name of [script, `pre${script}`, `post${script}`, ...INSTALL_LIFECYCLE]) {
    const text = scriptText(appPkg, name);
    scripts[`app:${name}`] = text;
    if (text !== null) shown.push({ name, text });
  }
  for (const name of INSTALL_LIFECYCLE) {
    const text = scriptText(installPkg, name);
    scripts[`install:${name}`] = text;
    if (text !== null && installDir !== appDir) shown.push({ name: `${name} (${app.installRoot})`, text });
  }
  if (shown.some(({ text }) => text.length > MAX_JOB_COMMAND_CHARS)) throw new Refused({ problem: "script-too-long" });

  // The lockfile R5 chose, possibly in an enclosing folder.
  let lockDir = installDir;
  for (let level = 0; level < app.packageManager.lockfileLevelsUp; level += 1) lockDir = path.dirname(lockDir);
  const lockfile = app.packageManager.lockfile;
  const lockHash = lockfile ? await hashFile(path.join(lockDir, lockfile), LOCK_CAP, false) : null;

  // rc and workspace files in every folder from the app root up to the lockfile's folder.
  const stopDir = lockfile ? lockDir : installDir;
  const folders: string[] = [];
  for (let dir = appDir; ; dir = path.dirname(dir)) {
    folders.push(dir);
    if (dir === stopDir || !isInside(stopDir, dir) || path.dirname(dir) === dir) break;
  }
  if (!folders.includes(stopDir)) folders.push(stopDir);
  for (const dir of folders) {
    for (const name of RC_FILES) await hashFile(path.join(dir, name), RC_CAP, true);
    const yarnrc = path.join(dir, ".yarnrc.yml");
    const text = await readBounded(yarnrc, RC_CAP);
    if (text !== null) {
      let yarnPath: unknown;
      try {
        yarnPath = (parseYaml(text) as Record<string, unknown> | null)?.yarnPath;
      } catch {
        yarnPath = undefined;
      }
      if (typeof yarnPath === "string" && yarnPath.length > 0) await hashFile(path.resolve(dir, yarnPath), LOCK_CAP, false);
    }
  }

  // Framework configs present in the app root (a link counts as present, and refuses).
  for (const name of CONFIG_FILES) {
    const absolute = path.join(appDir, name);
    const result = await hashBounded(absolute, RC_CAP);
    if ("missing" in result) continue;
    await hashFile(absolute, RC_CAP, true);
  }

  const packageJsonHash = await hashBounded(path.join(installDir, "package.json"), PACKAGE_JSON_CAP);
  const info = app.packageManager;
  const install = info.name ? installCommand(info) : null;
  const run = info.name ? runScriptCommand(info, script) : null;
  const surface: LaunchSurface = {
    checkout: realRoot,
    appRoot: app.root,
    installRoot: app.installRoot,
    lockfileLevelsUp: info.lockfileLevelsUp,
    manager: info.name,
    ...(info.yarn ? { yarn: info.yarn } : {}),
    script,
    scripts,
    packageManager: { app: appPkg?.packageManager, install: installPkg?.packageManager },
    devEngines: { app: appPkg?.devEngines, install: installPkg?.devEngines },
    installArgv: install ? [install.command, ...install.args] : null,
    runArgv: run ? [run.command, ...run.args] : [],
    files,
  };
  return {
    fingerprint: launchFingerprint(surface),
    surface,
    scripts: shown,
    launchFiles: [...new Set(launchFiles)].sort(),
    ...(app.name ? { packageName: app.name } : {}),
    lockHash: lockHash ?? ("hash" in packageJsonHash ? packageJsonHash.hash : "none"),
  };
}
