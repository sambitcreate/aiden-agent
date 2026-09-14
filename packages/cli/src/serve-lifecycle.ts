/**
 * Background lifecycle for `aiden serve`: detached spawn with stdio redirected
 * to <agentDir>/serve.log, readiness polled on the control socket, and stop/status
 * driven by the serve lease's owner.json PID (state.ts acquireLease).
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { daemonSocket } from "./daemon-control.ts";
import { readJson } from "./state.ts";

const SERVE_LOCK = "serve.lock";
const SERVE_LOG = "serve.log";

interface ServeOwner {
  pid?: number;
  startedAt?: number;
}

function serveOwner(agentDir: string): ServeOwner | undefined {
  return readJson<ServeOwner | undefined>(join(agentDir, SERVE_LOCK, "owner.json"), undefined);
}

/** True when the PID refers to a live process (EPERM still means alive). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The daemon's command line, or undefined when the platform cannot report it. */
function daemonCommandLine(pid: number): string | undefined {
  try {
    const proc = `/proc/${pid}/cmdline`;
    if (existsSync(proc)) return readFileSync(proc, "utf8").replaceAll("\0", " ");
  } catch { /* fall through to ps */ }
  try {
    const out = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    if (out.status === 0 && out.stdout) return out.stdout;
  } catch { /* ps unavailable */ }
  return undefined;
}

/**
 * PID-reuse guard: a live recorded PID only counts as the daemon when its
 * command line can be inspected and shows our CLI entry running `serve`, or
 * when it cannot be inspected at all (preserve the old conservative behavior).
 */
function pidIsDaemon(pid: number, entry: string | undefined): boolean {
  const command = daemonCommandLine(pid);
  if (command === undefined || !entry) return true;
  return command.includes(entry) && /(^|\s)serve(\s|$)/u.test(command);
}

function cliEntry(): string | undefined {
  const entry = process.argv[1];
  return entry ? resolve(entry) : undefined;
}

/**
 * Drop a serve lock left behind by a killed daemon. Only removes it when the
 * recorded owner PID is verifiably dead — a live owner is never disturbed.
 */
export function recoverStaleServeLease(agentDir: string): boolean {
  const lock = join(agentDir, SERVE_LOCK);
  if (!existsSync(lock)) return false;
  const owner = serveOwner(agentDir);
  if (owner?.pid && pidAlive(owner.pid) && pidIsDaemon(owner.pid, cliEntry())) return false;
  rmSync(lock, { recursive: true, force: true });
  return true;
}

export function daemonStatus(agentDir: string): { running: boolean; pid?: number; startedAt?: number; socket: string; log: string } {
  const owner = serveOwner(agentDir);
  const socket = daemonSocket(agentDir);
  const running = !!owner?.pid && pidAlive(owner.pid) && pidIsDaemon(owner.pid, cliEntry()) && existsSync(socket);
  return {
    running,
    ...(owner?.pid ? { pid: owner.pid } : {}),
    ...(owner?.startedAt ? { startedAt: owner.startedAt } : {}),
    socket,
    log: join(agentDir, SERVE_LOG),
  };
}

async function waitForSocket(agentDir: string, child: { pid?: number; exitCode: number | null; once(event: "exit", listener: () => void): unknown }, timeoutMs: number): Promise<void> {
  const socket = daemonSocket(agentDir);
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited || child.exitCode !== null) {
      throw new Error(`The daemon exited during startup (code ${child.exitCode ?? "unknown"}). See ${join(agentDir, SERVE_LOG)}.`);
    }
    if (existsSync(socket)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`The daemon did not open its control socket within ${Math.round(timeoutMs / 1000)}s. See ${join(agentDir, SERVE_LOG)}.`);
}

/** Spawn `aiden serve [--remote]` detached and wait for its control socket. */
export async function startDaemon(agentDir: string, options: { remote?: boolean; timeoutMs?: number } = {}): Promise<{ pid: number; log: string }> {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (daemonStatus(agentDir).running) throw new Error("The Aiden daemon is already running.");
  recoverStaleServeLease(agentDir);
  // A leftover socket would satisfy the readiness check before the child boots.
  rmSync(daemonSocket(agentDir), { force: true });
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine the Aiden CLI entry point for a background daemon.");
  const log = join(agentDir, SERVE_LOG);
  const logFd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [
    ...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []),
    resolve(entry),
    "serve",
    ...(options.remote ? ["--remote"] : []),
  ], { detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error("The daemon process could not be started.");
  await waitForSocket(agentDir, child, options.timeoutMs ?? 20_000);
  return { pid: child.pid, log };
}

/** SIGTERM the daemon recorded in the serve lease and wait for it to release. */
export async function stopDaemon(agentDir: string, timeoutMs = 15_000): Promise<{ stopped: boolean; pid?: number }> {
  const owner = serveOwner(agentDir);
  if (!owner?.pid) {
    recoverStaleServeLease(agentDir);
    throw new Error("The Aiden daemon is not running.");
  }
  if (!pidAlive(owner.pid) || !pidIsDaemon(owner.pid, cliEntry())) {
    // Dead owner, or the PID was recycled by an unrelated process — never
    // signal a process that is not verifiably ours; just clear the stale lock.
    rmSync(join(agentDir, SERVE_LOCK), { recursive: true, force: true });
    rmSync(daemonSocket(agentDir), { force: true });
    throw new Error(`The Aiden daemon was not running; cleared the stale lock left by PID ${owner.pid}.`);
  }
  process.kill(owner.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(join(agentDir, SERVE_LOCK)) && !existsSync(daemonSocket(agentDir))) return { stopped: true, pid: owner.pid };
    if (!pidAlive(owner.pid) || !pidIsDaemon(owner.pid, cliEntry())) {
      rmSync(join(agentDir, SERVE_LOCK), { recursive: true, force: true });
      rmSync(daemonSocket(agentDir), { force: true });
      return { stopped: true, pid: owner.pid };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`The Aiden daemon (PID ${owner.pid}) did not stop within ${Math.round(timeoutMs / 1000)}s.`);
}
