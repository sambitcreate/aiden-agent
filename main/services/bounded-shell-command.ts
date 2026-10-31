import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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
}

/**
 * How long output may keep arriving after the shell exits. Past this, whatever
 * the command left running in the background still holds the output pipes.
 */
export const BOUNDED_SHELL_DRAIN_MS = 250;

/**
 * Runs one shell command in its own process group with a deadline and an
 * output cap. A timeout, the cap or an abort stops the whole group: SIGTERM
 * first, SIGKILL a second later for anything still running. Used by
 * `run_command`, hooks, and workspace artifact sources and buttons.
 *
 * The command is finished when its shell exits, not when every process that
 * inherited its output does: after a short drain for the last output, anything
 * it left running in the background that still holds the pipes (`sleep 30 &`)
 * is stopped, so a backgrounded child can't hold the caller to the deadline.
 */
export function runBoundedShellCommand(options: BoundedShellCommandOptions): Promise<BoundedShellCommandResult> {
  const { signal } = options;
  if (signal?.aborted) {
    // Cancelled before it started: nothing runs.
    return Promise.resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, outputLimitExceeded: false, aborted: true });
  }
  return new Promise<BoundedShellCommandResult>((resolve, reject) => {
    // stdout and stderr are always pipes; stdin is a pipe only when there is input.
    const child = spawn(options.command, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    if (options.input !== undefined && child.stdin) {
      // A command may exit without reading its input; a broken pipe is not an error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
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
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
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
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      signal?.removeEventListener("abort", abort);
      if (finishTermination && !processGroupExists()) {
        clearTimeout(forceKill);
        finishTermination();
        finishTermination = undefined;
      }
      void (async () => {
        await terminationCleanup;
        resolve({
          stdout: Buffer.concat(stdout).toString("utf-8"),
          stderr: Buffer.concat(stderr).toString("utf-8"),
          exitCode,
          timedOut,
          outputLimitExceeded,
          aborted,
        });
      })();
    };
    const stopReading = (exitCode: number | null) => {
      child.stdout.destroy();
      child.stderr.destroy();
      finish(exitCode);
    };
    child.once("exit", (exitCode) => {
      drain = setTimeout(() => {
        if (settled) return;
        if (!processGroupExists()) {
          // Nothing of the command is left, so the pipes are only draining
          // (a slow machine) or held outside the group (`setsid`); allow a
          // little longer before giving up on them.
          drain = setTimeout(() => stopReading(exitCode), 1_000);
          return;
        }
        // The shell is gone but something it started still holds stdout or
        // stderr. Stop the rest of the group and stop reading.
        signalProcess("SIGTERM");
        setTimeout(() => {
          if (processGroupExists()) signalProcess("SIGKILL");
        }, 1_000).unref?.();
        stopReading(exitCode);
      }, BOUNDED_SHELL_DRAIN_MS);
    });
    child.once("close", (exitCode) => finish(exitCode));
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref?.();
  });
}
