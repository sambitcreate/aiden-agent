/**
 * Background lifecycle for `aiden serve`: detached spawn with stdio redirected
 * to <agentDir>/serve.log, readiness polled on the control socket, and stop/status
 * driven by the serve lease's owner.json PID (state.ts acquireLease).
 *
 * The same `serve.lock` is also taken briefly by one-shot `schedule`/`workspace`
 * commands when the daemon is down, so PID verification distinguishes three
 * cases for legacy metadata — our daemon (`<entry> serve`), another live Aiden
 * process holding the lock legitimately, and a recycled foreign PID. Newer
 * metadata is stale whenever its OS guard is free, even if the PID was reused.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join, relative, resolve } from "node:path";
import { daemonSocket } from "./daemon-control.ts";
import { acquireLease, atomicJson, cliLeaseHelperPath, leaseGuardPath, readJson } from "./state.ts";
import { tryAcquireProcessLifetimeLock } from "../../../main/services/process-lifetime-lock.ts";
import { watchMcpProcessGroups } from "../../../main/services/mcp-stdio-transport.js";

const SERVE_LOCK = "serve.lock";
const SERVE_LOG = "serve.log";
const START_LOCK = "serve-start";
const MCP_GROUPS = "mcp-groups.json";

interface ServeOwner {
  protocol?: string;
  pid?: number;
  /** Recorded by acquireLease — the owner's own argv, verbatim. */
  argv?: unknown;
  startedAt?: number;
  token?: string;
  /** Set only by a daemon that startDaemon spawned in its own process group. */
  detached?: unknown;
}

/** Tells a `serve` child that startDaemon spawned it detached. */
export const DETACHED_SERVE_ENV = "AIDEN_SERVE_DETACHED";

function processGroupId(pid: number): number | undefined {
  try {
    const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    const pgid = out.status === 0 ? Number(out.stdout.trim()) : NaN;
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch { return undefined; }
}

/**
 * Publishes the serving process's live stdio MCP process groups beside its lease
 * owner. Each server leads its own group, outside the daemon's, and a SIGKILL
 * skips the daemon's own cleanup, so a forced `serve stop` ends them from here.
 * Stop recording before releasing the lease.
 */
export function recordServeMcpGroups(agentDir: string): () => void {
  const lock = join(agentDir, SERVE_LOCK);
  return watchMcpProcessGroups((groups) => {
    // Never recreate a lease directory that was already released.
    if (!existsSync(lock)) return;
    try { atomicJson(join(lock, MCP_GROUPS), { pid: process.pid, groups }); } catch { /* best effort */ }
  });
}

/**
 * The recorded MCP groups of daemon `pid` that still have a member the daemon
 * spawned, read before the daemon dies and its children are reparented. A group
 * id with no such member may have been reused, so it is never signalled.
 */
function daemonMcpGroups(agentDir: string, pid: number): number[] {
  let recorded: { pid?: unknown; groups?: unknown } | undefined;
  try { recorded = readJson<{ pid?: unknown; groups?: unknown } | undefined>(join(agentDir, SERVE_LOCK, MCP_GROUPS), undefined); } catch { return []; }
  if (recorded?.pid !== pid || !Array.isArray(recorded.groups)) return [];
  const wanted = new Set(recorded.groups.filter((group): group is number => validPid(group) && group !== pid));
  if (!wanted.size) return [];
  const owned = new Set<number>();
  try {
    const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
    if (out.status !== 0) return [];
    for (const line of out.stdout.split("\n")) {
      const [, ppid, pgid] = line.trim().split(/\s+/u).map(Number);
      if (ppid === pid && pgid !== undefined && wanted.has(pgid)) owned.add(pgid);
    }
  } catch { return []; }
  return [...owned];
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

function sameOwner(current: ServeOwner | undefined, expected: ServeOwner): boolean {
  return current?.pid === expected.pid && current?.startedAt === expected.startedAt &&
    current?.token === expected.token && current?.protocol === expected.protocol;
}

/** Cleanup owns the same permanent guard as the daemon. Re-evaluate after taking it. */
function clearServeArtifacts(agentDir: string, expected?: ServeOwner): boolean {
  const lock = join(agentDir, SERVE_LOCK);
  const release = tryAcquireProcessLifetimeLock(leaseGuardPath(join(agentDir, "serve")), cliLeaseHelperPath());
  if (!release) return false;
  try {
    const current = serveOwner(agentDir);
    if (expected && !sameOwner(current, expected)) return false;
    if (current && current.protocol !== "flock-v1" && validPid(current.pid) && pidAlive(current.pid) && classifyPid(current.pid, current) !== "foreign") return false;
    if (!existsSync(lock)) return false;
    rmSync(lock, { recursive: true, force: true });
    rmSync(daemonSocket(agentDir), { force: true });
    return true;
  } finally { release(); }
}

/**
 * Drop a serve lock left behind by a killed daemon or a crashed one-shot
 * command. The guard decides for new metadata; legacy metadata also requires
 * a dead owner or a verifiably recycled foreign PID.
 */
export function recoverStaleServeLease(agentDir: string): boolean {
  const lock = join(agentDir, SERVE_LOCK);
  if (!existsSync(lock)) return false;
  return clearServeArtifacts(agentDir);
}

export function daemonStatus(agentDir: string): { running: boolean; pid?: number; startedAt?: number; socket: string; log: string } {
  recoverStaleServeLease(agentDir);
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
    if (existsSync(socket) && serveOwner(agentDir)?.pid === child.pid && await new Promise<boolean>((resolveReady) => {
      const connection = createConnection(socket);
      const timer = setTimeout(() => { connection.destroy(); resolveReady(false); }, 250);
      connection.once("connect", () => { clearTimeout(timer); connection.destroy(); resolveReady(true); });
      connection.once("error", () => { clearTimeout(timer); resolveReady(false); });
    })) return;
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

/**
 * Spawn `aiden serve` detached and wait for its control socket. Remote is on
 * unless `remote` is false; the child never opens a startup pairing window.
 */
export async function startDaemon(agentDir: string, options: { remote?: boolean; timeoutMs?: number } = {}): Promise<{ pid: number; log: string }> {
  // The control socket is a filesystem path — on Windows it becomes a named
  // pipe with no file, so readiness polling and PID classification cannot work.
  if (process.platform === "win32") {
    throw new Error("`aiden serve --daemon` is not supported on Windows; run `aiden serve` in the foreground instead.");
  }
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const releaseStart = acquireStartLease(agentDir);
  try {
    recoverStaleServeLease(agentDir);
    if (daemonStatus(agentDir).running) throw new Error("The Aiden daemon is already running.");
    // The child removes a leftover socket after it acquires the serve lease.
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
        ...(options.remote === false ? ["--no-remote"] : []),
        "--no-pair",
      ], { detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, [DETACHED_SERVE_ENV]: "1" } });
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
    // waitForSocket returns only once the child recorded itself as the serve owner,
    // so a foreground `serve` that won the lease first has already failed the start.
    return { pid: childPid, log };
  } finally {
    releaseStart();
  }
}

/**
 * SIGTERM the daemon recorded in the serve lease and wait for it to release.
 * Graceful shutdown cancels every turn first, so a daemon still running after
 * the wait is stuck: it is then SIGKILLed, with its process group when
 * startDaemon spawned it detached, and with its recorded stdio MCP server groups.
 */
export async function stopDaemon(agentDir: string, timeoutMs = 15_000): Promise<{ stopped: boolean; pid?: number; forced?: true }> {
  recoverStaleServeLease(agentDir);
  const owner = serveOwner(agentDir);
  if (!owner || !validPid(owner.pid)) {
    recoverStaleServeLease(agentDir);
    throw new Error("The Aiden daemon is not running.");
  }
  const pid = owner.pid;
  if (!pidAlive(pid)) {
    clearServeArtifacts(agentDir, owner);
    throw new Error(`The Aiden daemon was not running; cleared the stale lock left by PID ${pid}.`);
  }
  const klass = classifyPid(pid, owner);
  if (klass === "foreign") {
    // The PID was recycled by an unrelated process — never signal it.
    clearServeArtifacts(agentDir, owner);
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
      clearServeArtifacts(agentDir, owner);
      return { stopped: true, pid };
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    if (!existsSync(join(agentDir, SERVE_LOCK)) && !existsSync(daemonSocket(agentDir))) return { stopped: true, pid };
    if (!sameOwner(serveOwner(agentDir), owner)) return { stopped: true, pid };
    if (!pidAlive(pid) || (polls % 10 === 9 && classifyPid(pid, owner) === "foreign")) {
      clearServeArtifacts(agentDir, owner);
      return { stopped: true, pid };
    }
    polls += 1;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  // Re-verify the PID before the forced kill: it must still be this daemon.
  if (pidAlive(pid) && classifyPid(pid, owner) === "daemon") {
    // A background daemon leads its own process group; killing the group also
    // takes its Remote advertiser instead of orphaning it. A foreground serve
    // shares its group with the shell job (`aiden serve | tee`), so only the
    // serve process itself is killed. Either way its stdio MCP servers each lead
    // a group of their own, which the daemon recorded, and are killed as well.
    const mcpGroups = daemonMcpGroups(agentDir, pid);
    const ownGroup = owner.detached === true && processGroupId(pid) === pid;
    try { process.kill(ownGroup ? -pid : pid, "SIGKILL"); } catch { /* already gone */ }
    for (const group of mcpGroups) { try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ } }
    const killDeadline = Date.now() + 5_000;
    while (pidAlive(pid) && Date.now() < killDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!pidAlive(pid)) {
    clearServeArtifacts(agentDir, owner);
    return { stopped: true, pid, forced: true };
  }
  throw new Error(`The Aiden daemon (PID ${pid}) did not stop within ${Math.round(timeoutMs / 1000)}s — try kill -9 ${pid} and remove ${join(agentDir, SERVE_LOCK)}.`);
}
