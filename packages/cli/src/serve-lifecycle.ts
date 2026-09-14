/**
 * Background lifecycle for `aiden serve`: detached spawn with stdio redirected
 * to <agentDir>/serve.log, readiness polled on the control socket, and stop/status
 * driven by the serve lease's owner.json PID (state.ts acquireLease).
 *
 * The same `serve.lock` is also taken briefly by one-shot `schedule`/`workspace`
 * commands when the daemon is down, so PID verification distinguishes three
 * cases — our daemon (`<entry> serve`), another live Aiden process holding the
 * lock legitimately, and a recycled foreign PID — and only the last is cleared.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { daemonSocket } from "./daemon-control.ts";
import { acquireLease, readJson } from "./state.ts";

const SERVE_LOCK = "serve.lock";
const SERVE_LOG = "serve.log";
const START_LOCK = "serve-start";
/** A lock with no owner.json younger than this may still be mid-acquireLease. */
const FRESH_LOCK_MS = 2_000;

interface ServeOwner {
  pid?: number;
  /** Recorded by acquireLease — the owner's own argv, verbatim. */
  argv?: unknown;
  startedAt?: number;
}

function serveOwner(agentDir: string): ServeOwner | undefined {
  try {
    return readJson<ServeOwner | undefined>(join(agentDir, SERVE_LOCK, "owner.json"), undefined);
  } catch {
    // Corrupt owner.json is treated as a dead owner so recovery still works.
    return undefined;
  }
}

function validPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && (pid as number) > 0;
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

/** A process's command line, or undefined when the platform cannot report it. */
function processCommandLine(pid: number): string | undefined {
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

/** Every path spelling this CLI invocation might appear under in a cmdline. */
function cliEntryCandidates(): string[] {
  const candidates = new Set<string>();
  // cli.ts records the realpath'd entry for exactly this kind of identity
  // check; only trust it when it still names a real file (env is spoofable).
  const envEntry = process.env.AIDEN_CLI_ENTRY?.trim();
  if (envEntry && existsSync(envEntry)) candidates.add(envEntry);
  const argv1 = process.argv[1];
  if (argv1) {
    const resolved = resolve(argv1);
    candidates.add(resolved);
    try { candidates.add(realpathSync(resolved)); } catch { /* keep resolved */ }
    // A process launched with a relative entry (e.g. `node --test
    // tests/x.mjs`) shows the relative spelling in its cmdline.
    const relativeEntry = relative(process.cwd(), resolved);
    if (relativeEntry && !relativeEntry.startsWith("..") && relativeEntry !== resolved) {
      candidates.add(relativeEntry);
      try { candidates.add(relative(process.cwd(), realpathSync(resolved))); } catch { /* keep */ }
    }
  }
  return [...candidates];
}

type PidClass = "daemon" | "aiden" | "foreign" | "unknown";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Process names that may legitimately exec the CLI entry. */
const RUNTIME_ARGV0 = /(?:^|[/\\])(?:node(?:js)?|bun|deno|tsx|aiden(?:-cli)?)(?:\.exe)?$/iu;

/**
 * Classify the process behind a recorded PID:
 * - "daemon": cmdline shows `<entry> serve` (the exact argv startDaemon spawns).
 * - "aiden": cmdline shows the CLI entry with a different subcommand — a live,
 *   legitimate lease holder (e.g. a `schedule` fallback); never disturbed.
 * - "foreign": cmdline inspectable and is not our CLI at all — a recycled PID.
 * - "unknown": cmdline cannot be inspected on this platform.
 */
function classifyPid(pid: number, owner?: ServeOwner): PidClass {
  const command = processCommandLine(pid)?.trim();
  if (command === undefined) return "unknown";
  // Strongest check: acquireLease records the owner's argv, so matching the
  // recorded invocation verbatim identifies the owner regardless of how this
  // checker was launched (relative entries, symlinks, other working dirs,
  // or a different install of the CLI sharing the agent dir).
  const recorded = Array.isArray(owner?.argv)
    ? owner.argv.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  if (recorded && recorded.length >= 2) {
    const prefix = recorded.join(" ");
    if (command === prefix || command.startsWith(`${prefix} `)) {
      return recorded[2] === "serve" ? "daemon" : "aiden";
    }
    // The recorded owner's cmdline no longer matches — its PID was recycled;
    // classify the live process on its own merits below.
  }
  const candidates = cliEntryCandidates();
  if (candidates.length === 0) return "unknown";
  // Token-boundary matching only: `cli.js server`/`servex` are not the daemon,
  // and the entry must be argv0 or follow a JS-runtime argv0 — an editor that
  // happens to have `cli.js serve` among its arguments is not ours.
  const argv0 = command.split(/\s/, 1)[0] ?? "";
  const runtimeArgv0 = RUNTIME_ARGV0.test(argv0);
  const matches = (suffix: string): boolean => candidates.some((candidate) => {
    const found = command.match(new RegExp(`(?:^|\\s)${escapeRegExp(candidate)}${suffix}`));
    return !!found && (found.index === 0 || runtimeArgv0);
  });
  if (matches("\\s+serve(?:\\s|$)")) return "daemon";
  return matches("(?:\\s|$)") ? "aiden" : "foreign";
}

function clearServeArtifacts(agentDir: string): void {
  rmSync(join(agentDir, SERVE_LOCK), { recursive: true, force: true });
  rmSync(daemonSocket(agentDir), { force: true });
}

/**
 * Drop a serve lock left behind by a killed daemon or a crashed one-shot
 * command. Only reclaims when the recorded owner is dead or verifiably a
 * recycled foreign PID — a live Aiden process (daemon or command) and an
 * uninspectable owner are never disturbed.
 */
export function recoverStaleServeLease(agentDir: string): boolean {
  const lock = join(agentDir, SERVE_LOCK);
  if (!existsSync(lock)) return false;
  const owner = serveOwner(agentDir);
  if (!owner || !validPid(owner.pid)) {
    // Missing/corrupt owner.json: acquireLease creates the lock dir before
    // writing owner.json, so a very fresh lock may belong to a live acquirer.
    try {
      if (Date.now() - statSync(lock).mtimeMs < FRESH_LOCK_MS) return false;
    } catch { /* fall through */ }
    clearServeArtifacts(agentDir);
    return true;
  }
  if (!pidAlive(owner.pid) || classifyPid(owner.pid, owner) === "foreign") {
    // Recheck right before removing: an acquirer that won the lock between
    // our read and now must not have its fresh lease deleted (check-then-act).
    const current = serveOwner(agentDir);
    if (current && validPid(current.pid) && current.pid !== owner.pid) return false;
    clearServeArtifacts(agentDir);
    return true;
  }
  return false;
}

export function daemonStatus(agentDir: string): { running: boolean; pid?: number; startedAt?: number; socket: string; log: string } {
  const owner = serveOwner(agentDir);
  const socket = daemonSocket(agentDir);
  const klass = owner && validPid(owner.pid) && pidAlive(owner.pid)
    ? classifyPid(owner.pid, owner)
    : undefined;
  const running = !!klass && klass !== "foreign" && klass !== "aiden" && existsSync(socket);
  return {
    running,
    ...(owner?.pid ? { pid: owner.pid } : {}),
    ...(owner?.startedAt ? { startedAt: owner.startedAt } : {}),
    socket,
    log: join(agentDir, SERVE_LOG),
  };
}

async function waitForSocket(agentDir: string, child: Pick<ChildProcess, "pid" | "exitCode" | "once">, timeoutMs: number): Promise<void> {
  const socket = daemonSocket(agentDir);
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => { exited = true; });
  // A spawn 'error' without 'exit' must not burn the whole timeout.
  child.once("error", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited || child.exitCode !== null) {
      throw new Error(`The daemon exited during startup (code ${child.exitCode ?? "unknown"}). See ${join(agentDir, SERVE_LOG)}.`);
    }
    if (existsSync(socket)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`The daemon did not open its control socket within ${Math.round(timeoutMs / 1000)}s. See ${join(agentDir, SERVE_LOG)}.`);
}

/**
 * Serialize `serve --daemon` startups through a short-lived lease of their own
 * so two invocations cannot both pass the not-running check and spawn twice.
 * A crashed starter's lock is reclaimed by the same dead-PID rule as serve.lock.
 */
function acquireStartLease(agentDir: string): () => void {
  try {
    // acquireLease itself reclaims dead-owner and stale-debris locks; a throw
    // here means a live starter (or one inside its mid-acquire window).
    return acquireLease(join(agentDir, START_LOCK));
  } catch {
    throw new Error("Another daemon start is already in progress.");
  }
}

/** Spawn `aiden serve [--remote]` detached and wait for its control socket. */
export async function startDaemon(agentDir: string, options: { remote?: boolean; timeoutMs?: number } = {}): Promise<{ pid: number; log: string }> {
  // The control socket is a filesystem path — on Windows it becomes a named
  // pipe with no file, so readiness polling and PID classification cannot work.
  if (process.platform === "win32") {
    throw new Error("`aiden serve --daemon` is not supported on Windows; run `aiden serve` in the foreground instead.");
  }
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const releaseStart = acquireStartLease(agentDir);
  try {
    if (daemonStatus(agentDir).running) throw new Error("The Aiden daemon is already running.");
    recoverStaleServeLease(agentDir);
    // A leftover socket would satisfy the readiness check before the child boots.
    rmSync(daemonSocket(agentDir), { force: true });
    const entry = process.argv[1];
    if (!entry) throw new Error("Cannot determine the Aiden CLI entry point for a background daemon.");
    const log = join(agentDir, SERVE_LOG);
    const logFd = openSync(log, "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [
        ...(entry.endsWith(".ts") || entry.endsWith(".mts") ? ["--experimental-strip-types"] : []),
        resolve(entry),
        "serve",
        ...(options.remote ? ["--remote"] : []),
      ], { detached: true, stdio: ["ignore", logFd, logFd] });
    } catch (error) {
      closeSync(logFd);
      throw error;
    }
    closeSync(logFd);
    // Swallow late 'error' events so a spawn failure cannot crash the CLI.
    child.on("error", () => undefined);
    child.unref();
    if (!child.pid) throw new Error("The daemon process could not be started.");
    const childPid = child.pid;
    // The child is detached (its own process group) — signal the group so
    // early-spawned grandchildren (workers, MCP servers) are not orphaned.
    const killTree = (signal: "SIGTERM" | "SIGKILL"): void => {
      try { process.kill(-childPid, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    try {
      await waitForSocket(agentDir, child, options.timeoutMs ?? 20_000);
    } catch (error) {
      // Never leave a still-booting daemon orphaned after reporting failure.
      killTree("SIGTERM");
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      if (child.exitCode === null) killTree("SIGKILL");
      throw error;
    }
    // A foreground `serve` could have won the lease between our status check
    // and the child's acquire — the socket then belongs to the other process.
    // Only report our pid when the child actually recorded ownership.
    const owner = serveOwner(agentDir);
    if (!owner || owner.pid !== childPid) {
      killTree("SIGTERM");
      throw new Error("The Aiden daemon is already running.");
    }
    return { pid: childPid, log };
  } finally {
    releaseStart();
  }
}

/** SIGTERM the daemon recorded in the serve lease and wait for it to release. */
export async function stopDaemon(agentDir: string, timeoutMs = 15_000): Promise<{ stopped: boolean; pid?: number }> {
  const owner = serveOwner(agentDir);
  if (!owner || !validPid(owner.pid)) {
    recoverStaleServeLease(agentDir);
    throw new Error("The Aiden daemon is not running.");
  }
  const pid = owner.pid;
  if (!pidAlive(pid)) {
    clearServeArtifacts(agentDir);
    throw new Error(`The Aiden daemon was not running; cleared the stale lock left by PID ${pid}.`);
  }
  const klass = classifyPid(pid, owner);
  if (klass === "foreign") {
    // The PID was recycled by an unrelated process — never signal it.
    clearServeArtifacts(agentDir);
    throw new Error(`The Aiden daemon was not running; cleared the stale lock left by PID ${pid}.`);
  }
  if (klass === "aiden") {
    throw new Error(`PID ${pid} is a running Aiden command, not the daemon — its lock releases when the command exits.`);
  }
  if (klass === "unknown") {
    throw new Error(
      `Cannot verify that PID ${pid} is the Aiden daemon; refusing to signal it. ` +
      `If it is, run kill ${pid} and remove ${join(agentDir, SERVE_LOCK)}.`,
    );
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    // The daemon died between classification and the signal.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      clearServeArtifacts(agentDir);
      return { stopped: true, pid };
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    if (!existsSync(join(agentDir, SERVE_LOCK)) && !existsSync(daemonSocket(agentDir))) return { stopped: true, pid };
    if (!pidAlive(pid) || (polls % 10 === 9 && classifyPid(pid, owner) === "foreign")) {
      // Our daemon is gone; if the lease changed hands meanwhile, the new
      // owner is not ours to clear.
      const current = serveOwner(agentDir);
      if (!current || !validPid(current.pid) || current.pid === pid) clearServeArtifacts(agentDir);
      return { stopped: true, pid };
    }
    polls += 1;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`The Aiden daemon (PID ${pid}) did not stop within ${Math.round(timeoutMs / 1000)}s — try kill -9 ${pid} and remove ${join(agentDir, SERVE_LOCK)}.`);
}
