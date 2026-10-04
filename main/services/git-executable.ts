import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GitExecutableDependencies {
  platform: NodeJS.Platform;
  executablePath(candidate: string): Promise<string | undefined>;
  developerDirectory(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string>;
}

const defaults: GitExecutableDependencies = {
  platform: process.platform,
  async executablePath(candidate) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) return undefined;
      return await realpath(candidate);
    } catch {
      return undefined;
    }
  },
  async developerDirectory(env, signal) {
    // Unlike git/xcrun, querying the selected directory never requests installation.
    const { stdout } = await execFileAsync("/usr/bin/xcode-select", ["--print-path"], {
      env, signal, timeout: 2_000, maxBuffer: 16_384, encoding: "utf8",
    });
    return stdout.trim();
  },
};

/** Never execute Apple's install-on-demand Git shim. No dependency on full Xcode. */
export async function resolveGitExecutable(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  deps: GitExecutableDependencies = defaults,
): Promise<string> {
  signal?.throwIfAborted();
  if (deps.platform !== "darwin") return binary;
  const candidates = binary.includes("/")
    ? [path.resolve(cwd, binary)]
    : (env.PATH ?? "/usr/bin:/bin")
        .split(":")
        // Automatic metadata reads must never discover executables in the workspace.
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, binary));
  for (const candidate of candidates) {
    const executable = await deps.executablePath(candidate);
    signal?.throwIfAborted();
    if (!executable) continue;
    if (executable !== "/usr/bin/git") return executable;
    try {
      const developerDir = await deps.developerDirectory(env, signal);
      if (path.isAbsolute(developerDir)) {
        const installed = await deps.executablePath(path.join(developerDir, "usr/bin/git"));
        signal?.throwIfAborted();
        if (installed && installed !== "/usr/bin/git") return installed;
      }
    } catch {
      signal?.throwIfAborted();
    }
    // CLT may be installed even when the selected developer directory is absent/stale.
    const commandLineGit = await deps.executablePath(
      "/Library/Developer/CommandLineTools/usr/bin/git",
    );
    signal?.throwIfAborted();
    if (commandLineGit && commandLineGit !== "/usr/bin/git") return commandLineGit;
    // A GUI PATH may put Apple's shim before Homebrew. Keep looking for a real Git.
  }
  throw new Error("Git is not installed or unavailable. Install Git to use repository features; ordinary chat does not require it.");
}

export type GitExecutableResolver = (
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<string>;

interface GitExecutableResolverOptions {
  /** How long a resolution is trusted before the full search (and its xcode-select probe) reruns. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_RESOLUTION_TTL_MS = 5 * 60_000;

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/**
 * Memoizes {@link resolveGitExecutable} per binary/PATH/DEVELOPER_DIR. Every Git command
 * otherwise repeats the PATH walk and, when Apple's shim leads PATH, spawns xcode-select.
 * A hit is revalidated with one filesystem probe of the resolved file, so an uninstalled
 * or replaced Git is noticed on the next command; failures are never cached.
 */
export function createGitExecutableResolver(
  deps: GitExecutableDependencies = defaults,
  options: GitExecutableResolverOptions = {},
): GitExecutableResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_RESOLUTION_TTL_MS;
  const now = options.now ?? Date.now;
  const resolved = new Map<string, { executable: string; at: number }>();
  const pending = new Map<string, Promise<string>>();

  return async (binary, cwd, env, signal) => {
    signal?.throwIfAborted();
    if (deps.platform !== "darwin") return binary;
    const key = JSON.stringify([
      binary.includes("/") ? path.resolve(cwd, binary) : binary,
      env.PATH ?? null,
      env.DEVELOPER_DIR ?? null,
    ]);
    const cached = resolved.get(key);
    if (cached && now() - cached.at < ttlMs) {
      const current = await abortable(deps.executablePath(cached.executable), signal);
      if (current === cached.executable) return cached.executable;
    }
    if (resolved.get(key) === cached) resolved.delete(key);
    let resolution = pending.get(key);
    if (!resolution) {
      // Shared by concurrent callers, so it must not inherit any one caller's signal.
      resolution = resolveGitExecutable(binary, cwd, env, undefined, deps).then(
        (executable) => {
          resolved.set(key, { executable, at: now() });
          return executable;
        },
      ).finally(() => pending.delete(key));
      // A caller may abort before attaching; the failure still surfaces to the others.
      resolution.catch(() => undefined);
      pending.set(key, resolution);
    }
    return abortable(resolution, signal);
  };
}

/** Process-wide memoized resolver used by the Git service. */
export const resolveGitExecutableMemoized: GitExecutableResolver = createGitExecutableResolver();
