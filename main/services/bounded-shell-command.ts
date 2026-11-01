import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createProcessGroupTerminator, decodeCappedUtf8, waitForChildExit } from "../shared/process-group.js";

export interface BoundedShellCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Combined stdout and stderr bytes kept; more stops the command. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Written to the command's stdin, which is then closed. Without it stdin is ignored. */
  input?: string;
}

export interface BoundedShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
  /**
   * True when the shell exited but something it started still held the output
   * pipe after the drain window, so that process group was stopped.
   */
  backgroundStopped: boolean;
}

// SIGTERM first; anything still in the group a second later gets SIGKILL.
const KILL_GRACE_MS = 1_000;
// A background job that inherited stdout keeps the pipe open after the shell
// exits. Give remaining output this long to arrive, then stop the group.
const PIPE_DRAIN_MS = 1_000;

/**
 * Runs one shell command in its own process group with a deadline and an
 * output cap. A timeout, the cap or an abort stops the whole group: SIGTERM
 * first, SIGKILL a second later for anything still running. The result waits
 * for that cleanup. When the shell exits but a background job still holds its
 * output pipe, the command settles after a short drain and the group is
 * stopped, instead of waiting for the job or the timeout. Used by
 * `run_command`, hooks, and workspace artifact sources and buttons.
 */
export async function runBoundedShellCommand(options: BoundedShellCommandOptions): Promise<BoundedShellCommandResult> {
  const { signal } = options;
  if (signal?.aborted) {
    // Cancelled before it started: nothing runs.
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, outputLimitExceeded: false, aborted: true, backgroundStopped: false };
  }
  const child = spawn(options.command, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    shell: true,
    // stdout and stderr are always pipes; stdin is a pipe only when there is input.
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
  if (options.input !== undefined && child.stdin) {
    // A command may exit without reading its input; a broken pipe is not an error.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  }
  const terminator = createProcessGroupTerminator(child, { killGraceMs: KILL_GRACE_MS });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let aborted = false;

  const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, options.maxOutputBytes - bytes);
    if (remaining > 0) target.push(value.subarray(0, remaining));
    bytes += value.length;
    if (bytes > options.maxOutputBytes && !outputLimitExceeded) {
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
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminator.terminate();
  }, options.timeoutMs);
  timeout.unref?.();

  try {
    const { code, pipesHeld } = await waitForChildExit(child, {
      drainMs: PIPE_DRAIN_MS,
      onPipesHeld: () => terminator.terminate(),
    });
    return {
      stdout: decodeCappedUtf8(Buffer.concat(stdout), outputLimitExceeded),
      stderr: decodeCappedUtf8(Buffer.concat(stderr), outputLimitExceeded),
      exitCode: code,
      timedOut,
      outputLimitExceeded,
      aborted,
      // Only a group stopped because of the drain counts; a timeout, the cap or
      // an abort already explains itself.
      backgroundStopped: pipesHeld && !timedOut && !outputLimitExceeded && !aborted,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    // The shell can close before its descendants leave the process group.
    await terminator.finished();
  }
}
