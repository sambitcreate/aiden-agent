// Lifecycle helpers for children spawned with `detached: true`, which makes each
// child the leader of its own process group. Stopping the group, not just the
// leader, also stops the shell's background jobs, Git's helpers and a script's
// children. Windows has no process groups; there only the child is signalled.

import { execFile, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 25;
// Slower than POLL_MS: each look past a lingering group runs `ps`.
const STOP_POLL_MS = 100;
// SIGKILL is asynchronous and can be denied, so sending it proves nothing.
const KILL_CONFIRM_MS = 2_000;

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

/**
 * Whether anything in the group still runs. A group can outlive its work
 * as zombies nobody has reaped (a non-reaping init), and those need no
 * stopping. A lookup that fails says nothing either way, so it counts.
 */
export async function processGroupStillRuns(group: number): Promise<boolean> {
  if (!processGroupExists(group)) return false;
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pgid=,stat="], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== "string") return resolve(true);
      resolve(
        stdout.split("\n").some((line) => {
          const [pgid, stat] = line.trim().split(/\s+/u);
          return Number(pgid) === group && Boolean(stat) && !stat!.startsWith("Z");
        }),
      );
    });
  });
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

export interface ProcessGroupProbe {
  exists(): boolean;
  stillRuns(): Promise<boolean>;
}

/**
 * Whether the group stopped within `ms`: it is gone, or only zombies remain,
 * which a non-reaping init may never clear. Every probe stays inside the
 * deadline, and one that does not answer in time counts as still running.
 */
export async function groupStoppedWithin(probe: ProcessGroupProbe, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!probe.exists()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runs = await Promise.race([
      probe.stillRuns(),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), remaining); }),
    ]);
    clearTimeout(timer);
    if (!runs) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(STOP_POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

export type ProcessGroupSettlement = "not_requested" | "exit_confirmed" | "cleanup_unconfirmed";

export interface ProcessGroupTerminator {
  /** SIGTERM to the group now, SIGKILL after the grace period to anything left. Idempotent. */
  terminate(): void;
  readonly requested: boolean;
  /**
   * Settles when a requested termination is over: the group is seen gone, or it
   * outlived the wait after SIGKILL and stays unconfirmed. Settles at once when
   * none was requested. The leader closing does not end it, because descendants
   * that ignore SIGTERM can outlive the leader.
   */
  finished(): Promise<ProcessGroupSettlement>;
}

export function createProcessGroupTerminator(
  child: ChildProcess,
  options: {
    killGraceMs: number;
    killConfirmMs?: number;
    probe?: ProcessGroupProbe;
  },
): ProcessGroupTerminator {
  let requested = false;
  let done: Promise<ProcessGroupSettlement> = Promise.resolve("not_requested");
  const alive = options.probe?.exists ?? (() =>
    process.platform === "win32"
      ? child.exitCode === null && child.signalCode === null
      : processGroupExists(child.pid));
  const stillRuns = options.probe?.stillRuns ?? (async () =>
    process.platform === "win32" ? alive() : processGroupStillRuns(child.pid!));
  const confirmKilled = async (): Promise<ProcessGroupSettlement> =>
    (await groupStoppedWithin({ exists: alive, stillRuns }, options.killConfirmMs ?? KILL_CONFIRM_MS))
      ? "exit_confirmed"
      : "cleanup_unconfirmed";
  return {
    get requested() {
      return requested;
    },
    terminate() {
      if (requested) return;
      requested = true;
      signalProcessGroup(child, "SIGTERM");
      if (!child.pid) {
        done = Promise.resolve("exit_confirmed");
        return;
      }
      done = new Promise<ProcessGroupSettlement>((resolve) => {
        const poll = setInterval(() => {
          if (alive()) return;
          clearInterval(poll);
          clearTimeout(kill);
          resolve("exit_confirmed");
        }, POLL_MS);
        const kill = setTimeout(() => {
          clearInterval(poll);
          // Checked first so a group that already ended is not signalled. A new
          // group could still reuse the ID in the moment between check and kill.
          if (!alive()) return resolve("exit_confirmed");
          signalProcessGroup(child, "SIGKILL");
          resolve(confirmKilled());
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
