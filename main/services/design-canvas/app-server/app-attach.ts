/**
 * Design mode 2c: attaching to a dev server the person already runs (plan D6–D8).
 *
 * Every decision here comes from the process and socket tables. Nothing in
 * this file makes an HTTP request, opens a TCP connection or looks up a name:
 * a server's origin is the loopback address its own sockets hold, never the
 * text a config file or the renderer supplied.
 */
import path from "node:path";
import type { DesignAppRunningServer } from "../../../../renderer/shared/design-app.js";
import { BACKGROUND_JOB_MARKER } from "../../follow-through/background-jobs.js";
import {
  isLoopbackAddress,
  listeningSocketsByProcess,
  MAX_SCAN_PIDS,
  portHolders,
  processFolders,
  processEnvironmentMarks,
  processNames,
  processSubtree,
  processTable,
  type ProcessRow,
  type SocketAddress,
  type SocketReaderDeps,
} from "../../follow-through/listening-ports.js";

const ATTACH_URL_MAX = 256;
const ATTACH_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/u;

/**
 * An `apps[].url` from `.aiden/canvas.json` (D7): `http:`, a host of exactly
 * `localhost`, `127.0.0.1` or `[::1]`, an explicit port from 1024 to 65535,
 * no credentials, query or fragment, and a path that is empty or `/`. `url`
 * is the text without its trailing slash, for display only.
 */
export function parseAttachUrl(text: unknown): { ok: true; url: string; port: number } | { ok: false } {
  if (typeof text !== "string" || text.length > ATTACH_URL_MAX) return { ok: false };
  const match = ATTACH_URL.exec(text);
  if (!match) return { ok: false };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return { ok: false };
  return { ok: true, url: `http://${match[1]}:${match[2]}`, port };
}

const IPV4_LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

/** Every origin a server holding `sockets` can be loaded at on `port`: exactly 127.0.0.1 (or its mapped form) and ::1. */
export function attachOrigins(sockets: ReadonlyArray<SocketAddress>, port: number): string[] {
  const onPort = sockets.filter((socket) => socket.port === port);
  const origins: string[] = [];
  if (onPort.some((socket) => IPV4_LOOPBACK.has(socket.address))) origins.push(`http://127.0.0.1:${port}`);
  if (onPort.some((socket) => socket.address === "::1")) origins.push(`http://[::1]:${port}`);
  return origins;
}

/** The origin Aiden registers for an attached server (A-M2): 127.0.0.1 when held, else [::1], else none. */
export function attachOrigin(sockets: ReadonlyArray<SocketAddress>, port: number): string | undefined {
  return attachOrigins(sockets, port)[0];
}

// ── Finding the person's running servers, and checking one before it attaches ──

/** Ports never listed or attached (D6): the remote debugging port, the inspector and Vite's legacy HMR port. */
export const ATTACH_EXCLUDED_PORTS: readonly number[] = Object.freeze([9222, 9229, 24678]);
const MIN_ATTACH_PORT = 1024;
const MAX_ROWS = 20;
const MAX_FOLDER_CHARS = 200;

export interface AttachScanDeps {
  reader: SocketReaderDeps;
  /** The person's uid: only their processes are listed or attached. */
  uid: number;
  /** Aiden's own pid: its descendants are Aiden's, except under a terminal-drawer shell. */
  self: number;
  realpath(target: string): Promise<string>;
  lstat(target: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  /** The fixed list plus `AIDEN_RENDERER_URL`'s port. */
  excludedPorts(): ReadonlySet<number>;
  /** Every pid in a running background job's tree (`BackgroundJobs.ownedPids`). */
  ownedPids(rows: readonly ProcessRow[]): ReadonlySet<number>;
  /** The terminal drawer's shells (`TerminalService.shellPids`): what runs under them is the person's. */
  terminalShellPids(): readonly number[];
}

/** Aiden's processes (A-M1): every job tree, and every descendant of Aiden not under a terminal-drawer shell. */
function aidenProcesses(rows: readonly ProcessRow[], deps: AttachScanDeps): Set<number> {
  const aiden = new Set(processSubtree(rows, deps.self));
  aiden.add(deps.self);
  for (const shell of deps.terminalShellPids()) {
    if (shell === deps.self || !aiden.has(shell)) continue;
    for (const pid of processSubtree(rows, shell)) aiden.delete(pid);
  }
  for (const pid of deps.ownedPids(rows)) aiden.add(pid);
  return aiden;
}

/** `folder` relative to `root`, POSIX; undefined when it isn't `root` or inside it. Never a string-prefix test. */
function relativeInside(root: string, folder: string): string | undefined {
  const relative = path.relative(root, folder);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

/** The entry every background job's processes start with (A-M2), whatever the job id. */
const JOB_MARKER_PREFIX = `${BACKGROUND_JOB_MARKER}=`;

/**
 * Whether a holder's subtree may attach as far as background jobs go (A-M2):
 * `marked` when a process in it carries a job's marker (a job's child that
 * left the job's tree with `setsid` is still the job's), `unreadable` when an
 * environment couldn't be read. Fails closed: a failed read is `unreadable`.
 */
async function jobMarkVerdict(subtree: readonly number[], deps: AttachScanDeps): Promise<"clear" | "marked" | "unreadable"> {
  const marks = await processEnvironmentMarks(subtree, JOB_MARKER_PREFIX, deps.reader);
  if (!marks.ok) return "unreadable";
  if (subtree.some((pid) => marks.marked.has(pid))) return "marked";
  return subtree.some((pid) => marks.unreadable.has(pid)) ? "unreadable" : "clear";
}

const excluded = (port: number, deps: AttachScanDeps) =>
  !Number.isInteger(port) || port < MIN_ATTACH_PORT || port > 65_535 || ATTACH_EXCLUDED_PORTS.includes(port) || deps.excludedPorts().has(port);

/** The holders of a port that have no holder of the same port above them by parent pid. */
function outermostHolders(rows: readonly ProcessRow[], holders: readonly number[]): number[] {
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  const set = new Set(holders);
  return holders.filter((pid) => {
    const seen = new Set<number>();
    let up = parent.get(pid);
    while (up !== undefined && up > 1 && !seen.has(up)) {
      if (set.has(up)) return false;
      seen.add(up);
      up = parent.get(up);
    }
    return true;
  });
}

/** The deepest root holding `folder` (both workspace-relative POSIX), else the folder itself (B-M3). */
export function deepestRoot(roots: readonly string[], folder: string): string {
  let best: string | undefined;
  for (const root of roots) {
    const inside = root === "." || folder === root || folder.startsWith(`${root}/`);
    if (inside && (best === undefined || best === "." || root.length > best.length)) best = root;
  }
  return best ?? folder;
}

type SubtreeVerdict = { ok: true; origin: string; held: string[] } | { ok: false; why: "beyond-loopback" | "other-address" | "other-user" };

/** D8 steps 4–6 over a holder's subtree: every process the person's, every socket loopback, then the exact origin. */
function judgeSubtree(
  rows: readonly ProcessRow[],
  holder: number,
  port: number,
  uid: number,
  socketsOf: (pid: number) => readonly SocketAddress[],
): SubtreeVerdict {
  const uidOf = new Map(rows.map((row) => [row.pid, row.uid]));
  const subtree = processSubtree(rows, holder);
  if (subtree.some((pid) => uidOf.get(pid) !== uid)) return { ok: false, why: "other-user" };
  const sockets = subtree.flatMap((pid) => socketsOf(pid));
  if (sockets.some((socket) => !isLoopbackAddress(socket.address))) return { ok: false, why: "beyond-loopback" };
  const origin = attachOrigin(sockets, port);
  if (!origin) return { ok: false, why: "other-address" };
  const held = [...new Set(sockets.filter((socket) => socket.port === port).map((socket) => socket.address))];
  return { ok: true, origin, held };
}

const shortFolder = (folder: string) => ([...folder].length > MAX_FOLDER_CHARS ? `${[...folder].slice(0, MAX_FOLDER_CHARS - 1).join("")}…` : folder);

/**
 * Connect running server… (D6): loopback servers the person's own processes
 * run from this workspace's folder, read from the process and socket tables
 * only when the person asks. Discovery may be partial (`incomplete`); every
 * pick is re-checked strictly by `checkAttach`.
 */
export async function scanRunningServers(
  input: { workspacePath: string; roots: readonly string[]; busyRoots: ReadonlySet<string> },
  deps: AttachScanDeps,
): Promise<{ ok: true; incomplete: boolean; servers: DesignAppRunningServer[] } | { ok: false }> {
  const table = await processTable(deps.reader);
  if (!table.ok) return { ok: false };
  const rows = table.rows;
  const aiden = aidenProcesses(rows, deps);
  // The uid filter runs before any folder is read (A-m1).
  const mine = rows.filter((row) => row.uid === deps.uid && row.pid > 1);
  const kept = mine.filter((row) => !aiden.has(row.pid)).map((row) => row.pid);
  const folders = await processFolders(kept, deps.reader, { uid: deps.uid, maxPids: MAX_SCAN_PIDS, partial: true });
  if (!folders.ok) return { ok: false };
  let workspaceReal: string;
  try {
    workspaceReal = await deps.realpath(input.workspacePath);
  } catch {
    return { ok: false };
  }
  const inside = new Map<number, string>();
  for (const [pid, folder] of folders.byPid) {
    const relative = relativeInside(workspaceReal, folder);
    if (relative !== undefined) inside.set(pid, relative);
  }
  // Each inside process's subtree is read, so a child's wildcard shows; Aiden's own processes are read only to drop their ports.
  const myPids = new Set(mine.map((row) => row.pid));
  const subtreePids = new Set<number>();
  for (const pid of inside.keys()) for (const member of processSubtree(rows, pid)) if (myPids.has(member)) subtreePids.add(member);
  for (const pid of aiden) if (myPids.has(pid) && pid !== deps.self) subtreePids.add(pid);
  if (subtreePids.size > MAX_SCAN_PIDS) return { ok: false };
  const read = await listeningSocketsByProcess([...subtreePids], deps.reader, { partial: true });
  if (!read.ok) return { ok: false };
  const socketsOf = (pid: number) => read.byPid.get(pid) ?? [];
  const aidenPorts = new Set([...aiden].flatMap((pid) => socketsOf(pid).map((socket) => socket.port)));
  const holdersByPort = new Map<number, number[]>();
  for (const pid of inside.keys()) {
    for (const socket of socketsOf(pid)) {
      if (excluded(socket.port, deps) || aidenPorts.has(socket.port)) continue;
      const list = holdersByPort.get(socket.port) ?? [];
      if (!list.includes(pid)) list.push(pid);
      holdersByPort.set(socket.port, list);
    }
  }
  const listed = [...holdersByPort.keys()].sort((left, right) => left - right).slice(0, MAX_ROWS);
  const chosen = new Map(listed.map((port) => [port, outermostHolders(rows, holdersByPort.get(port)!).sort((a, b) => a - b)[0]!]));
  // A background job's processes are Aiden's wherever they run now (A-M2); an environment that can't be read hides the row.
  // Another user's process in a subtree is listed as other-user instead; its environment is never read.
  const subtreeOf = new Map([...new Set(chosen.values())].map((pid) => [pid, processSubtree(rows, pid).filter((member) => myPids.has(member))]));
  const marks = await processEnvironmentMarks([...new Set([...subtreeOf.values()].flat())], JOB_MARKER_PREFIX, deps.reader);
  if (!marks.ok) return { ok: false };
  let hidden = false;
  const visible = listed.filter((port) => {
    const subtree = subtreeOf.get(chosen.get(port)!)!;
    if (subtree.some((pid) => marks.marked.has(pid))) return false;
    if (subtree.some((pid) => marks.unreadable.has(pid))) {
      hidden = true;
      return false;
    }
    return true;
  });
  const names = await processNames([...new Set(visible.map((port) => chosen.get(port)!))], deps.reader);
  if (!names.ok) return { ok: false };
  const servers: DesignAppRunningServer[] = visible.map((port) => {
    const pid = chosen.get(port)!;
    const folder = inside.get(pid)!;
    const appRoot = deepestRoot(input.roots, folder);
    const verdict = judgeSubtree(rows, pid, port, deps.uid, socketsOf);
    const base = { port, pid, appRoot: shortFolder(appRoot), folder: shortFolder(folder), processName: names.byPid.get(pid) ?? "" };
    if (!verdict.ok) return { ...base, connectable: false, why: verdict.why };
    if (input.busyRoots.has(appRoot)) return { ...base, connectable: false, why: "already-running" as const };
    return { ...base, origin: verdict.origin, connectable: true };
  });
  return { ok: true, incomplete: folders.incomplete || read.incomplete === true || hidden, servers };
}

export type AttachCheck =
  /**
   * `ident`: the holder's identity (`ProcessRow.ident`) from the table these checks read. The watch compares it every
   * tick to notice a lost holder; the folder and job rules it can't vouch for are re-checked every tick too (`recheckAttached`).
   */
  | { ok: true; pid: number; ppid: number; ident: string; origin: string; held: string[]; processName: string; folder: string }
  | { ok: false; problem: "attach-not-loopback" | "attach-unreachable" | "attach-not-in-app" };

/** `appRoot`'s real folder (D7): an existing folder that isn't a link, inside the workspace's real folder. */
async function realAppRoot(workspaceReal: string, workspacePath: string, appRoot: string, deps: AttachScanDeps): Promise<string | undefined> {
  if (path.isAbsolute(appRoot) || appRoot.split("/").includes("..")) return undefined;
  const folder = appRoot === "." ? workspacePath : path.join(workspacePath, ...appRoot.split("/"));
  try {
    const info = await deps.lstat(folder);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    const real = await deps.realpath(folder);
    return relativeInside(workspaceReal, real) === undefined ? undefined : real;
  } catch {
    return undefined;
  }
}

/**
 * Whether the server on `port` may attach for `appRoot` (D8), in order: an
 * allowed port; this user's outermost listener on it (`pid`, when given, must
 * be that holder); not Aiden's; its folder inside the app root, itself inside
 * the workspace; every process in its subtree the person's; every socket
 * loopback; and an exact loopback origin. Fails closed at every read, and
 * when `ps` gave the holder no identity to bind the attachment to.
 */
export async function checkAttach(
  input: { workspacePath: string; appRoot: string; port: number; pid?: number },
  deps: AttachScanDeps,
): Promise<AttachCheck> {
  const notInApp = { ok: false, problem: "attach-not-in-app" } as const;
  const unreachable = { ok: false, problem: "attach-unreachable" } as const;
  const notLoopback = { ok: false, problem: "attach-not-loopback" } as const;
  if (excluded(input.port, deps)) return notInApp;
  const holders = await portHolders(input.port, deps.uid, deps.reader);
  if (!holders.ok || !holders.pids.length) return unreachable;
  const table = await processTable(deps.reader, { identity: true });
  if (!table.ok) return unreachable;
  const rows = table.rows;
  const outermost = outermostHolders(rows, holders.pids.filter((pid) => rows.some((row) => row.pid === pid))).sort((a, b) => a - b);
  if (!outermost.length) return unreachable;
  const holder = input.pid !== undefined ? outermost.find((pid) => pid === input.pid) : outermost[0];
  if (holder === undefined) return notInApp;
  if (aidenProcesses(rows, deps).has(holder)) return notInApp;
  const holderRow = rows.find((row) => row.pid === holder)!;
  if (holderRow.ident === undefined) return unreachable;
  let workspaceReal: string;
  try {
    workspaceReal = await deps.realpath(input.workspacePath);
  } catch {
    return notInApp;
  }
  const rootReal = await realAppRoot(workspaceReal, input.workspacePath, input.appRoot, deps);
  if (!rootReal) return notInApp;
  const folders = await processFolders([holder], deps.reader, { uid: deps.uid, maxPids: 1 });
  const folder = folders.ok ? folders.byPid.get(holder) : undefined;
  if (folder === undefined || relativeInside(rootReal, folder) === undefined) return notInApp;
  const subtree = processSubtree(rows, holder);
  const uidOf = new Map(rows.map((row) => [row.pid, row.uid]));
  if (subtree.some((pid) => uidOf.get(pid) !== deps.uid)) return notLoopback;
  const marked = await jobMarkVerdict(subtree, deps);
  if (marked === "marked") return notInApp;
  if (marked === "unreadable") return unreachable;
  const read = await listeningSocketsByProcess(subtree, deps.reader);
  if (!read.ok) return unreachable;
  const verdict = judgeSubtree(rows, holder, input.port, deps.uid, (pid) => read.byPid.get(pid) ?? []);
  if (!verdict.ok) return verdict.why === "other-address" ? unreachable : notLoopback;
  const names = await processNames([holder], deps.reader);
  const processName = names.ok ? names.byPid.get(holder) : undefined;
  if (processName === undefined) return unreachable;
  return {
    ok: true,
    pid: holder,
    ppid: holderRow.ppid,
    ident: holderRow.ident,
    origin: verdict.origin,
    held: verdict.held,
    processName,
    folder: shortFolder(relativeInside(workspaceReal, folder)!),
  };
}

// ── Watch-mode re-binds (D9, A-M5) ──

/** Processes looked at under the old parent, at most. */
const MAX_REBIND_PIDS = 256;

/**
 * The process that took over an attached server's port after its holder
 * exited, or undefined: it must be under the holder's old parent, which is
 * still alive and the person's (and not launchd or init), hold one of the
 * same loopback addresses on the same port, and have a subtree that is all
 * the person's and all loopback. Pure: the caller read `rows` and the
 * sockets of the parent's subtree.
 */
export function rebindHolder(
  rows: readonly ProcessRow[],
  socketsOf: (pid: number) => readonly SocketAddress[],
  input: { ppid: number; uid: number; port: number; held: readonly string[] },
): { pid: number; ppid: number } | undefined {
  const parent = rows.find((row) => row.pid === input.ppid);
  if (!parent || parent.pid <= 1 || parent.uid !== input.uid) return undefined;
  const under = processSubtree(rows, parent.pid).filter((pid) => pid !== parent.pid);
  const holders = under.filter((pid) =>
    socketsOf(pid).some((socket) => socket.port === input.port && input.held.includes(socket.address)),
  );
  const holder = outermostHolders(rows, holders).sort((a, b) => a - b)[0];
  if (holder === undefined) return undefined;
  const verdict = judgeSubtree(rows, holder, input.port, input.uid, socketsOf);
  if (!verdict.ok) return undefined;
  return { pid: holder, ppid: rows.find((row) => row.pid === holder)!.ppid };
}

export type RebindInput = { ppid: number; port: number; held: readonly string[]; workspacePath: string; appRoot: string };

/**
 * What a look for a re-bind found: nothing yet (`undefined`, the watch keeps
 * waiting), the new holder, or a new holder that may not attach, which
 * detaches at once with that problem.
 */
export type RebindResult =
  | { ok: true; pid: number; ppid: number; ident: string }
  | { ok: false; problem: "attach-not-in-app" | "attach-unreachable" }
  | undefined;

/**
 * `rebindHolder` over a fresh process table and a strict socket read of the
 * old parent's subtree. The new holder then passes the attach check's folder
 * and job rules again (A-M1, A-M2): its folder, read strictly, inside the app
 * root's real folder, itself inside the workspace's; and no background job's
 * marker in its subtree. A folder or environment that can't be read refuses,
 * and so does a holder `ps` gave no identity (`ProcessRow.ident`) to bind to.
 * The same holder whose identity changed (an `exec` in place) comes here too,
 * so it passes every one of these checks again.
 */
export async function findRebind(input: RebindInput, deps: AttachScanDeps): Promise<RebindResult> {
  if (input.ppid <= 1) return undefined;
  const table = await processTable(deps.reader, { identity: true });
  if (!table.ok) return undefined;
  const under = processSubtree(table.rows, input.ppid);
  if (!under.length || under.length > MAX_REBIND_PIDS) return undefined;
  const aiden = aidenProcesses(table.rows, deps);
  const read = await listeningSocketsByProcess(under, deps.reader);
  if (!read.ok) return undefined;
  const found = rebindHolder(table.rows, (pid) => read.byPid.get(pid) ?? [], { ...input, uid: deps.uid });
  if (!found) return undefined;
  const notInApp = { ok: false, problem: "attach-not-in-app" } as const;
  if (aiden.has(found.pid)) return notInApp;
  let workspaceReal: string;
  try {
    workspaceReal = await deps.realpath(input.workspacePath);
  } catch {
    return notInApp;
  }
  const rootReal = await realAppRoot(workspaceReal, input.workspacePath, input.appRoot, deps);
  if (!rootReal) return notInApp;
  const folders = await processFolders([found.pid], deps.reader, { uid: deps.uid, maxPids: 1 });
  const folder = folders.ok ? folders.byPid.get(found.pid) : undefined;
  if (folder === undefined || relativeInside(rootReal, folder) === undefined) return notInApp;
  const marked = await jobMarkVerdict(processSubtree(table.rows, found.pid), deps);
  if (marked === "marked") return notInApp;
  if (marked === "unreadable") return { ok: false, problem: "attach-unreachable" };
  const ident = table.rows.find((row) => row.pid === found.pid)?.ident;
  if (ident === undefined) return { ok: false, problem: "attach-unreachable" };
  return { ok: true, ...found, ident };
}

// ── The attached watch's every-tick re-check (D9; Pullfrog r4684345118) ──

export type RecheckInput = { holder: number; subtree: readonly number[]; workspacePath: string; appRoot: string };

/**
 * What a tick's re-check found: the holder may stay attached; it may not, and
 * detaches at once with `problem`; or the look failed (`reason`), which the
 * watch counts toward its three failed looks.
 */
export type AttachRecheck =
  | { ok: true }
  | { ok: false; problem: "attach-not-in-app" | "attach-unreachable" }
  | { ok: false; reason: string };

/**
 * The attach check's folder and job rules, again, for a holder the watch
 * still has: an `exec` in place that keeps the program's name keeps its pid,
 * start time and command, so `ProcessRow.ident` can't show it. Runs every
 * tick, whatever the identity says, over the tick's own subtree. Two
 * batched reads: one lsof (or /proc) read of the holder's folder, which must
 * be inside the app root's real folder, itself inside the workspace's; and
 * one environment read of the subtree, where any background job's marker
 * refuses and an environment that can't be read fails closed. A member that
 * exited since the tick's process table runs nothing and is skipped. A failed
 * read, or a holder that has gone, is a failed look, not a verdict: the next
 * tick's table decides whether it was lost. Never signals anything.
 */
export async function recheckAttached(input: RecheckInput, deps: AttachScanDeps): Promise<AttachRecheck> {
  const notInApp = { ok: false, problem: "attach-not-in-app" } as const;
  let workspaceReal: string;
  try {
    workspaceReal = await deps.realpath(input.workspacePath);
  } catch {
    return notInApp;
  }
  const rootReal = await realAppRoot(workspaceReal, input.workspacePath, input.appRoot, deps);
  if (!rootReal) return notInApp;
  const folders = await processFolders([input.holder], deps.reader, { uid: deps.uid, maxPids: 1 });
  if (!folders.ok) return { ok: false, reason: folders.reason };
  const folder = folders.byPid.get(input.holder);
  if (folder === undefined) return { ok: false, reason: "the holder's folder wasn't shown" };
  if (relativeInside(rootReal, folder) === undefined) return notInApp;
  const subtree = input.subtree.includes(input.holder) ? input.subtree : [input.holder, ...input.subtree];
  const marks = await processEnvironmentMarks(subtree, JOB_MARKER_PREFIX, deps.reader);
  if (!marks.ok) return { ok: false, reason: marks.reason };
  if (subtree.some((pid) => marks.marked.has(pid))) return notInApp;
  if (marks.gone.has(input.holder)) return { ok: false, reason: "the holder has gone" };
  if (subtree.some((pid) => marks.unreadable.has(pid) && !marks.gone.has(pid))) return { ok: false, problem: "attach-unreachable" };
  return { ok: true };
}

/** What `DesignAppServers` asks of the attach code: the scan, the check, re-binds, each tick's re-check and the workspace's real folder. */
export interface DesignAppAttachDeps {
  /** The person's uid: every process in an attached subtree must be theirs. */
  uid: number;
  scan(input: { workspacePath: string; roots: readonly string[]; busyRoots: ReadonlySet<string> }): ReturnType<typeof scanRunningServers>;
  check(input: { workspacePath: string; appRoot: string; port: number; pid?: number }): Promise<AttachCheck>;
  rebind(input: RebindInput): Promise<RebindResult>;
  recheck(input: RecheckInput): Promise<AttachRecheck>;
  realpath(target: string): Promise<string>;
}

export function designAppAttachDeps(deps: AttachScanDeps): DesignAppAttachDeps {
  return {
    uid: deps.uid,
    scan: (input) => scanRunningServers(input, deps),
    check: (input) => checkAttach(input, deps),
    rebind: (input) => findRebind(input, deps),
    recheck: (input) => recheckAttached(input, deps),
    realpath: (target) => deps.realpath(target),
  };
}
