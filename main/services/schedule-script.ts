import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathInside } from "../shared/path-containment.js";
import { createProcessGroupTerminator, decodeCappedUtf8, waitForChildExit } from "../shared/process-group.js";
import { agentShellCommandEnvironment } from "./agent-command-environment.js";
import { AIDEN_DIR_NAME, aidenConfigDir } from "./aiden-config-dir.js";
import { validateScriptName } from "./schedule-store-core.js";

const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_OUTPUT_LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 1_000;
// How long the output pipes may stay open after the script exits (a background
// job inherited them) before the group is stopped.
const PIPE_DRAIN_MS = 1_000;

/**
 * Script roots, workspace first. An explicitly injected home wins over
 * AIDEN_CONFIG_DIR so tests stay hermetic; the default path honours the override
 * so redirecting the config directory moves scripts along with it.
 */
function scriptRoots(input: { workspaceRoot?: string; homeDirectory?: string }): string[] {
  const globalRoot =
    input.homeDirectory === undefined
      ? aidenConfigDir()
      : path.join(input.homeDirectory, AIDEN_DIR_NAME);
  return [
    input.workspaceRoot ? path.join(input.workspaceRoot, AIDEN_DIR_NAME, "scripts") : undefined,
    path.join(globalRoot, "scripts"),
  ].filter((value): value is string => Boolean(value));
}

export interface ScriptProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
}

async function existingScriptInRoot(root: string, script: string): Promise<string | null> {
  const candidate = path.join(root, script);
  try {
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
    ]);
    if (!isPathInside(realRoot, realCandidate)) {
      throw new Error(`Script "${script}" resolves outside ${root}.`);
    }
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) throw new Error(`Script "${script}" is not a regular file.`);
    return realCandidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveScheduledScript(input: {
  script: string;
  workspaceRoot?: string;
  homeDirectory?: string;
}): Promise<string> {
  const script = validateScriptName(input.script);
  const roots = scriptRoots(input);
  for (const root of roots) {
    const resolved = await existingScriptInRoot(root, script);
    if (resolved) return resolved;
  }
  throw new Error(
    `Script "${script}" was not found in ${roots.map((root) => path.join(root, script)).join(" or ")}.`,
  );
}

export async function listScheduledScripts(input: {
  workspaceRoot?: string;
  homeDirectory?: string;
}): Promise<string[]> {
  const roots = scriptRoots(input);
  const names = new Set<string>();
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true, encoding: "utf-8" });
      for (const entry of entries) {
        if (names.has(entry.name)) continue;
        try {
          if (await existingScriptInRoot(root, entry.name)) names.add(entry.name);
        } catch {
          // Do not expose symlink escapes or other invalid entries in the picker.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function scriptCommand(scriptPath: string): { command: string; args: string[] } {
  switch (path.extname(scriptPath).toLowerCase()) {
    case ".sh":
    case ".bash":
      return { command: "/bin/bash", args: [scriptPath] };
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: "node", args: [scriptPath] };
    case ".py":
      return { command: "python3", args: [scriptPath] };
    default:
      return { command: scriptPath, args: [] };
  }
}

/**
 * Runs a schedule's script in its own process group with a deadline and an
 * output cap. A timeout, the cap or an abort stops the whole group (SIGTERM,
 * then SIGKILL), and the result waits for that cleanup. The script gets the
 * same environment as `run_command`: the agent PATH, without Aiden's own
 * credentials.
 */
export async function runScheduledScript(
  scriptPath: string,
  options: { cwd: string; timeoutMs?: number; outputLimit?: number; signal?: AbortSignal },
): Promise<ScriptProcessResult> {
  const { command, args } = scriptCommand(scriptPath);
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? SCRIPT_OUTPUT_LIMIT;
  if (options.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      outputLimitExceeded: false,
      aborted: true,
    };
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: agentShellCommandEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const terminator = createProcessGroupTerminator(child, { killGraceMs: KILL_GRACE_MS });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let aborted = false;

  const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, outputLimit - bytes);
    if (remaining > 0) target.push(value.subarray(0, remaining));
    bytes += value.length;
    if (bytes > outputLimit && !outputLimitExceeded) {
      outputLimitExceeded = true;
      terminator.terminate();
    }
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  const abort = () => {
    aborted = true;
    terminator.terminate();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminator.terminate();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const { code, signal } = await waitForChildExit(child, {
      drainMs: PIPE_DRAIN_MS,
      onPipesHeld: () => terminator.terminate(),
    });
    return {
      stdout: decodeCappedUtf8(Buffer.concat(stdout), outputLimitExceeded),
      stderr: decodeCappedUtf8(Buffer.concat(stderr), outputLimitExceeded),
      exitCode: code,
      signal,
      timedOut,
      outputLimitExceeded,
      aborted,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await terminator.finished();
  }
}
