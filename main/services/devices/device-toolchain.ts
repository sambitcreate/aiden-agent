/**
 * Adapted from t3code apps/server/src/device/DeviceToolchain.ts @ 1c127066 (MIT)
 *
 * Pinned installs of the two external tools simulator support is built on:
 * `expo-device-hub` streams simulator screens and `agent-device` drives them.
 * Each is npm-installed only after its consent step into
 * `<baseDir>/tools/<name>/<version>` and run from there with Electron-as-Node,
 * never `npx`, so a reboot never makes the next open depend on the registry.
 *
 * Install stages into a temp sibling, writes a sentinel only after npm exits
 * 0 and the entry exists, then renames into place. npm extracts files before
 * it finishes, so an entry file alone does not prove a usable tree.
 */
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ToolSpec {
  name: string;
  version: string;
  entry: readonly string[];
}

export const DEVICE_HUB: ToolSpec = {
  name: "expo-device-hub",
  version: "0.12.0",
  entry: ["dist", "server", "cli.mjs"],
};

export const AGENT_DEVICE: ToolSpec = {
  name: "agent-device",
  version: "0.21.12",
  entry: ["bin", "agent-device.mjs"],
};

export const DEVICE_TOOL_INSTALL_TIMEOUT_MS = 10 * 60_000;
const SENTINEL = ".install-complete";
const VERSION_DIR_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u;

export interface DeviceToolPaths {
  installDir: string;
  entryPath: string;
  sentinel: string;
}

export interface NpmResult {
  code: number;
  stderr: string;
}

export type NpmRunner = (args: string[], options: { timeoutMs: number }) => Promise<NpmResult>;

export class DeviceToolchainInstallError extends Error {
  declare readonly cause: unknown;
  constructor(
    readonly tool: string,
    readonly step: string,
    readonly exitCode?: number,
    options?: { cause?: unknown },
  ) {
    const suffix = exitCode === undefined ? "" : ` (exit code ${exitCode})`;
    super(`Installing ${tool} failed while ${step}${suffix}.`);
    this.name = "DeviceToolchainInstallError";
    this.cause = options?.cause;
  }
}

export function deviceToolPaths(baseDir: string, spec: ToolSpec): DeviceToolPaths {
  const installDir = path.join(baseDir, "tools", spec.name, spec.version);
  return {
    installDir,
    entryPath: path.join(installDir, "node_modules", spec.name, ...spec.entry),
    sentinel: path.join(installDir, SENTINEL),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isToolInstalled(baseDir: string, spec: ToolSpec): Promise<boolean> {
  const paths = deviceToolPaths(baseDir, spec);
  try {
    const sentinel = await readFile(paths.sentinel, "utf8");
    return sentinel.trim() === spec.version && (await exists(paths.entryPath));
  } catch {
    return false;
  }
}

async function installTool(baseDir: string, spec: ToolSpec, runNpm: NpmRunner): Promise<string> {
  const paths = deviceToolPaths(baseDir, spec);
  if (await isToolInstalled(baseDir, spec)) return paths.entryPath;
  const fail = (step: string, exitCode?: number) => (cause?: unknown) => {
    throw new DeviceToolchainInstallError(spec.name, step, exitCode, { cause });
  };

  const parentDir = path.dirname(paths.installDir);
  await rm(paths.installDir, { recursive: true, force: true }).catch(
    fail("removing an incomplete install"),
  );
  await mkdir(parentDir, { recursive: true }).catch(fail("preparing the install directory"));
  const stagingDir = await mkdtemp(path.join(parentDir, ".staging-")).catch(
    fail("preparing the install directory"),
  );
  try {
    const result = await runNpm(
      [
        "install",
        "--prefix",
        stagingDir,
        "--no-fund",
        "--no-audit",
        "--ignore-scripts=false",
        `${spec.name}@${spec.version}`,
      ],
      { timeoutMs: DEVICE_TOOL_INSTALL_TIMEOUT_MS },
    ).catch(fail("running npm install"));
    if (result.code !== 0) fail("running npm install", result.code)(result.stderr);
    if (!(await exists(path.join(stagingDir, "node_modules", spec.name, ...spec.entry)))) {
      fail("verifying the installed entry point")();
    }
    await writeFile(path.join(stagingDir, SENTINEL), `${spec.version}\n`).catch(
      fail("recording the completed install"),
    );
    try {
      await rename(stagingDir, paths.installDir);
    } catch (cause) {
      // Another Aiden process may have published the same version first.
      if (!(await isToolInstalled(baseDir, spec))) fail("publishing the install")(cause);
    }
    return paths.entryPath;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const inflight = new Map<string, Promise<string>>();
let installQueue: Promise<unknown> = Promise.resolve();

/**
 * Installs `spec` if needed and returns its entry path. Concurrent callers for
 * the same tool share one install, and installs of different tools run one at
 * a time so two npm processes never race on the same cache.
 */
export function ensureTool(
  baseDir: string,
  spec: ToolSpec,
  deps: { runNpm: NpmRunner },
): Promise<string> {
  const key = `${baseDir}\0${spec.name}@${spec.version}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const next = installQueue.then(() => installTool(baseDir, spec, deps.runNpm));
  installQueue = next.catch(() => undefined);
  const shared = next.finally(() => inflight.delete(key));
  inflight.set(key, shared);
  return shared;
}

/** Removes every completed or abandoned version directory except the pinned one. */
export async function pruneOldToolVersions(baseDir: string, spec: ToolSpec): Promise<void> {
  const toolDir = path.join(baseDir, "tools", spec.name);
  let names: string[];
  try {
    names = await readdir(toolDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name !== spec.version && VERSION_DIR_PATTERN.test(name))
      .map((name) => rm(path.join(toolDir, name), { recursive: true, force: true })),
  );
}

/** Completed installs on disk, read without downloading or starting either tool. */
export async function installedToolVersions(baseDir: string, spec: ToolSpec): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(baseDir, "tools", spec.name));
  } catch {
    return [];
  }
  const checks = await Promise.all(
    names.map(async (version) =>
      VERSION_DIR_PATTERN.test(version) && (await isToolInstalled(baseDir, { ...spec, version }))
        ? version
        : null,
    ),
  );
  return checks.filter((version): version is string => version !== null).sort();
}

export interface NpmResolutionDeps {
  env: NodeJS.ProcessEnv;
  isExecutable(filePath: string): Promise<boolean>;
  /** Prints `command -v npm` from the user's login shell, which a Finder launch does not inherit. */
  loginShellLookup(shell: string): Promise<string | null>;
}

const FALLBACK_NPM_PATHS = ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"];

/** Finds the user's npm: PATH, then the login shell, then the usual Homebrew locations. */
export async function resolveNpm(deps: NpmResolutionDeps): Promise<string | null> {
  for (const dir of (deps.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "npm");
    if (await deps.isExecutable(candidate)) return candidate;
  }
  const shell = deps.env.SHELL;
  if (shell && path.isAbsolute(shell)) {
    const printed = await deps.loginShellLookup(shell).catch(() => null);
    const candidate = printed
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .reverse()
      .find((line) => path.isAbsolute(line));
    if (candidate && (await deps.isExecutable(candidate))) return candidate;
  }
  for (const candidate of FALLBACK_NPM_PATHS) {
    if (await deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

export const defaultNpmResolutionDeps: NpmResolutionDeps = {
  env: process.env,
  isExecutable: async (filePath) => {
    try {
      await access(filePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  loginShellLookup: (shell) =>
    new Promise((resolve) => {
      execFile(
        shell,
        ["-ilc", "command -v npm"],
        { timeout: 5_000, encoding: "utf8", env: process.env },
        (error, stdout) => resolve(error ? null : stdout),
      );
    }),
};

const STDERR_LIMIT = 16_384;

/** Runs the resolved npm with its own directory first on PATH, since npm's shebang is `env node`. */
export function createNpmRunner(npmPath: string, env: NodeJS.ProcessEnv = process.env): NpmRunner {
  return (args, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      const child = spawn(npmPath, args, {
        env: {
          ...env,
          PATH: [path.dirname(npmPath), env.PATH].filter(Boolean).join(path.delimiter),
          npm_config_update_notifier: "false",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 124 : 1), stderr });
      });
    });
}
