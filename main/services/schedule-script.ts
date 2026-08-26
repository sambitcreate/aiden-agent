import { spawn } from "node:child_process";
import { trackDiagnosticChild } from "./performance-child.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AIDEN_DIR_NAME, aidenConfigDir } from "./aiden-config-dir.js";
import { validateScriptName } from "./schedule-store.js";

const SCRIPT_TIMEOUT_MS = 60_000;
const SCRIPT_OUTPUT_LIMIT = 1024 * 1024;

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

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function existingScriptInRoot(root: string, script: string): Promise<string | null> {
  const candidate = path.join(root, script);
  try {
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
    ]);
    if (!pathInside(realRoot, realCandidate)) {
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

export function runScheduledScript(
  scriptPath: string,
  options: { cwd: string; timeoutMs?: number; outputLimit?: number; signal?: AbortSignal },
): Promise<ScriptProcessResult> {
  const { command, args } = scriptCommand(scriptPath);
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? SCRIPT_OUTPUT_LIMIT;
  if (options.signal?.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      outputLimitExceeded: false,
      aborted: true,
    });
  }
  return new Promise((resolve, reject) => {
    const child = (() => {
      try {
        return spawn(command, args, {
          cwd: options.cwd,
          detached: process.platform !== "win32",
          env: process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return null;
      }
    })();
    if (!child) return;
    trackDiagnosticChild("schedule-script", child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let aborted = false;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let terminationRequested = false;

    const signalProcess = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may have already exited; fall back to the child handle.
        }
      }
      child.kill(signal);
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      signalProcess("SIGTERM");
      forceKill = setTimeout(() => {
        if (!settled) signalProcess("SIGKILL");
      }, 1_000);
      forceKill.unref?.();
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, outputLimit - bytes);
      if (remaining > 0) target.push(value.subarray(0, remaining));
      bytes += value.length;
      if (bytes > outputLimit && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        aborted,
      });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref?.();
  });
}
