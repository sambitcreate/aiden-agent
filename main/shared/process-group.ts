// Lifecycle helpers for children spawned with `detached: true`, which makes each
// child the leader of its own process group. Stopping the group, not just the
// leader, also stops the shell's background jobs, Git's helpers and a script's
// children. Windows has no process groups; there only the child is signalled.

import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
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

interface LinuxProcStat {
  zombie: boolean;
  ppid: number;
  pgid: number;
  startId: string;
}

function readLinuxProcStat(pid: number): LinuxProcStat | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    // Field 3 (state) is index 0 after `) `; field 4 (ppid) is 1; field 5 (pgrp) is 2; field 22 (starttime) is 19.
    const fields = stat.slice(closeParen + 2).trim().split(" ");
    const state = fields[0];
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const starttime = fields[19];
    if (
      !state ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      pgid <= 0 ||
      !starttime ||
      !/^\d+$/u.test(starttime)
    ) {
      return undefined;
    }
    return {
      zombie: state === "Z",
      ppid,
      pgid,
      startId: `proc:${starttime}`,
    };
  } catch {
    return undefined;
  }
}

function readLinuxProcStartId(pid: number): string | undefined {
  return readLinuxProcStat(pid)?.startId;
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
      let startId = lstartId;
      if (options.exactStartIdForPgids?.has(pgid) && process.platform === "linux") {
        const procStat = readLinuxProcStat(procPid);
        // If `/proc/<pid>/stat` now belongs to a different group, the `ps` row is stale (PID reused).
        startId = procStat && procStat.pgid === pgid ? procStat.startId : undefined;
      }
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

export interface VerifyProcessGroupSurvivorsInput {
  pgid: number;
  processes: readonly ObservedProcessEntry[];
  leaderStartId?: string;
  parentPid?: number;
  currentUid?: number;
  preExitMembers?: readonly ProcessIncarnationSurvivor[];
  pipeVerifiedPids?: ReadonlySet<number>;
}

export interface CaptureProcessGroupSurvivorsOptions {
  leaderStartId?: string;
  parentPid?: number;
  preExitMembers?: readonly ProcessIncarnationSurvivor[];
  transportFds?: readonly number[];
  isTransportFdStillOpen?: (fd: number) => boolean;
}

function isDescendantOfPid(
  proc: ObservedProcessEntry,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ObservedProcessEntry>,
): boolean {
  if (proc.pid === ancestorPid) return false;
  const visited = new Set<number>([proc.pid]);
  let parentPid = proc.ppid;
  while (Number.isSafeInteger(parentPid) && parentPid > 0) {
    if (parentPid === ancestorPid) return true;
    if (visited.has(parentPid)) return false;
    visited.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) return false;
    parentPid = parent.ppid;
  }
  return false;
}

function isDescendantInGroup(
  member: ObservedProcessEntry,
  verifiedRoots: ReadonlySet<number>,
  groupByPid: ReadonlyMap<number, ObservedProcessEntry>,
): boolean {
  if (verifiedRoots.has(member.pid)) return true;
  const visited = new Set<number>([member.pid]);
  let parentPid = member.ppid;
  while (Number.isSafeInteger(parentPid) && parentPid > 0) {
    if (verifiedRoots.has(parentPid)) return true;
    if (visited.has(parentPid)) return false;
    visited.add(parentPid);
    const parent = groupByPid.get(parentPid);
    if (!parent) return false;
    parentPid = parent.ppid;
  }
  return false;
}

/**
 * Parses `ss -xH` output on Linux and maps each anonymous local Unix
 * socketpair inode in `localInodes` to its connected peer socket inode.
 * Named sockets (non-`*` local or peer address) are ignored.
 */
export function parseSsUnixPeerInodes(
  stdout: string,
  localInodes: ReadonlySet<string>,
): Map<string, string> {
  const peers = new Map<string, string>();
  if (localInodes.size === 0) return peers;
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/u);
    if (cols.length < 8) continue;
    if (cols[0] !== "u_str" && cols[0] !== "u_seq" && cols[0] !== "u_dgr") continue;
    if (cols[1] !== "ESTAB") continue;
    if (cols[4] !== "*" || cols[6] !== "*") continue;
    const localInode = cols[5] ?? "";
    const peerInode = cols[7] ?? "";
    if (!localInodes.has(localInode)) continue;
    if (!/^\d+$/u.test(peerInode) || peerInode === "0" || peerInode === localInode) continue;
    peers.set(localInode, peerInode);
  }
  return peers;
}

/**
 * Fallback Linux parser for `lsof +E -nP -a -p <selfPid> -F pftin` when `ss` is
 * unavailable. Maps each anonymous Unix socketpair inode held on one of
 * `transportFds` to its connected peer inode (`->INO=<peer>`).
 */
export function parseLinuxLsofUnixPeerInodes(
  stdout: string,
  selfPid: number,
  transportFds: ReadonlySet<number>,
  localInodes: ReadonlySet<string>,
): Map<string, string> {
  const peers = new Map<string, string>();
  if (transportFds.size === 0 || localInodes.size === 0) return peers;
  let currentPid: number | undefined;
  let currentFd: number | undefined;
  let currentType: string | undefined;
  let currentInode: string | undefined;
  let currentName: string | undefined;
  const flush = (): void => {
    if (
      currentPid === selfPid &&
      currentFd !== undefined &&
      transportFds.has(currentFd) &&
      currentType === "unix" &&
      currentInode !== undefined &&
      localInodes.has(currentInode) &&
      currentName !== undefined
    ) {
      const match = currentName.trim().match(/^type=(?:STREAM|SEQPACKET|DGRAM)\s+->INO=(\d+)(?:\s|$)/u);
      const peerInode = match?.[1];
      if (peerInode && peerInode !== "0" && peerInode !== currentInode) {
        peers.set(currentInode, peerInode);
      }
    }
    currentFd = undefined;
    currentType = undefined;
    currentInode = undefined;
    currentName = undefined;
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      flush();
      const parsed = Number(value);
      currentPid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (tag === "f") {
      flush();
      const match = value.match(/^(\d+)[rwu]?$/u);
      currentFd = match ? Number(match[1]) : undefined;
    } else if (tag === "t") {
      currentType = value;
    } else if (tag === "i") {
      currentInode = /^\d+$/u.test(value) ? value : undefined;
    } else if (tag === "n") {
      currentName = value;
    }
  }
  flush();
  return peers;
}

function normalizeKernelHexAddr(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(trimmed) || /^0x0+$/u.test(trimmed)) return undefined;
  return trimmed;
}

interface DarwinLsofEndpoint {
  pid: number;
  fd: number;
  type: "PIPE" | "unix";
  localAddr: string;
  peerAddr?: string;
}

function parseDarwinLsofSharedPipeMatches(
  stdout: string,
  selfPid: number,
  transportFds: ReadonlySet<number>,
  candidatePids: ReadonlySet<number>,
): Map<number, Set<number>> {
  const verified = new Map<number, Set<number>>();
  if (transportFds.size === 0 || candidatePids.size === 0) return verified;
  const parentEndpoints: DarwinLsofEndpoint[] = [];
  const candidateEndpoints: DarwinLsofEndpoint[] = [];
  let currentPid: number | undefined;
  let currentFd: number | undefined;
  let currentType: "PIPE" | "unix" | undefined;
  let devCharAddr: string | undefined;
  let devNumAddr: string | undefined;
  let peerAddr: string | undefined;
  let hasNamedPath = false;
  const flush = (): void => {
    const localAddr = devCharAddr ?? devNumAddr;
    if (
      currentPid !== undefined &&
      currentFd !== undefined &&
      currentType !== undefined &&
      localAddr !== undefined &&
      !hasNamedPath
    ) {
      const endpoint: DarwinLsofEndpoint = {
        pid: currentPid,
        fd: currentFd,
        type: currentType,
        localAddr,
        ...(peerAddr ? { peerAddr } : {}),
      };
      if (currentPid === selfPid && transportFds.has(currentFd)) {
        parentEndpoints.push(endpoint);
      } else if (candidatePids.has(currentPid)) {
        candidateEndpoints.push(endpoint);
      }
    }
    currentFd = undefined;
    currentType = undefined;
    devCharAddr = undefined;
    devNumAddr = undefined;
    peerAddr = undefined;
    hasNamedPath = false;
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      flush();
      const parsed = Number(value);
      currentPid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (tag === "f") {
      flush();
      const match = value.match(/^(\d+)[rwu]?$/u);
      currentFd = match ? Number(match[1]) : undefined;
    } else if (tag === "t") {
      currentType = value === "PIPE" || value === "unix" ? value : undefined;
    } else if (tag === "d") {
      devCharAddr = normalizeKernelHexAddr(value);
    } else if (tag === "D") {
      devNumAddr = normalizeKernelHexAddr(value);
    } else if (tag === "n") {
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      const match = trimmed.match(/^->(0x[0-9a-f]+)(?:\s+\([^)]*\))?$/iu);
      if (match) {
        peerAddr = normalizeKernelHexAddr(match[1]!);
      } else {
        hasNamedPath = true;
      }
    }
  }
  flush();
  if (parentEndpoints.length === 0 || candidateEndpoints.length === 0) return verified;
  for (const cand of candidateEndpoints) {
    for (const parent of parentEndpoints) {
      if (parent.type !== cand.type) continue;
      const matched =
        parent.peerAddr !== undefined && cand.peerAddr !== undefined
          ? parent.peerAddr === cand.localAddr && cand.peerAddr === parent.localAddr
          : (parent.peerAddr !== undefined && parent.peerAddr === cand.localAddr) ||
            (cand.peerAddr !== undefined && cand.peerAddr === parent.localAddr);
      if (matched) {
        let fds = verified.get(cand.pid);
        if (!fds) {
          fds = new Set<number>();
          verified.set(cand.pid, fds);
        }
        fds.add(parent.fd);
      }
    }
  }
  return verified;
}

/**
 * Parses macOS/Darwin `lsof -nP -p <selfPid>,<candidates> -F pftdDn` output and
 * returns the candidate PIDs proven to hold the peer endpoint of an anonymous
 * `PIPE` or `unix` socketpair held open by `selfPid` on `transportFds`.
 * Named Unix sockets, all-zero addresses, and unconnected endpoints are rejected.
 */
export function parseDarwinLsofSharedPipePids(
  stdout: string,
  selfPid: number,
  transportFds: ReadonlySet<number>,
  candidatePids: ReadonlySet<number>,
): Set<number> {
  return new Set(parseDarwinLsofSharedPipeMatches(stdout, selfPid, transportFds, candidatePids).keys());
}

function findTransportPipeVerifiedPids(
  candidates: readonly ObservedProcessEntry[],
  pgid: number,
  transportFds: readonly number[],
  isTransportFdStillOpen?: (fd: number) => boolean,
  selfPid: number = process.pid,
): Set<number> {
  const verified = new Set<number>();
  const validFds = [...new Set(transportFds.filter((fd) => Number.isSafeInteger(fd) && fd >= 0))];
  if (candidates.length === 0 || validFds.length === 0) return verified;

  if (process.platform === "linux") {
    const fdTargetByFd = new Map<number, string>();
    const expectedTargetToSourceFd = new Map<string, number>();
    const localSocketInodeToFd = new Map<string, number>();
    for (const fd of validFds) {
      if (isTransportFdStillOpen && !isTransportFdStillOpen(fd)) continue;
      let target: string;
      try {
        target = readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        continue;
      }
      fdTargetByFd.set(fd, target);
      if (/^pipe:\[\d+\]$/u.test(target)) {
        expectedTargetToSourceFd.set(target, fd);
      } else {
        const sockMatch = target.match(/^socket:\[(\d+)\]$/u);
        if (sockMatch?.[1]) {
          localSocketInodeToFd.set(sockMatch[1], fd);
        }
      }
    }
    if (localSocketInodeToFd.size > 0) {
      const localInodes = new Set(localSocketInodeToFd.keys());
      let peerMap: Map<string, string> | undefined;
      try {
        const ssOut = spawnSync("ss", ["-xH"], {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        if (!ssOut.error && ssOut.status === 0 && ssOut.stdout) {
          peerMap = parseSsUnixPeerInodes(ssOut.stdout, localInodes);
        }
      } catch {
        // Fall through to `lsof +E` fallback.
      }
      if (!peerMap) {
        try {
          const lsofOut = spawnSync("lsof", ["+E", "-nP", "-a", "-p", String(selfPid), "-F", "pftin"], {
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          if (!lsofOut.error && lsofOut.stdout) {
            peerMap = parseLinuxLsofUnixPeerInodes(
              lsofOut.stdout,
              selfPid,
              new Set(localSocketInodeToFd.values()),
              localInodes,
            );
          }
        } catch {
          // Fail closed when neither `ss` nor `lsof` can resolve socketpair peers.
        }
      }
      if (peerMap) {
        for (const [localInode, peerInode] of peerMap) {
          const sourceFd = localSocketInodeToFd.get(localInode);
          if (sourceFd !== undefined) {
            expectedTargetToSourceFd.set(`socket:[${peerInode}]`, sourceFd);
          }
        }
      }
    }
    if (expectedTargetToSourceFd.size === 0) return verified;

    for (const cand of candidates) {
      if (!cand.startId) continue;
      let entries: string[];
      try {
        entries = readdirSync(`/proc/${cand.pid}/fd`);
      } catch {
        continue;
      }
      let matchedSourceFd: number | undefined;
      for (const entry of entries) {
        try {
          const link = readlinkSync(`/proc/${cand.pid}/fd/${entry}`);
          const sourceFd = expectedTargetToSourceFd.get(link);
          if (sourceFd !== undefined) {
            matchedSourceFd = sourceFd;
            break;
          }
        } catch {
          // FD closed mid-scan; keep checking remaining FDs.
        }
      }
      if (matchedSourceFd === undefined) continue;
      // Re-verify both ends after FD inspection to close PID-reuse / FD-reuse TOCTOU.
      if (isTransportFdStillOpen && !isTransportFdStillOpen(matchedSourceFd)) continue;
      try {
        if (readlinkSync(`/proc/self/fd/${matchedSourceFd}`) !== fdTargetByFd.get(matchedSourceFd)) continue;
      } catch {
        continue;
      }
      const postStat = readLinuxProcStat(cand.pid);
      if (postStat && postStat.pgid === pgid && postStat.startId === cand.startId) {
        verified.add(cand.pid);
      }
    }
    return verified;
  }

  if (process.platform === "darwin") {
    const openFds = validFds.filter((fd) => !isTransportFdStillOpen || isTransportFdStillOpen(fd));
    if (openFds.length === 0) return verified;
    const candidateByPid = new Map<number, ObservedProcessEntry>();
    for (const cand of candidates) {
      if (cand.startId) candidateByPid.set(cand.pid, cand);
    }
    if (candidateByPid.size === 0) return verified;
    try {
      const pids = [selfPid, ...candidateByPid.keys()].join(",");
      const out = spawnSync("lsof", ["-nP", "-p", pids, "-F", "pftdDn"], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (out.error || !out.stdout) return verified;
      const matched = parseDarwinLsofSharedPipeMatches(
        out.stdout,
        selfPid,
        new Set(openFds),
        new Set(candidateByPid.keys()),
      );
      for (const [pid, matchedFds] of matched) {
        const cand = candidateByPid.get(pid);
        if (!cand?.startId) continue;
        if (![...matchedFds].some((fd) => !isTransportFdStillOpen || isTransportFdStillOpen(fd))) continue;
        if (readProcessStartId(cand.pid) === cand.startId) {
          verified.add(cand.pid);
        }
      }
    } catch {
      // Fail closed if `lsof` is absent or errors.
    }
    return verified;
  }

  return verified;
}

/**
 * Pure incarnation-proof selector for post-exit survivor capture.
 *
 * A non-zombie same-UID member of `pgid` is captured ONLY when `pgid` has not
 * been reused by a foreign leader AND the member (or its same-UID ancestor in
 * `pgid`) is proven to belong to this incarnation by at least one of:
 *   1. Exact `{ pid, startId }` match in `preExitMembers` observed alongside our
 *      verified live leader;
 *   2. Membership in `pipeVerifiedPids` (proven to hold our transport's own
 *      open anonymous stdio pipe/socketpair endpoint);
 *   3. Live ancestry from `parentPid` (e.g. leader not yet reaped).
 *
 * Never accepts a leaderless candidate solely on `!live(pgid)` + `startId >= leaderStartId`.
 */
export function selectVerifiedProcessGroupSurvivors(
  input: VerifyProcessGroupSurvivorsInput,
): ProcessIncarnationSurvivor[] {
  const { pgid, processes, leaderStartId, parentPid, currentUid, preExitMembers, pipeVerifiedPids } = input;
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return [];
  const byPid = new Map<number, ObservedProcessEntry>();
  const members: ObservedProcessEntry[] = [];
  for (const proc of processes) {
    byPid.set(proc.pid, proc);
    if (proc.pgid === pgid) members.push(proc);
  }
  if (members.length === 0) return [];
  const leader = byPid.get(pgid);
  if (leader) {
    const isOwnUnreapedLeader =
      parentPid !== undefined &&
      leader.ppid === parentPid &&
      Boolean(leaderStartId) &&
      leader.startId === leaderStartId;
    if (!isOwnUnreapedLeader) return [];
  }
  const sameUidMembers: ObservedProcessEntry[] = [];
  const sameUidByPid = new Map<number, ObservedProcessEntry>();
  for (const proc of members) {
    if (proc.pid === pgid) continue;
    if (currentUid !== undefined && proc.uid !== currentUid) continue;
    if (!proc.startId || !startIdNotOlderThan(proc.startId, leaderStartId)) continue;
    sameUidMembers.push(proc);
    sameUidByPid.set(proc.pid, proc);
  }
  if (sameUidMembers.length === 0) return [];

  const preExitKeys = new Set<string>();
  if (preExitMembers) {
    for (const entry of preExitMembers) {
      if (Number.isSafeInteger(entry.pid) && entry.pid > 0 && entry.pid !== pgid && entry.startId.length > 0) {
        preExitKeys.add(`${entry.pid}:${entry.startId}`);
      }
    }
  }
  const verifiedRoots = new Set<number>();
  for (const member of sameUidMembers) {
    if (preExitKeys.has(`${member.pid}:${member.startId}`)) {
      verifiedRoots.add(member.pid);
      continue;
    }
    if (!member.zombie && pipeVerifiedPids?.has(member.pid)) {
      verifiedRoots.add(member.pid);
      continue;
    }
    if (parentPid !== undefined && isDescendantOfPid(member, parentPid, byPid)) {
      verifiedRoots.add(member.pid);
    }
  }
  if (verifiedRoots.size === 0) return [];

  const survivors: ProcessIncarnationSurvivor[] = [];
  for (const member of sameUidMembers) {
    if (member.zombie) continue;
    if (isDescendantInGroup(member, verifiedRoots, sameUidByPid)) {
      survivors.push({ pid: member.pid, startId: member.startId! });
    }
  }
  return survivors;
}

/**
 * Observes non-zombie same-UID members of `pgid` while our verified live group
 * leader (`pid === pgid`, `ppid === parentPid`, `startId === leaderStartId`,
 * non-zombie) is still present in the same process snapshot.
 */
export function observePreExitProcessGroupMembers(
  pgid: number,
  leaderStartId: string | undefined,
  options: { parentPid?: number } = {},
): ProcessIncarnationSurvivor[] {
  if (
    process.platform === "win32" ||
    !Number.isSafeInteger(pgid) ||
    pgid <= 0 ||
    !leaderStartId ||
    !processGroupExists(pgid)
  ) {
    return [];
  }
  const parentPid = options.parentPid ?? process.pid;
  const processes = listObservedProcesses({ exactStartIdForPgids: new Set([pgid]) });
  if (!processes) return [];
  const leader = processes.find((proc) => proc.pid === pgid);
  if (!leader || leader.zombie || leader.pgid !== pgid || leader.ppid !== parentPid || leader.startId !== leaderStartId) {
    return [];
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const observed: ProcessIncarnationSurvivor[] = [];
  for (const proc of processes) {
    if (proc.pgid !== pgid || proc.pid === pgid || proc.zombie) continue;
    if (currentUid !== undefined && proc.uid !== currentUid) continue;
    if (!proc.startId || !startIdNotOlderThan(proc.startId, leaderStartId)) continue;
    observed.push({ pid: proc.pid, startId: proc.startId });
  }
  return observed;
}

/**
 * Snapshots surviving non-zombie members of `pgid` right after our group leader
 * exited. Fails closed (returns `[]`) unless a candidate (or its same-UID
 * ancestor in `pgid`) is proven to belong to this incarnation via pre-exit
 * live-leader observation, an open inherited transport stdio pipe/socketpair,
 * or live ancestry from `parentPid`.
 */
export function captureProcessGroupSurvivors(
  pgid: number,
  options: CaptureProcessGroupSurvivorsOptions = {},
): ProcessIncarnationSurvivor[] {
  if (process.platform === "win32" || !Number.isSafeInteger(pgid) || pgid <= 0 || !processGroupExists(pgid)) {
    return [];
  }
  const processes = listObservedProcesses({ exactStartIdForPgids: new Set([pgid]) });
  if (!processes) return [];
  const parentPid = options.parentPid ?? process.pid;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const leader = processes.find((proc) => proc.pid === pgid);
  if (leader) {
    const isOwnUnreapedLeader =
      leader.ppid === parentPid &&
      Boolean(options.leaderStartId) &&
      leader.startId === options.leaderStartId;
    if (!isOwnUnreapedLeader) return [];
  }
  const eligibleCandidates = processes.filter(
    (proc) =>
      proc.pgid === pgid &&
      proc.pid !== pgid &&
      !proc.zombie &&
      (currentUid === undefined || proc.uid === currentUid) &&
      Boolean(proc.startId) &&
      startIdNotOlderThan(proc.startId, options.leaderStartId),
  );
  if (eligibleCandidates.length === 0) return [];

  // Only invoke pipe/socketpair inspection when there are transport FDs and at least one
  // candidate is not already verified by pre-exit observation or parentPid ancestry.
  let pipeVerifiedPids: Set<number> | undefined;
  if (parentPid === process.pid && options.transportFds && options.transportFds.length > 0) {
    const alreadyVerified = selectVerifiedProcessGroupSurvivors({
      pgid,
      processes,
      leaderStartId: options.leaderStartId,
      parentPid,
      currentUid,
      preExitMembers: options.preExitMembers,
    });
    const alreadyVerifiedPids = new Set(alreadyVerified.map((s) => s.pid));
    const unverifiedCandidates = eligibleCandidates.filter((cand) => !alreadyVerifiedPids.has(cand.pid));
    if (unverifiedCandidates.length > 0) {
      pipeVerifiedPids = findTransportPipeVerifiedPids(
        unverifiedCandidates,
        pgid,
        options.transportFds,
        options.isTransportFdStillOpen,
        parentPid,
      );
    }
  }

  return selectVerifiedProcessGroupSurvivors({
    pgid,
    processes,
    leaderStartId: options.leaderStartId,
    parentPid,
    currentUid,
    preExitMembers: options.preExitMembers,
    pipeVerifiedPids,
  });
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
