// Which TCP ports a set of processes listen on, so a background job that runs
// a dev server can show its address. Linux reads /proc; macOS asks lsof for
// exactly those processes. Both are bounded and return nothing on failure.

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

/** Ports from `lsof -Fn` output: one `n<address>:<port>` line per socket. */
export function parseLsofListening(output: string): number[] {
  const ports: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0 && port < 65_536) ports.push(port);
  }
  return ports;
}

async function linuxListeningPorts(pids: readonly number[]): Promise<number[]> {
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => fsp.readFile(file, "utf8").catch(() => "")),
  );
  const listening = new Map<string, number>();
  for (const table of tables) for (const [inode, port] of parseProcNetTcp(table)) listening.set(inode, port);
  if (!listening.size) return [];
  const ports: number[] = [];
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = (await fsp.readdir(`/proc/${pid}/fd`)).slice(0, MAX_FDS_PER_PROCESS);
    } catch {
      continue;
    }
    for (const fd of fds) {
      const target = await fsp.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
      const port = inode ? listening.get(inode) : undefined;
      if (port !== undefined) ports.push(port);
    }
  }
  return ports;
}

function macListeningPorts(pids: readonly number[]): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fn"],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      // lsof exits 1 when nothing matched; its output is still what it found.
      (_error, stdout) => resolve(typeof stdout === "string" ? parseLsofListening(stdout) : []),
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
