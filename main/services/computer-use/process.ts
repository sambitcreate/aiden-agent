import { spawn, type ChildProcess } from "node:child_process";
import type { CuaDriverInvocation } from "./contract.js";
import { CuaDriverError, isAbortError } from "./contract.js";

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const TERMINATE_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;

export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
}

function isChildReaped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildReaped(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildReaped(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (reaped: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener("exit", exited);
      child.removeListener("close", exited);
      resolve(reaped);
    };
    const exited = () => finish(true);
    const timer = setTimeout(() => finish(isChildReaped(child)), timeoutMs);
    timer.unref();
    child.once("exit", exited);
    child.once("close", exited);
  });
}

/**
 * Terminate a bridge or test broker that intentionally owns no same-process-
 * group descendants. Once the direct child is known reaped, never signal its
 * PID/PGID again: it may already have been reused by the OS.
 */
export async function terminateDirectChild(
  child: ChildProcess,
  options: { terminateGraceMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  const terminateGraceMs = options.terminateGraceMs ?? TERMINATE_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  if (!child.pid || isChildReaped(child)) return;
  let signalled = false;
  try {
    signalled = child.kill("SIGTERM");
  } catch {
    return;
  }
  if (!signalled || (await waitForChildReaped(child, terminateGraceMs))) return;
  // Recheck after the timer to close the exit-vs-escalation race.
  if (isChildReaped(child)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  await waitForChildReaped(child, killGraceMs);
}

function destroyChildStreams(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export async function runCuaDriverCommand(
  invocation: CuaDriverInvocation,
  args: string[],
  options: {
    env: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted)
    throw new CuaDriverError("cancelled", "cua-driver request was cancelled.");
  return new Promise<BoundedProcessResult>((resolve, reject) => {
    const child = spawn(invocation.command, [...(invocation.prefixArgs ?? []), ...args], {
      // These are fixed platform utilities (`open`, `codesign`, and `plutil`).
      // Keep an exact ChildProcess handle instead of creating a process group:
      // a delayed negative-PID signal could target an unrelated reused PGID.
      detached: false,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError: CuaDriverError | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let terminationPromise: Promise<void> | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    };
    const terminate = (error: CuaDriverError) => {
      if (terminationError) return;
      terminationError = error;
      terminationPromise = terminateDirectChild(child).then(
        () => {
          destroyChildStreams(child);
          finish(error);
        },
        () => {
          destroyChildStreams(child);
          finish(error);
        },
      );
    };
    const abort = () =>
      terminate(new CuaDriverError("cancelled", "cua-driver request was cancelled."));
    timeoutTimer = setTimeout(
      () => terminate(new CuaDriverError("timeout", "cua-driver did not respond in time.", true)),
      options.timeoutMs ?? 5_000,
    );

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", (error) => {
      if (terminationError) return;
      const code =
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "driver_missing" : "spawn_failed";
      finish(new CuaDriverError(code, "The pinned cua-driver helper is unavailable."));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminationError) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(new CuaDriverError("output_too_large", "cua-driver returned too much output."));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminationError) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate(
          new CuaDriverError("output_too_large", "cua-driver returned too much diagnostic output."),
        );
      } else {
        stderr.push(chunk);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      // Cancellation settles only after the exact direct child has been
      // supervised. Descendants are never inferred from a reusable PID/PGID.
      if (terminationError) void terminationPromise;
      else if (code === 0) finish();
      else {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim().slice(0, 600);
        finish(
          new CuaDriverError(
            "command_failed",
            `cua-driver exited ${signal ? `after ${signal}` : `with code ${String(code)}`}${diagnostic ? `: ${diagnostic}` : "."}`,
          ),
        );
      }
    });
  }).catch((error) => {
    if (error instanceof CuaDriverError || isAbortError(error)) throw error;
    throw new CuaDriverError("command_failed", "cua-driver command failed.");
  });
}
