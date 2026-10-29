// Which TCP ports a set of processes listen on, so a background job that runs
// a dev server can show its address. Linux reads /proc; macOS asks lsof for
// exactly those processes. Both are bounded and return nothing on failure.
// A socket Aiden itself holds is never counted: a child can inherit one of
// Aiden's listening sockets, and that address is Aiden's, not the job's.

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";

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

async function linuxListeningPorts(pids: readonly number[]): Promise<number[]> {
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => fsp.readFile(file, "utf8").catch(() => "")),
  );
  const listening = new Map<string, number>();
  for (const table of tables) for (const [inode, port] of parseProcNetTcp(table)) listening.set(inode, port);
  if (!listening.size) return [];
  const own = new Set(await socketInodes(process.pid));
  const ports: number[] = [];
  for (const pid of pids) {
    if (pid === process.pid) continue;
    for (const inode of await socketInodes(pid)) {
      const port = own.has(inode) ? undefined : listening.get(inode);
      if (port !== undefined) ports.push(port);
    }
  }
  return ports;
}

function macListeningPorts(pids: readonly number[]): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", [...pids, process.pid].join(","), "-Fpn"],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      // lsof exits 1 when nothing matched; its output is still what it found.
      (_error, stdout) =>
        resolve(typeof stdout === "string" ? portsOfProcesses(parseLsofListening(stdout), pids, process.pid) : []),
    );
  });
}

/** The TCP ports these processes listen on, lowest first, without repeats. */
export async function defaultListeningPorts(pids: readonly number[]): Promise<number[]> {
  const valid = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  if (!valid.length) return [];
  const ports =
    process.platform === "linux"
      ? await linuxListeningPorts(valid)
      : process.platform === "darwin"
        ? await macListeningPorts(valid)
        : [];
  return [...new Set(ports)].sort((left, right) => left - right);
}
