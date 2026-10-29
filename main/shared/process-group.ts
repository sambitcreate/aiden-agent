// Lifecycle helpers for children spawned with `detached: true`, which makes each
// child the leader of its own process group. Stopping the group, not just the
// leader, also stops the shell's background jobs, Git's helpers and a script's
// children. Windows has no process groups; there only the child is signalled.

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 25;

/** Whether any process is still in the group led by `pid`. Always false on Windows. */
export function processGroupExists(pid: number | undefined): boolean {
  if (process.platform === "win32" || !pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM still means a member exists.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Signals the child's whole process group, falling back to the child itself. Never throws. */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone or not ours; fall back to the child handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process has already exited.
  }
}

export interface ProcessGroupTerminator {
  /** SIGTERM to the group now, SIGKILL after the grace period to anything left. Idempotent. */
  terminate(): void;
  readonly requested: boolean;
  /**
   * Settles when a requested termination is over: the group is gone or SIGKILL
   * was sent. Settles at once when none was requested. The leader closing does
   * not end it, because descendants that ignore SIGTERM can outlive the leader.
   */
  finished(): Promise<void>;
}

export function createProcessGroupTerminator(
  child: ChildProcess,
  options: { killGraceMs: number },
): ProcessGroupTerminator {
  let requested = false;
  let done: Promise<void> = Promise.resolve();
  const alive = () =>
    process.platform === "win32"
      ? child.exitCode === null && child.signalCode === null
      : processGroupExists(child.pid);
  return {
    get requested() {
      return requested;
    },
    terminate() {
      if (requested) return;
      requested = true;
      signalProcessGroup(child, "SIGTERM");
      if (!child.pid) return;
      done = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (alive()) return;
          clearInterval(poll);
          clearTimeout(kill);
          resolve();
        }, POLL_MS);
        const kill = setTimeout(() => {
          clearInterval(poll);
          // Checked first so a group that already ended is not signalled. A new
          // group could still reuse the ID in the moment between check and kill.
          if (alive()) signalProcessGroup(child, "SIGKILL");
          resolve();
        }, options.killGraceMs);
      });
    },
    finished() {
      return done;
    },
  };
}

export interface ChildCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the leader exited but its pipes were still held after the drain window. */
  pipesHeld: boolean;
}

/**
 * Settles with the leader's exit once its stdio closes. If a descendant keeps a
 * pipe open after the leader exited (a background job or daemon that inherited
 * stdout), it settles `drainMs` after the exit instead: `onPipesHeld` runs first
 * (callers stop the group there) and the pipes are destroyed, so the wait is
 * bounded. Rejects with the child's `error` event.
 */
export function waitForChildExit(
  child: ChildProcess,
  options: { drainMs: number; onPipesHeld?: () => void },
): Promise<ChildCompletion> {
  return new Promise<ChildCompletion>((resolve, reject) => {
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(drain);
      finish();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) => {
      drain = setTimeout(() => {
        options.onPipesHeld?.();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(() => resolve({ code, signal, pipesHeld: true }));
      }, options.drainMs);
    });
    child.once("close", (code, signal) => settle(() => resolve({ code, signal, pipesHeld: false })));
  });
}

/**
 * Decodes output that a byte cap may have cut mid-character. A trailing partial
 * UTF-8 sequence is dropped instead of becoming U+FFFD; complete output decodes
 * exactly as `Buffer#toString("utf8")` would.
 */
export function decodeCappedUtf8(bytes: Buffer, truncated: boolean): string {
  return truncated ? new StringDecoder("utf8").write(bytes) : bytes.toString("utf8");
}
