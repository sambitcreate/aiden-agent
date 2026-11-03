// Run `git clone` for an explicit, user-initiated clone.
//
// Hooks are disabled, local and `ext::` transports are refused, Git never
// prompts on a terminal, stderr is bounded to a tail, and progress lines are
// parsed and throttled for the requesting document.

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import { createProcessGroupTerminator } from "../shared/process-group.js";
import { agentCommandEnvironment } from "./agent-command-environment.js";
import { resolveGitExecutableMemoized } from "./git-executable.js";
import type { GitCloneOutcome, GitCloneRequest } from "./workspace-intake.js";

const STDERR_TAIL_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const KILL_GRACE_MS = 750;
const PROGRESS_INTERVAL_MS = 120;

const GIT_ROUTING_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const;

/** Parse one `git clone --progress` line into a phase and optional percentage. */
export function parseGitCloneProgress(line: string): { phase: string; percent?: number } | undefined {
  const text = line.replace(/^remote:\s*/u, "").trim();
  if (/^Cloning into /u.test(text)) return { phase: "Cloning" };
  const match = /^([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/u.exec(text);
  if (match) return { phase: match[1], percent: Math.min(100, Number(match[2])) };
  const counting = /^([A-Za-z][A-Za-z ]*?):\s+\d+/u.exec(text);
  if (counting) return { phase: counting[1] };
  return undefined;
}

function cloneEnvironment(): NodeJS.ProcessEnv {
  const env = agentCommandEnvironment();
  for (const key of GIT_ROUTING_ENV) delete env[key];
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
}

export interface GitCloneRunnerOptions {
  gitBinary?: string;
  timeoutMs?: number;
  /**
   * Extra `-c` entries applied after Aiden's safety settings. Production passes
   * none; tests use it to point a fixture URL at a local bare repository.
   */
  extraConfig?: ReadonlyArray<readonly [string, string]>;
  resolveGit?: typeof resolveGitExecutableMemoized;
}

export function gitCloneArguments(
  url: string,
  destination: string,
  extraConfig: ReadonlyArray<readonly [string, string]> = [],
): string[] {
  const config: Array<readonly [string, string]> = [
    ["core.hooksPath", os.devNull],
    ["protocol.ext.allow", "never"],
    ["protocol.fd.allow", "never"],
    ["protocol.file.allow", "never"],
    ...extraConfig,
  ];
  return [
    ...config.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    "clone",
    "--progress",
    "--",
    url,
    destination,
  ];
}

export function createGitCloneRunner(options: GitCloneRunnerOptions = {}) {
  const gitBinary = options.gitBinary ?? "git";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolveGit = options.resolveGit ?? resolveGitExecutableMemoized;

  return async (request: GitCloneRequest): Promise<GitCloneOutcome> => {
    if (request.signal.aborted) return { ok: false, reason: "cancelled", stderrTail: "" };
    const env = cloneEnvironment();
    let binary: string;
    try {
      binary = await resolveGit(gitBinary, request.cwd, env, request.signal);
    } catch (error) {
      if (request.signal.aborted) return { ok: false, reason: "cancelled", stderrTail: "" };
      return { ok: false, reason: "spawn-failed", stderrTail: error instanceof Error ? error.message : "" };
    }
    if (request.signal.aborted) return { ok: false, reason: "cancelled", stderrTail: "" };

    return new Promise<GitCloneOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, gitCloneArguments(request.url, request.destination, options.extraConfig), {
          cwd: request.cwd,
          // A new session has no controlling terminal, so ssh cannot prompt either.
          detached: process.platform !== "win32",
          env,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        resolve({ ok: false, reason: "spawn-failed", stderrTail: error instanceof Error ? error.message : "" });
        return;
      }

      let tail = "";
      let pending = "";
      let termination: "cancelled" | "timeout" | undefined;
      let settled = false;
      const terminator = createProcessGroupTerminator(child, { killGraceMs: KILL_GRACE_MS });
      let lastPhase: string | undefined;
      let lastPercent: number | undefined;
      let lastEmit = 0;

      const emit = (line: string) => {
        const progress = parseGitCloneProgress(line);
        if (!progress) return;
        const now = Date.now();
        const phaseChanged = progress.phase !== lastPhase;
        const finished = progress.percent === 100 && lastPercent !== 100;
        if (!phaseChanged && !finished) {
          if (progress.percent === lastPercent || now - lastEmit < PROGRESS_INTERVAL_MS) return;
        }
        lastPhase = progress.phase;
        lastPercent = progress.percent;
        lastEmit = now;
        try {
          request.onProgress(progress);
        } catch {
          // A closed document must not stop the clone.
        }
      };

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
        pending = (pending + chunk).slice(-STDERR_TAIL_BYTES);
        const parts = pending.split(/[\r\n]/u);
        pending = parts.pop() ?? "";
        for (const part of parts) if (part) emit(part);
      });

      const terminate = (reason: "cancelled" | "timeout") => {
        if (termination || settled) return;
        termination = reason;
        terminator.terminate();
      };
      const abort = () => terminate("cancelled");
      request.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
      timeout.unref();

      const finish = (outcome: GitCloneOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
        // A stopped clone's helpers can outlive git itself; the caller removes the
        // partial destination only after the whole group is gone.
        void terminator.finished().then(() => resolve(outcome));
      };

      child.once("error", (error) => {
        finish({ ok: false, reason: "spawn-failed", stderrTail: `${tail}\n${error.message}` });
      });
      child.once("close", (code) => {
        if (termination) {
          finish({ ok: false, reason: termination, stderrTail: tail });
          return;
        }
        finish(code === 0 ? { ok: true } : { ok: false, reason: "exit", stderrTail: tail });
      });
    });
  };
}
