// Lifecycle helpers for children spawned with `detached: true`, which makes each
// child the leader of its own process group. Stopping the group, not just the
// leader, also stops the shell's background jobs, Git's helpers and a script's
// children. Windows has no process groups; there only the child is signalled.

import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 25;
// Slower than POLL_MS: each look past a lingering group runs `ps`.
const STOP_POLL_MS = 100;
// SIGKILL is asynchronous and can be denied, so sending it proves nothing.
const KILL_CONFIRM_MS = 2_000;
// Small tolerance for 1-second `ps lstart` granularity / NTP clock jitter.
const LSTART_TOLERANCE_MS = 2_000;

export interface ProcessIncarnationSurvivor {
  pid: number;
  startId: string;
}

export interface ObservedProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  uid?: number;
  zombie: boolean;
  startId?: string;
}

function deterministicPsEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", TZ: "UTC" };
}

function readLinuxProcStartId(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    // Field 3 (state) is index 0 after `) `; field 22 (starttime in clock ticks since boot) is index 19.
    const fields = stat.slice(closeParen + 2).trim().split(" ");
    const starttime = fields[19];
    return starttime && /^\d+$/u.test(starttime) ? `proc:${starttime}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kernel-recorded process start identifier for `pid`: monotonic boot-tick
 * `starttime` on Linux (`/proc/<pid>/stat`), or UTC `ps lstart` on other POSIX
 * systems (macOS). Works even for Hardened Runtime / SIP binaries where
 * environment inspection is denied.
 */
export function readProcessStartId(pid: number): string | undefined {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const linuxStartId = readLinuxProcStartId(pid);
  if (linuxStartId) return linuxStartId;
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: deterministicPsEnv(),
      timeout: 2_000,
    });
    if (out.status !== 0) return undefined;
    const trimmed = out.stdout.trim().replace(/\s+/gu, " ");
    return trimmed ? `lstart:${trimmed}` : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `candidateStartId` is at least as recent as `leaderStartId`. */
export function startIdNotOlderThan(
  candidateStartId: string | undefined,
  leaderStartId: string | undefined,
): boolean {
  if (!candidateStartId || !leaderStartId) return true;
  if (candidateStartId.startsWith("proc:") && leaderStartId.startsWith("proc:")) {
    try {
      return BigInt(candidateStartId.slice(5)) >= BigInt(leaderStartId.slice(5));
    } catch {
      return true;
    }
  }
  if (candidateStartId.startsWith("lstart:") && leaderStartId.startsWith("lstart:")) {
    const candidateMs = Date.parse(`${candidateStartId.slice(7)} UTC`);
    const leaderMs = Date.parse(`${leaderStartId.slice(7)} UTC`);
    if (Number.isFinite(candidateMs) && Number.isFinite(leaderMs)) {
      return candidateMs >= leaderMs - LSTART_TOLERANCE_MS;
    }
  }
  return true;
}

/**
 * Lists live and zombie POSIX processes with their start identifiers. On Linux,
 * processes in `exactStartIdForPgids` use monotonic `/proc/<pid>/stat` ticks so
 * they match `readProcessStartId()` even across same-second spawns or clock shifts.
 */
export function listObservedProcesses(
  options: { exactStartIdForPgids?: ReadonlySet<number> } = {},
): ObservedProcessEntry[] | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart="], {
      encoding: "utf8",
      env: deterministicPsEnv(),
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (out.status !== 0) return undefined;
    const processes: ObservedProcessEntry[] = [];
    for (const line of out.stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
      if (!match) continue;
      const procPid = Number(match[1]);
      const ppid = Number(match[2]);
      const pgid = Number(match[3]);
      const uid = Number(match[4]);
      const stat = match[5] ?? "";
      const lstart = (match[6] ?? "").trim().replace(/\s+/gu, " ");
      if (!Number.isSafeInteger(procPid) || procPid <= 0 || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pgid <= 0) {
        continue;
      }
      const lstartId = lstart ? `lstart:${lstart}` : undefined;
      const startId = options.exactStartIdForPgids?.has(pgid)
        ? (readLinuxProcStartId(procPid) ?? lstartId)
        : lstartId;
      processes.push({
        pid: procPid,
        ppid,
        pgid,
        ...(Number.isSafeInteger(uid) ? { uid } : {}),
        zombie: stat.startsWith("Z"),
        ...(startId ? { startId } : {}),
      });
    }
    return processes;
  } catch {
    return undefined;
  }
}

/**
 * Snapshots surviving non-zombie members of `pgid` right after our group leader
 * exited and was reaped. If `pid === pgid` already exists in the process table,
 * the PID was already reused and nothing is captured.
 */
export function captureProcessGroupSurvivors(
  pgid: number,
  leaderStartId?: string,
): ProcessIncarnationSurvivor[] {
  if (process.platform === "win32" || !Number.isSafeInteger(pgid) || pgid <= 0 || !processGroupExists(pgid)) {
    return [];
  }
  const processes = listObservedProcesses({ exactStartIdForPgids: new Set([pgid]) });
  if (!processes) return [];
  // Our leader was just reaped, so any process holding `pid === pgid` now is a reused PID.
  if (processes.some((proc) => proc.pid === pgid)) return [];
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const survivors: ProcessIncarnationSurvivor[] = [];
  for (const proc of processes) {
    if (proc.pgid !== pgid || proc.pid === pgid || proc.zombie) continue;
    if (currentUid !== undefined && proc.uid !== currentUid) continue;
    if (!proc.startId || !startIdNotOlderThan(proc.startId, leaderStartId)) continue;
    survivors.push({ pid: proc.pid, startId: proc.startId });
  }
  return survivors;
}

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
