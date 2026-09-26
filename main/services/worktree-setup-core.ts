import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

export const WORKTREE_SETUP_SCRIPT = path.join(".aiden", "worktree-setup.sh");
export const WORKTREE_SETUP_TIMEOUT_MS = 120_000;
export const WORKTREE_SETUP_OUTPUT_LIMIT = 64 * 1024;

export class WorktreeSetupError extends Error {
  declare public readonly cause: unknown;
  constructor(
    public readonly failure: "missing" | "timeout" | "output_limit" | "failed" | "io",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "WorktreeSetupError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Resolve `.aiden/worktree-setup.sh` inside a checkout, or null when setup is
 * not applicable. The script must be a regular executable file contained in
 * the worktree — symlinks are never executed.
 */
export async function resolveWorktreeSetupScript(
  worktreePath: string,
): Promise<string | null> {
  const candidate = path.join(worktreePath, WORKTREE_SETUP_SCRIPT);
  let info;
  try {
    info = await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return null;
  if ((info.mode & 0o111) === 0) return null;
  const canonicalWorktree = await fs.realpath(worktreePath);
  const canonicalScript = await fs.realpath(candidate);
  if (!canonicalScript.startsWith(`${canonicalWorktree}${path.sep}`)) return null;
  return canonicalScript;
}

/**
 * Run the setup script with a deliberately minimal environment — never the
 * parent process environment. Only locale variables and the two Aiden path
 * variables are provided; credentials, tokens, and provider keys are absent.
 *
 * The script runs as the leader of its own process group. Whatever way it
 * ends — success, failure, timeout, output flood, or abort — the whole group
 * is killed before this function settles, so no descendant the script started
 * can keep writing into the worktree while the caller returns it or rolls the
 * creation back.
 */
export async function runWorktreeSetupScript(
  scriptPath: string,
  worktreePath: string,
  sourceTreePath: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? WORKTREE_SETUP_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? WORKTREE_SETUP_OUTPUT_LIMIT;
  if (signal?.aborted) {
    throw new WorktreeSetupError("io", "The worktree setup was aborted.");
  }
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(scriptPath, [], {
        cwd: worktreePath,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: process.env.LANG ?? "C.UTF-8",
          LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
          AIDEN_SOURCE_TREE_PATH: sourceTreePath,
          AIDEN_WORKTREE_PATH: worktreePath,
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new WorktreeSetupError("failed", "The worktree setup script could not be started.", {
          cause: error,
        }),
      );
      return;
    }
    let outputBytes = 0;
    let stopReason: "timeout" | "output_limit" | "aborted" | undefined;
    let settled = false;

    const killGroup = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch {
        // ESRCH: the whole group has already exited.
      }
    };
    const stop = (reason: NonNullable<typeof stopReason>) => {
      stopReason ??= reason;
      killGroup();
    };
    const onOutput = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) stop("output_limit");
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);

    const finish = (code: number | null, exitSignal: NodeJS.Signals | null, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Background descendants must never outlive the setup step, and they
      // must not keep the output pipes (and this promise) open.
      killGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (stopReason === "aborted") {
        reject(new WorktreeSetupError("io", "The worktree setup was aborted.", { cause }));
      } else if (stopReason === "output_limit") {
        reject(
          new WorktreeSetupError(
            "output_limit",
            "The worktree setup script produced too much output.",
            { cause },
          ),
        );
      } else if (stopReason === "timeout") {
        reject(
          new WorktreeSetupError("timeout", "The worktree setup script did not finish in time.", {
            cause,
          }),
        );
      } else if (code === 0 && exitSignal === null && cause === undefined) {
        resolve();
      } else {
        reject(
          new WorktreeSetupError(
            "failed",
            "The worktree setup script did not complete successfully.",
            { cause: cause ?? new Error(`exit code ${code ?? "none"}, signal ${exitSignal ?? "none"}`) },
          ),
        );
      }
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, exitSignal) => finish(code, exitSignal));
  });
}
