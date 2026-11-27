// Which TCP ports a set of processes listen on, so a background job that runs
// a dev server can show its address. Linux reads /proc; macOS asks lsof for
// exactly those processes. Both are bounded and return nothing on failure.
// A socket Aiden itself holds is never counted: a child can inherit one of
// Aiden's listening sockets, and that address is Aiden's, not the job's.

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";

const LISTEN_STATE = "0A";
const LSOF_TIMEOUT_MS = 2_000;
/** File descriptors read per process; a server holds far fewer sockets. */
const MAX_FDS_PER_PROCESS = 4_096;

/** Listening sockets from a /proc/net/tcp or tcp6 table: socket inode → port. */
export function parseProcNetTcp(table: string): Map<string, number> {
  const listening = new Map<string, number>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
    const port = Number.parseInt(fields[1]!.split(":")[1] ?? "", 16);
    const inode = fields[9]!;
    if (Number.isInteger(port) && port > 0 && port < 65_536 && inode !== "0") listening.set(inode, port);
  }
  return listening;
}

/** Ports from `lsof -Fpn` output, by process: a `p<pid>` line, then one `n<address>:<port>` line per socket. */
export function parseLsofListening(output: string): Map<number, number[]> {
  const byProcess = new Map<number, number[]>();
  let ports: number[] | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      ports = Number.isSafeInteger(pid) ? (byProcess.get(pid) ?? []) : undefined;
      if (ports) byProcess.set(pid, ports);
      continue;
    }
    if (!line.startsWith("n") || !ports) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0 && port < 65_536) ports.push(port);
  }
  return byProcess;
}

/** The ports `pids` listen on, leaving out any port Aiden's own process (`self`) also listens on. */
export function portsOfProcesses(byProcess: ReadonlyMap<number, readonly number[]>, pids: readonly number[], self: number): number[] {
  const own = new Set(byProcess.get(self) ?? []);
  return pids.flatMap((pid) => (pid === self ? [] : (byProcess.get(pid) ?? []).filter((port) => !own.has(port))));
}

/** The socket inodes a process holds open. */
async function socketInodes(pid: number): Promise<string[]> {
  let fds: string[];
  try {
    fds = (await fsp.readdir(`/proc/${pid}/fd`)).slice(0, MAX_FDS_PER_PROCESS);
  } catch {
    return [];
  }
  const inodes: string[] = [];
  for (const fd of fds) {
    const target = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
    if (inode) inodes.push(inode);
  }
  return inodes;
}

async function linuxListeningPorts(pids: readonly number[]): Promise<Map<number, number[]>> {
  const byProcess = new Map<number, number[]>();
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => fsp.readFile(file, "utf8").catch(() => "")),
  );
  const listening = new Map<string, number>();
  for (const table of tables) for (const [inode, port] of parseProcNetTcp(table)) listening.set(inode, port);
  if (!listening.size) return byProcess;
  const own = new Set(await socketInodes(process.pid));
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const ports: number[] = [];
    for (const inode of await socketInodes(pid)) {
      const port = own.has(inode) ? undefined : listening.get(inode);
      if (port !== undefined) ports.push(port);
    }
    if (ports.length) byProcess.set(pid, ports);
  }
  return byProcess;
}

function macListeningPorts(pids: readonly number[]): Promise<Map<number, number[]>> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", [...pids, process.pid].join(","), "-Fpn"],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      // lsof exits 1 when nothing matched; its output is still what it found.
      (_error, stdout) => {
        if (typeof stdout !== "string") return resolve(new Map());
        const found = parseLsofListening(stdout);
        resolve(new Map(pids.map((pid) => [pid, portsOfProcesses(found, [pid], process.pid)])));
      },
    );
  });
}

/** The TCP ports each of these processes listens on, from one lookup for all of them. */
export async function defaultListeningPortsByProcess(pids: readonly number[]): Promise<Map<number, number[]>> {
  const valid = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  if (!valid.length) return new Map();
  return process.platform === "linux"
    ? linuxListeningPorts(valid)
    : process.platform === "darwin"
      ? macListeningPorts(valid)
      : new Map();
}

/** The TCP ports these processes listen on, lowest first, without repeats. */
export async function defaultListeningPorts(pids: readonly number[]): Promise<number[]> {
  const ports = [...(await defaultListeningPortsByProcess(pids)).values()].flat();
  return [...new Set(ports)].sort((left, right) => left - right);
}

// ── Design mode: every listening socket of a job's processes, with its address ──
//
// Design mode runs a dev server only while every socket its processes hold is
// on loopback (spec S14). These readers keep addresses and never turn a failed
// look into "no sockets": a timeout, an overrun, an unreadable table or fd
// folder each come back as a failure, so a server is never judged safe from a
// read that did not happen.

/** File descriptors read per process on Linux; past this the read fails rather than guesses. */
export const MAX_DESIGN_JOB_FDS = 4_096;
const PS_TIMEOUT_MS = 2_000;
const READER_MAX_BUFFER = 4 * 1024 * 1024;

export interface SocketAddress {
  address: string;
  port: number;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

export type ExecResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; reason: "timeout" | "max-buffer" | "error" };

export interface SocketReaderDeps {
  platform: NodeJS.Platform;
  /** Aiden's own pid: its sockets are never a job's. */
  self: number;
  exec(file: string, args: readonly string[], limits: { timeoutMs: number; maxBuffer: number }): Promise<ExecResult>;
  readFile(file: string): Promise<string>;
  readdir(folder: string): Promise<string[]>;
  readlink(link: string): Promise<string>;
  processExists(pid: number): boolean;
}

export type SocketsByProcess =
  | { ok: true; byPid: Map<number, SocketAddress[]> }
  /** `pids` names the processes whose read failed when the rest were read (in `byPid`); without it, everything failed. */
  | { ok: false; reason: string; pids?: number[]; byPid?: Map<number, SocketAddress[]> };

export type JobSockets =
  | { ok: true; sockets: Array<{ pid: number; address: string; port: number }> }
  | { ok: false; reason: string };

function execBounded(file: string, args: readonly string[], limits: { timeoutMs: number; maxBuffer: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: limits.timeoutMs, maxBuffer: limits.maxBuffer, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown };
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: false, reason: "max-buffer" });
        if (failure.killed || failure.signal) return resolve({ ok: false, reason: "timeout" });
        if (typeof failure.code === "number") {
          return resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: failure.code });
        }
        resolve({ ok: false, reason: "error" });
      },
    );
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultSocketReaderDeps(): SocketReaderDeps {
  return {
    platform: process.platform,
    self: process.pid,
    exec: execBounded,
    readFile: (file) => fsp.readFile(file, "utf8"),
    readdir: (folder) => fsp.readdir(folder),
    readlink: (link) => fsp.readlink(link),
    processExists: processAlive,
  };
}

/** `[::1]` → `::1`; anything that isn't an IP address comes back unchanged. */
function bareAddress(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

/** On `127.0.0.0/8`, `::1` or `::ffff:127.x.x.x`. `*`, `0.0.0.0`, `::`, other addresses and names are not. */
export function isLoopbackAddress(address: string): boolean {
  const bare = bareAddress(address.trim());
  if (isIPv4(bare)) return bare.startsWith("127.");
  if (!isIPv6(bare)) return false;
  let normal: string;
  try {
    normal = bareAddress(new URL(`http://[${bare}]/`).hostname);
  } catch {
    return false;
  }
  if (normal === "::1") return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normal);
  return mapped !== null && (Number.parseInt(mapped[1]!, 16) >> 8) === 127;
}

/** `lsof -Fpn` output with addresses: `n127.0.0.1:5173`, `n*:3000`, `n[::1]:4321`. */
export function parseLsofListeningSockets(output: string): Map<number, SocketAddress[]> {
  const byProcess = new Map<number, SocketAddress[]>();
  let sockets: SocketAddress[] | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      sockets = Number.isSafeInteger(pid) ? (byProcess.get(pid) ?? []) : undefined;
      if (sockets) byProcess.set(pid, sockets);
      continue;
    }
    if (!line.startsWith("n") || !sockets) continue;
    const name = line.slice(1);
    const colon = name.lastIndexOf(":");
    const port = Number(name.slice(colon + 1));
    if (colon <= 0 || !Number.isInteger(port) || port <= 0 || port >= 65_536) continue;
    sockets.push({ address: bareAddress(name.slice(0, colon)), port });
  }
  return byProcess;
}

function hexIPv6(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{32}$/u.test(hex)) return null;
  // Four 32-bit words, each in the kernel's (little-endian) byte order.
  const bytes: number[] = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    for (let index = 3; index >= 0; index -= 1) bytes.push(Number.parseInt(chunk.slice(index * 2, index * 2 + 2), 16));
  }
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join(".")}`;
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  try {
    return bareAddress(new URL(`http://[${groups.join(":")}]/`).hostname);
  } catch {
    return null;
  }
}

function hexIPv4(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/u.test(hex)) return null;
  const bytes = [0, 1, 2, 3].map((index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  return bytes.reverse().join(".");
}

/** Listening sockets of a /proc/net/tcp (`family` 4) or tcp6 (6) table: socket inode → address and port. */
export function parseProcNetTcpSockets(table: string, family: 4 | 6): Map<string, SocketAddress> {
  const listening = new Map<string, SocketAddress>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10 || fields[3] !== LISTEN_STATE) continue;
    const [hexAddress = "", hexPort = ""] = fields[1]!.split(":");
    const port = Number.parseInt(hexPort, 16);
    const address = family === 4 ? hexIPv4(hexAddress) : hexIPv6(hexAddress);
    const inode = fields[9]!;
    if (address && Number.isInteger(port) && port > 0 && port < 65_536 && inode !== "0") listening.set(inode, { address, port });
  }
  return listening;
}

/** One `ps -A -o pid=,ppid=,pgid=`; fails closed. */
export async function processTable(
  deps: SocketReaderDeps = defaultSocketReaderDeps(),
): Promise<{ ok: true; rows: ProcessRow[] } | { ok: false; reason: string }> {
  const result = await deps.exec("ps", ["-A", "-o", "pid=,ppid=,pgid="], { timeoutMs: PS_TIMEOUT_MS, maxBuffer: READER_MAX_BUFFER });
  if (!result.ok) return { ok: false, reason: `ps: ${result.reason}` };
  if (result.exitCode !== 0) return { ok: false, reason: `ps exited ${result.exitCode}` };
  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/u).map(Number);
    if (fields.length !== 3 || !fields.every((value) => Number.isSafeInteger(value) && value >= 0)) continue;
    rows.push({ pid: fields[0]!, ppid: fields[1]!, pgid: fields[2]! });
  }
  if (!rows.length) return { ok: false, reason: "ps listed no processes" };
  return { ok: true, rows };
}

/** A job's processes: its process group, plus every descendant by parent pid (a child that called `setsid` included). */
export function jobProcessTree(rows: readonly ProcessRow[], pgid: number): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found = new Set<number>();
  const queue = rows.filter((row) => row.pgid === pgid).map((row) => row.pid);
  while (queue.length) {
    const pid = queue.shift()!;
    if (found.has(pid) || pid <= 1) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...found].sort((left, right) => left - right);
}

const sameSocket = (left: SocketAddress, right: SocketAddress) => left.address === right.address && left.port === right.port;

async function macSockets(pids: readonly number[], deps: SocketReaderDeps): Promise<SocketsByProcess> {
  const result = await deps.exec(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", [...pids, deps.self].join(","), "-Fpn"],
    { timeoutMs: LSOF_TIMEOUT_MS, maxBuffer: READER_MAX_BUFFER },
  );
  if (!result.ok) return { ok: false, reason: `lsof: ${result.reason}` };
  // lsof exits 1, silently, when some (or all) of the pids hold no listening socket or have gone. Any other exit, or
  // anything it printed on stderr (even next to output, even on exit 0), may mean a partial scan, so it is a failed look.
  if (result.stderr.trim().length > 0) return { ok: false, reason: "lsof reported a problem" };
  if (result.exitCode !== 0 && result.exitCode !== 1) return { ok: false, reason: `lsof exited ${result.exitCode}` };
  const found = parseLsofListeningSockets(result.stdout);
  const own = found.get(deps.self) ?? [];
  return {
    ok: true,
    byPid: new Map(
      pids.map((pid) => [pid, (found.get(pid) ?? []).filter((socket) => !own.some((mine) => sameSocket(mine, socket)))]),
    ),
  };
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** A process's socket inodes; `null` when a live process's fds could not all be read. */
async function linuxSocketInodes(pid: number, deps: SocketReaderDeps): Promise<{ inodes: string[] } | { failed: string }> {
  let fds: string[];
  try {
    fds = await deps.readdir(`/proc/${pid}/fd`);
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !deps.processExists(pid)) return { inodes: [] };
    return { failed: `fd folder of ${pid} unreadable` };
  }
  if (fds.length > MAX_DESIGN_JOB_FDS) return { failed: `${pid} has more than ${MAX_DESIGN_JOB_FDS} open files` };
  const inodes: string[] = [];
  for (const fd of fds) {
    let target: string;
    try {
      target = await deps.readlink(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      // A descriptor closed since the listing is simply gone.
      if (errorCode(error) === "ENOENT") continue;
      return { failed: `fd of ${pid} unreadable` };
    }
    const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
    if (inode) inodes.push(inode);
  }
  return { inodes };
}

async function linuxSockets(pids: readonly number[], deps: SocketReaderDeps): Promise<SocketsByProcess> {
  const listening = new Map<string, SocketAddress>();
  for (const [file, family] of [["/proc/net/tcp", 4], ["/proc/net/tcp6", 6]] as const) {
    let table: string;
    try {
      table = await deps.readFile(file);
    } catch (error) {
      // A kernel booted with IPv6 off has no tcp6 table and so no IPv6 socket; any other failure fails closed.
      if (family === 6 && errorCode(error) === "ENOENT") continue;
      return { ok: false, reason: `${file} unreadable` };
    }
    for (const [inode, socket] of parseProcNetTcpSockets(table, family)) listening.set(inode, socket);
  }
  const ownRead = await linuxSocketInodes(deps.self, deps);
  if ("failed" in ownRead) return { ok: false, reason: "Aiden's own sockets unreadable" };
  const own = new Set(ownRead.inodes);
  const byPid = new Map<number, SocketAddress[]>();
  const failed: number[] = [];
  let reason = "";
  for (const pid of pids) {
    const read = await linuxSocketInodes(pid, deps);
    if ("failed" in read) {
      failed.push(pid);
      reason ||= read.failed;
      continue;
    }
    byPid.set(
      pid,
      read.inodes.flatMap((inode) => {
        const socket = own.has(inode) ? undefined : listening.get(inode);
        return socket ? [{ ...socket }] : [];
      }),
    );
  }
  return failed.length ? { ok: false, reason, pids: failed, byPid } : { ok: true, byPid };
}

/**
 * Every listening TCP socket, with its address, of each of these processes,
 * from one look for all of them: one lsof call on macOS, one pass over
 * /proc on Linux. Fails closed.
 */
export async function listeningSocketsByProcess(
  pids: readonly number[],
  deps: SocketReaderDeps = defaultSocketReaderDeps(),
): Promise<SocketsByProcess> {
  const valid = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== deps.self);
  if (!valid.length) return { ok: true, byPid: new Map() };
  if (deps.platform === "darwin") return macSockets(valid, deps);
  if (deps.platform === "linux") return linuxSockets(valid, deps);
  return { ok: false, reason: "unsupported platform" };
}

/**
 * Each job's listening sockets, from one `ps` and one socket read for all of
 * them. `groups` maps a job id to its process group. A failed `ps` or socket
 * read fails every job; a failure for some processes fails only the jobs
 * those processes belong to.
 */
export async function readJobSockets(
  groups: ReadonlyMap<string, number>,
  deps: SocketReaderDeps = defaultSocketReaderDeps(),
): Promise<Map<string, JobSockets>> {
  const results = new Map<string, JobSockets>();
  if (!groups.size) return results;
  const table = await processTable(deps);
  if (!table.ok) {
    for (const jobId of groups.keys()) results.set(jobId, { ok: false, reason: table.reason });
    return results;
  }
  const trees = new Map([...groups].map(([jobId, pgid]) => [jobId, jobProcessTree(table.rows, pgid)]));
  const read = await listeningSocketsByProcess([...new Set([...trees.values()].flat())], deps);
  const failedPids = new Set(read.ok ? [] : (read.pids ?? []));
  for (const [jobId, tree] of trees) {
    if (!read.ok && (!read.pids || tree.some((pid) => failedPids.has(pid)))) {
      results.set(jobId, { ok: false, reason: read.reason });
      continue;
    }
    const byPid = read.byPid ?? new Map<number, SocketAddress[]>();
    results.set(jobId, {
      ok: true,
      sockets: tree.flatMap((pid) => (byPid.get(pid) ?? []).map((socket) => ({ pid, ...socket }))),
    });
  }
  return results;
}
