/**
 * Finding the person's Node.js and package managers, shared by simulator
 * devices and design mode's live app.
 *
 * A Finder launch does not inherit the person's shell PATH, so lookup tries
 * PATH, then the login shell's `command -v`, then the usual Homebrew folders.
 * Only the fixed commands in `ToolCommand` are ever looked up, so nothing read
 * from a project (a package.json, say) can reach the shell.
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ToolCommand = "node" | "npm" | "pnpm" | "yarn" | "bun";

const TOOL_COMMANDS: ReadonlySet<string> = new Set<ToolCommand>(["node", "npm", "pnpm", "yarn", "bun"]);

export function isToolCommand(value: unknown): value is ToolCommand {
  return typeof value === "string" && TOOL_COMMANDS.has(value);
}

/** Login-shell answers that passed the executable check, keyed by shell and command. */
export interface ExecutableCache {
  get(key: string): string | undefined;
  set(key: string, path: string): void;
  delete(key: string): void;
}

export function createExecutableCache(): ExecutableCache & { clear(): void } {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => void entries.set(key, value),
    delete: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

export interface ExecutableResolutionDeps {
  env: NodeJS.ProcessEnv;
  isExecutable(filePath: string): Promise<boolean>;
  /** Prints `command -v <command>` from the person's login shell. */
  loginShellLookup(shell: string, command: ToolCommand): Promise<string | null>;
  /** Keeps validated login-shell answers. Misses and junk output are never kept. */
  cache?: ExecutableCache;
}

/** PATH (absolute entries only), then the login shell, then the usual Homebrew locations. */
export async function resolveExecutable(command: ToolCommand, deps: ExecutableResolutionDeps): Promise<string | null> {
  for (const dir of (deps.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    if (await deps.isExecutable(candidate)) return candidate;
  }
  const shell = deps.env.SHELL;
  if (shell && path.isAbsolute(shell)) {
    const key = `${shell}\0${command}`;
    const cached = deps.cache?.get(key);
    if (cached !== undefined) {
      if (await deps.isExecutable(cached)) return cached;
      deps.cache?.delete(key);
    }
    const printed = await deps.loginShellLookup(shell, command).catch(() => null);
    const candidate = printed
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .reverse()
      .find((line) => path.isAbsolute(line));
    if (candidate && (await deps.isExecutable(candidate))) {
      deps.cache?.set(key, candidate);
      return candidate;
    }
  }
  for (const candidate of [path.join("/opt/homebrew/bin", command), path.join("/usr/local/bin", command)]) {
    if (await deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Runs `$SHELL -ilc "command -v <command>"`. `maxBuffer` reaches `execFile`
 * only when given, so leaving it out keeps Node's default (1 MiB).
 */
export function loginShellCommandLookup(options: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}): (shell: string, command: ToolCommand) => Promise<string | null> {
  const timeout = options.timeoutMs ?? 5_000;
  return (shell, command) =>
    new Promise((resolve) => {
      if (!isToolCommand(command)) {
        resolve(null);
        return;
      }
      execFile(
        shell,
        ["-ilc", `command -v ${command}`],
        {
          timeout,
          encoding: "utf8",
          env: options.env,
          ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
}

export async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `dirs` first, then the inherited PATH, with every empty entry dropped. An
 * empty entry means the working folder, so a file named `node` there would run.
 */
export function prependPathEntries(dirs: readonly string[], pathValue: string | undefined): string {
  return [...dirs, ...(pathValue ?? "").split(path.delimiter)].filter((entry) => entry !== "").join(path.delimiter);
}

/** A copy of `env` with `binDirs` first on PATH and Electron's Node mode cleared. */
export function nodeCommandEnvironment(env: NodeJS.ProcessEnv, binDirs: readonly string[]): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, PATH: prependPathEntries(binDirs, env.PATH) };
  delete clean.ELECTRON_RUN_AS_NODE;
  return clean;
}

/**
 * A standalone Node at `minMajor` or newer, never the hardened Electron app.
 * Rejects the app itself before probing, including symlinks and hard links named node.
 */
export async function isStandaloneNodeExecutable(
  candidate: string,
  env: NodeJS.ProcessEnv,
  options: { minMajor: number; appExecutable?: string; isElectron?: boolean },
): Promise<boolean> {
  const appExecutable = options.appExecutable ?? process.execPath;
  const isElectron = options.isElectron ?? !!process.versions.electron;
  try {
    await access(candidate, fsConstants.X_OK);
    if (isElectron) {
      const [target, appTarget, targetStat, appStat] = await Promise.all([
        realpath(candidate), realpath(appExecutable), stat(candidate), stat(appExecutable),
      ]);
      if (target === appTarget || (targetStat.dev === appStat.dev && targetStat.ino === appStat.ino)) return false;
    }
    const output = await new Promise<string>((resolve, reject) => {
      execFile(candidate, ["-p", 'JSON.stringify({node:process.versions.node,electron:!!process.versions.electron})'], {
        env: nodeCommandEnvironment(env, [path.dirname(candidate)]), timeout: 5_000, maxBuffer: 4096, encoding: "utf8",
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const runtime = JSON.parse(output.trim()) as { node?: unknown; electron?: unknown };
    return runtime.electron === false && typeof runtime.node === "string" && /^\d+\.\d+\.\d+$/u.test(runtime.node)
      && Number(runtime.node.split(".")[0]) >= options.minMajor;
  } catch {
    return false;
  }
}
