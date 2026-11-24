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
  /** The owner's user id (2c): a subtree with another user's process can't be confirmed. */
  uid: number;
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
  /** `incomplete` only with `{ partial: true }`: a diagnostic or an unreadable process, and the rest was read. */
  | { ok: true; byPid: Map<number, SocketAddress[]>; incomplete?: true }
  /** `pids` names the processes whose read failed when the rest were read (in `byPid`); without it, everything failed. */
  | { ok: false; reason: string; pids?: number[]; byPid?: Map<number, SocketAddress[]> };

export type JobSockets =
  /** `rows`: an attach root's subtree (2c), so the watch can check owners and re-bind. */
  | { ok: true; sockets: Array<{ pid: number; address: string; port: number }>; rows?: ProcessRow[] }
  /** `rows` (2c): an attach root's subtree even when its socket read failed, so another user's process in it still detaches (A-m1). */
  | { ok: false; reason: string; rows?: ProcessRow[] };

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

/** One `ps -A -o pid=,ppid=,pgid=,uid=`; fails closed. */
export async function processTable(
  deps: SocketReaderDeps = defaultSocketReaderDeps(),
): Promise<{ ok: true; rows: ProcessRow[] } | { ok: false; reason: string }> {
  const result = await deps.exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,uid="], { timeoutMs: PS_TIMEOUT_MS, maxBuffer: READER_MAX_BUFFER });
  if (!result.ok) return { ok: false, reason: `ps: ${result.reason}` };
  if (result.exitCode !== 0) return { ok: false, reason: `ps exited ${result.exitCode}` };
  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/u).map(Number);
    if (fields.length !== 4 || !fields.every((value) => Number.isSafeInteger(value) && value >= 0)) continue;
    rows.push({ pid: fields[0]!, ppid: fields[1]!, pgid: fields[2]!, uid: fields[3]! });
  }
  if (!rows.length) return { ok: false, reason: "ps listed no processes" };
  return { ok: true, rows };
}

/** A job's processes: its process group, plus every descendant by parent pid (a child that called `setsid` included). */
export function jobProcessTree(rows: ReadonlyArray<Pick<ProcessRow, "pid" | "ppid" | "pgid">>, pgid: number): number[] {
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

/** A process and every descendant by parent pid (2c): unlike `jobProcessTree`, not its whole process group. */
export function processSubtree(rows: readonly ProcessRow[], pid: number): number[] {
  if (!rows.some((row) => row.pid === pid)) return [];
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found = new Set<number>();
  const queue = [pid];
  while (queue.length) {
    const next = queue.shift()!;
    if (found.has(next) || next <= 1) continue;
    found.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return [...found].sort((left, right) => left - right);
}

const sameSocket = (left: SocketAddress, right: SocketAddress) => left.address === right.address && left.port === right.port;

async function macSockets(pids: readonly number[], deps: SocketReaderDeps, partial = false): Promise<SocketsByProcess> {
  const result = await deps.exec(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", [...pids, deps.self].join(","), "-Fpn"],
    { timeoutMs: LSOF_TIMEOUT_MS, maxBuffer: READER_MAX_BUFFER },
  );
  if (!result.ok) return { ok: false, reason: `lsof: ${result.reason}` };
  // lsof exits 1, silently, when some (or all) of the pids hold no listening socket or have gone. Any other exit, or
  // anything it printed on stderr (even next to output, even on exit 0), may mean a partial scan, so it is a failed look.
  // Discovery alone (`partial`) keeps what was read and says it may be incomplete.
  const noisy = result.stderr.trim().length > 0;
  if (noisy && !partial) return { ok: false, reason: "lsof reported a problem" };
  if (result.exitCode !== 0 && result.exitCode !== 1) return { ok: false, reason: `lsof exited ${result.exitCode}` };
  const found = parseLsofListeningSockets(result.stdout);
  const own = found.get(deps.self) ?? [];
  return {
    ok: true,
    byPid: new Map(
      pids.map((pid) => [pid, (found.get(pid) ?? []).filter((socket) => !own.some((mine) => sameSocket(mine, socket)))]),
    ),
    ...(noisy ? { incomplete: true as const } : {}),
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

/** Every listening socket in /proc/net/tcp and tcp6, by inode; null when a table that must exist couldn't be read. */
async function linuxListeningTable(deps: SocketReaderDeps): Promise<Map<string, SocketAddress> | { failed: string }> {
  const listening = new Map<string, SocketAddress>();
  for (const [file, family] of [["/proc/net/tcp", 4], ["/proc/net/tcp6", 6]] as const) {
    let table: string;
    try {
      table = await deps.readFile(file);
    } catch (error) {
      // A kernel booted with IPv6 off has no tcp6 table and so no IPv6 socket; any other failure fails closed.
      if (family === 6 && errorCode(error) === "ENOENT") continue;
      return { failed: `${file} unreadable` };
    }
    for (const [inode, socket] of parseProcNetTcpSockets(table, family)) listening.set(inode, socket);
  }
  return listening;
}

async function linuxSockets(pids: readonly number[], deps: SocketReaderDeps, partial = false): Promise<SocketsByProcess> {
  const listening = await linuxListeningTable(deps);
  if ("failed" in listening) return { ok: false, reason: listening.failed as string };
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
  if (failed.length && partial) return { ok: true, byPid, incomplete: true };
  return failed.length ? { ok: false, reason, pids: failed, byPid } : { ok: true, byPid };
}

/**
 * Every listening TCP socket, with its address, of each of these processes,
 * from one look for all of them: one lsof call on macOS, one pass over
 * /proc on Linux. Fails closed, except that discovery (2c's Connect list)
 * passes `partial` to keep what was read next to a diagnostic, marked
 * `incomplete`.
 */
export async function listeningSocketsByProcess(
  pids: readonly number[],
  deps: SocketReaderDeps = defaultSocketReaderDeps(),
  options: { partial?: boolean } = {},
): Promise<SocketsByProcess> {
  const valid = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== deps.self);
  if (!valid.length) return { ok: true, byPid: new Map() };
  if (deps.platform === "darwin") return macSockets(valid, deps, options.partial === true);
  if (deps.platform === "linux") return linuxSockets(valid, deps, options.partial === true);
  return { ok: false, reason: "unsupported platform" };
}

/** One socket read for some trees: a failed read fails every tree, a per-pid failure only the trees with that pid. */
async function answerTrees(
  trees: ReadonlyMap<string, number[]>,
  deps: SocketReaderDeps,
  results: Map<string, JobSockets>,
  rowsOf?: (tree: number[]) => ProcessRow[],
): Promise<void> {
  if (!trees.size) return;
  const read = await listeningSocketsByProcess([...new Set([...trees.values()].flat())], deps);
  const failedPids = new Set(read.ok ? [] : (read.pids ?? []));
  for (const [key, tree] of trees) {
    if (!read.ok && (!read.pids || tree.some((pid) => failedPids.has(pid)))) {
      results.set(key, { ok: false, reason: read.reason, ...(rowsOf ? { rows: rowsOf(tree) } : {}) });
      continue;
    }
    const byPid = read.byPid ?? new Map<number, SocketAddress[]>();
    results.set(key, {
      ok: true,
      sockets: tree.flatMap((pid) => (byPid.get(pid) ?? []).map((socket) => ({ pid, ...socket }))),
      ...(rowsOf ? { rows: rowsOf(tree) } : {}),
    });
  }
}

/**
 * Each job's listening sockets, from one `ps` and one socket read for all of
 * them. `groups` maps a job id to its process group. A failed `ps` or socket
 * read fails every job; a failure for some processes fails only the jobs
 * those processes belong to.
 *
 * `roots` (2c) maps a key to an attached server's holder pid. They're
 * answered from the same `ps` (the holder and its descendants, with their
 * rows) but from a separate socket read, so a diagnostic from one side never
 * fails the other. A holder that has left the table answers no sockets and
 * no rows.
 */
export async function readJobSockets(
  groups: ReadonlyMap<string, number>,
  deps: SocketReaderDeps = defaultSocketReaderDeps(),
  roots?: ReadonlyMap<string, number>,
): Promise<Map<string, JobSockets>> {
  const results = new Map<string, JobSockets>();
  if (!groups.size && !roots?.size) return results;
  const table = await processTable(deps);
  if (!table.ok) {
    for (const key of [...groups.keys(), ...(roots?.keys() ?? [])]) results.set(key, { ok: false, reason: table.reason });
    return results;
  }
  await answerTrees(new Map([...groups].map(([jobId, pgid]) => [jobId, jobProcessTree(table.rows, pgid)])), deps, results);
  if (roots?.size) {
    const byPid = new Map(table.rows.map((row) => [row.pid, row]));
    await answerTrees(
      new Map([...roots].map(([key, pid]) => [key, processSubtree(table.rows, pid)])),
      deps,
      results,
      (tree) => tree.map((pid) => ({ ...byPid.get(pid)! })),
    );
  }
  return results;
}

// ── 2c: whose processes run where, for Connect running server… (D6, D8) ──

/** Processes discovery looks at, at most; past this it fails closed. */
export const MAX_SCAN_PIDS = 4_096;

/** `lsof -d cwd -Fpn` output: a `p<pid>` line, then `n<folder>` (the rest of the line, spaces included). */
export function parseLsofCwd(output: string): Map<number, string> {
  const byPid = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isSafeInteger(value) && value > 0 && line.length > 1 ? value : undefined;
      continue;
    }
    if (line.startsWith("n") && pid !== undefined && line.length > 1 && !byPid.has(pid)) byPid.set(pid, line.slice(1));
  }
  return byPid;
}

export type ProcessFolders = { ok: true; byPid: Map<number, string>; incomplete: boolean } | { ok: false; reason: string };

/**
 * Each process's working folder. macOS: one `lsof -d cwd` for the uid's
 * processes (its folders are canonical); Linux: `readlink /proc/<pid>/cwd`
 * for exactly these pids, skipping EACCES and ENOENT. A skipped pid or an
 * lsof diagnostic is `incomplete` with `partial` and a failure without; a
 * timeout, an overrun, an exit other than 0 or 1, or more than `maxPids`
 * processes always fails.
 */
export async function processFolders(
  pids: readonly number[],
  deps: SocketReaderDeps,
  options: { uid: number; maxPids: number; partial?: boolean },
): Promise<ProcessFolders> {
  const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  if (wanted.length > options.maxPids) return { ok: false, reason: "too many processes" };
  const partial = options.partial === true;
  const byPid = new Map<number, string>();
  if (!wanted.length) return { ok: true, byPid, incomplete: false };
  if (deps.platform === "darwin") {
    const result = await deps.exec("/usr/sbin/lsof", ["-nP", "-a", "-d", "cwd", "-Fpn", "-u", String(options.uid)], {
      timeoutMs: LSOF_TIMEOUT_MS,
      maxBuffer: READER_MAX_BUFFER,
    });
    if (!result.ok) return { ok: false, reason: `lsof: ${result.reason}` };
    if (result.exitCode !== 0 && result.exitCode !== 1) return { ok: false, reason: `lsof exited ${result.exitCode}` };
    const noisy = result.stderr.trim().length > 0;
    if (noisy && !partial) return { ok: false, reason: "lsof reported a problem" };
    const found = parseLsofCwd(result.stdout);
    for (const pid of wanted) {
      const folder = found.get(pid);
      if (folder !== undefined) byPid.set(pid, folder);
    }
    return { ok: true, byPid, incomplete: noisy };
  }
  if (deps.platform === "linux") {
    let skipped = false;
    for (const pid of wanted) {
      try {
        byPid.set(pid, await deps.readlink(`/proc/${pid}/cwd`));
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EACCES" && code !== "ENOENT" && code !== "EPERM") return { ok: false, reason: `cwd of ${pid} unreadable` };
        if (!partial) return { ok: false, reason: `cwd of ${pid} unreadable` };
        skipped = true;
      }
    }
    return { ok: true, byPid, incomplete: skipped };
  }
  return { ok: false, reason: "unsupported platform" };
}

/** A process name as shown: the last path segment of `comm`, at most 64 characters. */
const PROCESS_NAME_MAX = 64;

/** Each process's name, from one `ps -o pid=,comm= -p <list>`; fails closed. */
export async function processNames(
  pids: readonly number[],
  deps: SocketReaderDeps,
): Promise<{ ok: true; byPid: Map<number, string> } | { ok: false; reason: string }> {
  const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  const byPid = new Map<number, string>();
  if (!wanted.length) return { ok: true, byPid };
  const result = await deps.exec("ps", ["-o", "pid=,comm=", "-p", wanted.join(",")], { timeoutMs: PS_TIMEOUT_MS, maxBuffer: READER_MAX_BUFFER });
  if (!result.ok) return { ok: false, reason: `ps: ${result.reason}` };
  // ps exits 1 when some pid has gone; what it printed is still right.
  if (result.exitCode !== 0 && result.exitCode !== 1) return { ok: false, reason: `ps exited ${result.exitCode}` };
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const name = match[2]!.split("/").filter(Boolean).pop() ?? "";
    if (wanted.includes(pid) && name) byPid.set(pid, [...name].slice(0, PROCESS_NAME_MAX).join(""));
  }
  return { ok: true, byPid };
}

/**
 * The processes of `uid` that hold a listening TCP socket on `port`, on any
 * address. macOS: one `lsof -iTCP:<port> -sTCP:LISTEN -u <uid>`, failing
 * closed on any diagnostic; Linux: the port's listening inodes from
 * /proc/net/tcp and tcp6, then the fds of this uid's processes only. Fails
 * closed; on Linux an unreadable process is skipped only when the readable
 * ones hold every socket on the port, so it can't be the holder.
 */
export async function portHolders(
  port: number,
  uid: number,
  deps: SocketReaderDeps,
): Promise<{ ok: true; pids: number[] } | { ok: false; reason: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, reason: "bad port" };
  if (deps.platform === "darwin") {
    const result = await deps.exec(
      "/usr/sbin/lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-u", String(uid), "-Fpn"],
      { timeoutMs: LSOF_TIMEOUT_MS, maxBuffer: READER_MAX_BUFFER },
    );
    if (!result.ok) return { ok: false, reason: `lsof: ${result.reason}` };
    if (result.stderr.trim().length > 0) return { ok: false, reason: "lsof reported a problem" };
    if (result.exitCode !== 0 && result.exitCode !== 1) return { ok: false, reason: `lsof exited ${result.exitCode}` };
    const found = parseLsofListeningSockets(result.stdout);
    return { ok: true, pids: [...found].filter(([, sockets]) => sockets.some((socket) => socket.port === port)).map(([pid]) => pid) };
  }
  if (deps.platform === "linux") {
    const listening = await linuxListeningTable(deps);
    if ("failed" in listening) return { ok: false, reason: listening.failed as string };
    const inodes = new Set([...listening].filter(([, socket]) => socket.port === port).map(([inode]) => inode));
    if (!inodes.size) return { ok: true, pids: [] };
    const table = await processTable(deps);
    if (!table.ok) return { ok: false, reason: table.reason };
    const mine = table.rows.filter((row) => row.uid === uid && row.pid > 1).map((row) => row.pid);
    if (mine.length > MAX_SCAN_PIDS) return { ok: false, reason: "too many processes" };
    const pids: number[] = [];
    const held = new Set<string>();
    const unreadable = new Set<number>();
    for (const pid of mine) {
      const read = await linuxSocketInodes(pid, deps);
      // Some of the person's processes can't be read (Chromium's sandboxed helpers aren't dumpable).
      // One may be skipped only if the readable ones turn out to hold every socket on the port.
      if ("failed" in read) {
        unreadable.add(pid);
        continue;
      }
      const mineHere = read.inodes.filter((inode) => inodes.has(inode));
      if (mineHere.length) pids.push(pid);
      for (const inode of mineHere) held.add(inode);
    }
    if (unreadable.size && [...inodes].some((inode) => !held.has(inode))) return { ok: false, reason: `a holder of port ${port} couldn't be read` };
    // A skipped process above a holder may share its socket (a forked descriptor), and so be the outermost holder (A-m2).
    if (unreadable.size) {
      const parent = new Map(table.rows.map((row) => [row.pid, row.ppid]));
      for (const pid of pids) {
        const seen = new Set<number>();
        for (let up = parent.get(pid); up !== undefined && up > 1 && !seen.has(up); up = parent.get(up)) {
          if (unreadable.has(up)) return { ok: false, reason: `an ancestor of port ${port}'s holder couldn't be read` };
          seen.add(up);
        }
      }
    }
    return { ok: true, pids };
  }
  return { ok: false, reason: "unsupported platform" };
}

/** What `processEnvironmentMarks` read: the pids whose starting environment carries the prefix, and the ones it couldn't read. */
export type EnvironmentMarks = { ok: true; marked: Set<number>; unreadable: Set<number> } | { ok: false; reason: string };

/**
 * Which of these processes started with an environment entry beginning
 * `prefix` (2c, A-M2). Fails closed per process: one whose environment can't
 * be shown is `unreadable`, never "not marked". Linux reads
 * `/proc/<pid>/environ`. macOS runs `ps -E` and plain `ps` over the same
 * pids: `ps -E` appends the environment after the command, except for
 * Apple's platform binaries (and a process with an empty environment), whose
 * two lines then match, so those are unreadable. A process that left between
 * the reads is unreadable too.
 */
export async function processEnvironmentMarks(pids: readonly number[], prefix: string, deps: SocketReaderDeps): Promise<EnvironmentMarks> {
  const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  const marked = new Set<number>();
  const unreadable = new Set<number>();
  if (!wanted.length) return { ok: true, marked, unreadable };
  if (wanted.length > MAX_SCAN_PIDS) return { ok: false, reason: "too many processes" };
  if (deps.platform === "linux") {
    for (const pid of wanted) {
      try {
        const environment = await deps.readFile(`/proc/${pid}/environ`);
        if (environment.split("\0").some((entry) => entry.startsWith(prefix))) marked.add(pid);
      } catch {
        unreadable.add(pid);
      }
    }
    return { ok: true, marked, unreadable };
  }
  if (deps.platform === "darwin") {
    const list = wanted.join(",");
    const limits = { timeoutMs: PS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 };
    const withEnvironment = await deps.exec("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", list], limits);
    const plain = await deps.exec("ps", ["-ww", "-o", "pid=,command=", "-p", list], limits);
    for (const result of [withEnvironment, plain]) {
      if (!result.ok) return { ok: false, reason: `ps: ${result.reason}` };
      // ps exits 1 when some pid has gone; those are unreadable below.
      if (result.exitCode !== 0 && result.exitCode !== 1) return { ok: false, reason: `ps exited ${result.exitCode}` };
    }
    const lines = (stdout: string) => {
      const byPid = new Map<number, string>();
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+) (.*)$/u.exec(line);
        if (match) byPid.set(Number(match[1]), match[2]!);
      }
      return byPid;
    };
    const full = lines((withEnvironment as { stdout: string }).stdout);
    const bare = lines((plain as { stdout: string }).stdout);
    for (const pid of wanted) {
      const line = full.get(pid);
      const command = bare.get(pid);
      if (line === undefined || command === undefined || !line.startsWith(command) || line.length === command.length) {
        unreadable.add(pid);
        continue;
      }
      // Fail closed: an argument that only looks like the entry counts as one.
      if (line.slice(command.length).split(/\s+/u).some((entry) => entry.startsWith(prefix))) marked.add(pid);
    }
    return { ok: true, marked, unreadable };
  }
  return { ok: false, reason: "unsupported platform" };
}
