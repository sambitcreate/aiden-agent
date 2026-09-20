import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const WORKTREE_SETUP_SCRIPT = path.join(".aiden", "worktree-setup.sh");
export const WORKTREE_SETUP_TIMEOUT_MS = 120_000;
export const WORKTREE_SETUP_OUTPUT_LIMIT = 64 * 1024;

const execFileAsync = promisify(execFile);

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
  try {
    await execFileAsync(scriptPath, [], {
      cwd: worktreePath,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        AIDEN_SOURCE_TREE_PATH: sourceTreePath,
        AIDEN_WORKTREE_PATH: worktreePath,
      },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: maxOutputBytes,
      signal,
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
    };
    if (signal?.aborted) {
      throw new WorktreeSetupError("io", "The worktree setup was aborted.", { cause: error });
    }
    if (nodeError.code === "ERR_OUT_OF_RANGE" || nodeError.code === "ENOBUFS") {
      throw new WorktreeSetupError(
        "output_limit",
        "The worktree setup script produced too much output.",
        { cause: error },
      );
    }
    if (nodeError.killed || nodeError.signal) {
      throw new WorktreeSetupError(
        "timeout",
        "The worktree setup script did not finish in time.",
        { cause: error },
      );
    }
    throw new WorktreeSetupError(
      "failed",
      "The worktree setup script did not complete successfully.",
      { cause: error },
    );
  }
}
