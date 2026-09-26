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
    : (env.PATH ?? "/usr/bin:/bin").split(":").map((dir) => path.resolve(cwd, dir, binary));
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
    // A GUI PATH may put Apple's shim before Homebrew. Keep looking for a real Git.
  }
  throw new Error("Git is not installed or unavailable. Install Git to use repository features; ordinary chat does not require it.");
}
