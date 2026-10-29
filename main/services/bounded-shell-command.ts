import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface BoundedShellCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Combined stdout and stderr bytes kept; more stops the command. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /**
   * When the shell has exited but processes it started still hold its output
   * open (`npm run dev &`), return this long after the exit with
   * `leftoverProcessGroup` and the open streams instead of waiting for the
   * deadline. Without it the command waits, and the deadline stops the group.
   */
  releaseLeftoversAfterMs?: number;
}

export interface BoundedShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted: boolean;
  /**
   * The shell exited on its own but processes it started are still in its
   * process group (a server started with a trailing `&`). Nothing stops them;
   * the caller decides whether to track them.
   */
  leftoverProcessGroup?: number;
  /**
   * With `releaseLeftoversAfterMs`: the output the leftovers still write to.
   * The caller must keep reading (or resume) both, or the leftovers block.
   */
  leftoverOutput?: { stdout: Readable; stderr: Readable };
}

/**
 * Runs one shell command in its own process group with a deadline and an
 * output cap. A timeout, the cap or an abort stops the whole group: SIGTERM
 * first, SIGKILL a second later for anything still running. Used by
 * `run_command` and by workspace artifact sources and buttons.
 */
export function runBoundedShellCommand(options: BoundedShellCommandOptions): Promise<BoundedShellCommandResult> {
  const { signal } = options;
  if (signal?.aborted) {
    // Cancelled before it started: nothing runs.
    return Promise.resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, outputLimitExceeded: false, aborted: true });
  }
  return new Promise<BoundedShellCommandResult>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let aborted = false;
    let settled = false;
    let terminationRequested = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let finishTermination: (() => void) | undefined;
    let terminationCleanup: Promise<void> | undefined;

    const processGroupExists = () => {
      if (process.platform === "win32" || !child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const signalProcess = (processSignal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, processSignal);
          return;
        } catch {
          // The process group may have exited; fall back to the child handle.
        }
      }
      child.kill(processSignal);
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      signalProcess("SIGTERM");
      if (!child.pid) return;
      terminationCleanup = new Promise<void>((resolve) => {
        finishTermination = resolve;
        forceKill = setTimeout(() => {
          // The shell can close before its descendants leave the process group.
          // Keep this timer owned by the group, independent of shell settlement.
          signalProcess("SIGKILL");
          finishTermination?.();
          finishTermination = undefined;
        }, 1_000);
      });
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, options.maxOutputBytes - bytes);
      if (remaining > 0) target.push(value.subarray(0, remaining));
      bytes += value.length;
      if (bytes > options.maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate();
      }
    };
    const captureStdout = capture(stdout);
    const captureStderr = capture(stderr);
    child.stdout.on("data", captureStdout);
    child.stderr.on("data", captureStderr);
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.releaseLeftoversAfterMs !== undefined && process.platform !== "win32") {
      const releaseAfter = options.releaseLeftoversAfterMs;
      child.once("exit", (exitCode) => {
        releaseTimer = setTimeout(() => {
          if (settled || terminationRequested || !child.pid || !processGroupExists()) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          child.stdout.off("data", captureStdout);
          child.stderr.off("data", captureStderr);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf-8"),
            stderr: Buffer.concat(stderr).toString("utf-8"),
            exitCode,
            timedOut,
            outputLimitExceeded,
            aborted,
            leftoverProcessGroup: child.pid,
            leftoverOutput: { stdout: child.stdout, stderr: child.stderr },
          });
        }, releaseAfter);
        releaseTimer.unref?.();
      });
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      void (async () => {
        await terminationCleanup;
        reject(error);
      })();
    });
    child.once("close", (exitCode) => {
      if (releaseTimer) clearTimeout(releaseTimer);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (finishTermination && !processGroupExists()) {
        clearTimeout(forceKill);
        finishTermination();
        finishTermination = undefined;
      }
      const leftoverProcessGroup = !terminationRequested && child.pid && processGroupExists() ? child.pid : undefined;
      void (async () => {
        await terminationCleanup;
        resolve({
          ...(leftoverProcessGroup !== undefined ? { leftoverProcessGroup } : {}),
          stdout: Buffer.concat(stdout).toString("utf-8"),
          stderr: Buffer.concat(stderr).toString("utf-8"),
          exitCode,
          timedOut,
          outputLimitExceeded,
          aborted,
        });
      })();
    });
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref?.();
  });
}
