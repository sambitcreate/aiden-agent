import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Test-only liveness oracle for process-cleanup assertions. `kill(pid, 0)`
// succeeds for a zombie, and in a Linux PID namespace whose init does not reap
// orphans a correctly terminated descendant can stay a zombie indefinitely.
// These helpers count a process as running only while it still executes.

function linuxState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesised and may contain spaces or ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

function psState(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** True while `pid` exists and is not a zombie. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = process.platform === "linux" ? linuxState(pid) : psState(pid);
  if (state === undefined) return false;
  return !state.startsWith("Z");
}

/** True while some member of process group `pgid` exists and is not a zombie. */
export function processGroupRunning(pgid: number | undefined): boolean {
  if (!pgid) return false;
  let listing: string;
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  } catch {
    return false;
  }
  return listing.split("\n").some((line) => {
    const [, group, state] = line.trim().split(/\s+/u);
    return Number(group) === pgid && state !== undefined && !state.startsWith("Z");
  });
}
