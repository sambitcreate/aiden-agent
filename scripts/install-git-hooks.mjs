import { spawnSync as defaultSpawnSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOOKS_PATH = ".githooks";

export function installGitHooks({
  cwd = process.cwd(),
  env = process.env,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (String(env.CI ?? "").trim().length > 0) {
    return { status: 0, action: "skipped-ci" };
  }

  if (!existsSync(path.join(cwd, ".git"))) {
    return { status: 0, action: "skipped-no-git" };
  }

  const current = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (current.error) {
    throw current.error;
  }
  if (current.status === 0) {
    const existing = String(current.stdout ?? "").trim();
    if (existing.length > 0) {
      return {
        status: 0,
        action: existing === DEFAULT_HOOKS_PATH ? "already-configured" : "preserved-custom",
        hooksPath: existing,
      };
    }
  } else if (current.status !== 1) {
    return {
      status: current.status ?? 1,
      action: "error",
      stderr: String(current.stderr ?? ""),
    };
  }

  const write = spawnSync("git", ["config", "--local", "core.hooksPath", DEFAULT_HOOKS_PATH], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (write.error) {
    throw write.error;
  }
  if (write.status !== 0) {
    return {
      status: write.status ?? 1,
      action: "error",
      stderr: String(write.stderr ?? ""),
    };
  }

  return {
    status: 0,
    action: "configured",
    hooksPath: DEFAULT_HOOKS_PATH,
  };
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const result = installGitHooks();
  if (result.status !== 0) {
    if (result.stderr) {
      console.error(result.stderr.trimEnd());
    }
    process.exit(result.status);
  }
}
