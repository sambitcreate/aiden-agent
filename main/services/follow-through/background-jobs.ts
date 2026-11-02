// Background jobs: shell commands the agent leaves running (a dev server, a
// watcher, a long test run) while it keeps working. Each job runs in its own
// process group with the workspace folder as its working directory. Output
// goes to a session log file and a bounded in-memory tail. Stopping asks the
// whole group to end, then forces it after a grace period. A job that ends on
// its own is reported through `onEnded` so the chat hears about it.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  isBackgroundJobId,
  MAX_BACKGROUND_JOB_PORTS,
  type BackgroundJobEndReason,
  type BackgroundJobState,
  type BackgroundJobView,
} from "../../../renderer/shared/background-jobs.js";
import { tailText } from "../../../renderer/shared/agent-notices.js";
import { defaultListeningPortsByProcess } from "./listening-ports.js";

export const MAX_RUNNING_JOBS_PER_CHAT = 10;
export const MAX_RUNNING_JOBS = 20;
export const MAX_JOB_LOG_BYTES = 50 * 1024 * 1024;
/** Characters kept in memory per job; reads return at most this much. */
export const JOB_TAIL_CHARS = 20_000;
export const JOB_STOP_GRACE_MS = 4_000;
/** Finished jobs each chat keeps listing (with their logs) in this session. */
export const MAX_FINISHED_JOBS_PER_CHAT = 10;
/**
 * Finished jobs kept across all chats, so many open chats cannot pile up tails.
 * Over the cap, the chat with the most finished jobs loses its oldest first, so
 * one busy chat cannot push out another chat's only result.
 */
export const MAX_FINISHED_JOBS = 50;
export const MAX_JOB_COMMAND_CHARS = 4_000;
export const MAX_JOB_DESCRIPTION_CHARS = 120;
/** How often ports are looked up while jobs run; a job past its first minute is looked at less often. */
export const JOB_PORT_SCAN_MS = 3_000;
export const JOB_SETTLED_PORT_SCAN_MS = 30_000;
const JOB_PORT_SETTLE_AGE_MS = 60_000;
/** How often an adopted job's process group is checked for having ended. */
export const ADOPTED_JOB_POLL_MS = 1_000;
/** How many polls pass between looks for a job's own (marked) processes. */
const ADOPTED_JOB_OWNER_CHECK_POLLS = 5;
/**
 * How long what a command left behind must keep running before it is taken
 * over, so a straggler that is already exiting is not listed as a job.
 */
export const ADOPT_SETTLE_MS = 500;
/**
 * Ports a dev tool opens beside the address a person would open: the Node
 * inspector and Vite's hot-reload socket. They are never listed.
 */
const UNLISTED_PORTS = new Set([9229, 24678]);
/** The environment entry that marks a job's processes, so cleanup never touches anything else. */
export const BACKGROUND_JOB_MARKER = "AIDEN_BACKGROUND_JOB";
const ADOPTED_JOB_NOTE =
  "[A command left this running. Aiden can stop it, but it does not see its output or exit code.]\n";
const ADOPTED_JOB_OUTPUT_NOTE = "[A command left this running. Its output from here on is below; it has no exit code.]\n";

export interface BackgroundJobEnded {
  job: BackgroundJobView;
  /** The end of the output, for the notice. */
  tail: string;
}

export interface BackgroundJobsOptions {
  /** Session log directory; created on first start. */
  logDir: string;
  now?: () => number;
  /** A job ended by itself (exit) or hit the output limit; never for a stop someone asked for. */
  onEnded?: (ended: BackgroundJobEnded) => void;
  /** Any change to any job, for list views. */
  onChange?: (chatId: string) => void;
  stopGraceMs?: number;
  maxLogBytes?: number;
  maxRunningPerChat?: number;
  maxRunning?: number;
  maxFinished?: number;
  /** Reads a process's start time so a later launch can tell it from a reused pid. */
  processStartTime?: (pid: number) => Promise<string | undefined>;
  /** Every process group and its processes, from one look; rejects when it could not look. */
  processGroups?: () => Promise<Map<number, number[]>>;
  /** Lists the processes in a process group; rejects when it could not look. */
  processGroupMembers?: (pgid: number) => Promise<number[]>;
  /**
   * Whether a process was started with this `NAME=value` in its environment.
   * Rejects when the process still runs but could not be read.
   */
  processHasEnvironment?: (pid: number, entry: string) => Promise<boolean>;
  /** The TCP ports each of the given processes listens on; null turns port lookups off. */
  listeningPorts?: ((pids: readonly number[]) => Promise<Map<number, number[]>>) | null;
  portScanMs?: number;
  adoptedPollMs?: number;
  adoptSettleMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** Processes a `run_command` call left running in its process group. */
export interface AdoptBackgroundJobInput {
  /** The id whose marker the command's processes carry (see `newBackgroundJobId`). */
  id: string;
  chatId: string;
  workspaceId: string;
  cwd: string;
  command: string;
  description?: string;
  processGroup: number;
  /** What the leftovers still write to, when they kept the command's output open. */
  output?: { stdout: Readable; stderr: Readable };
}

export interface StartBackgroundJobInput {
  chatId: string;
  workspaceId: string;
  cwd: string;
  command: string;
  description?: string;
  env: NodeJS.ProcessEnv;
}

interface JobRecord {
  view: BackgroundJobView;
  cwd: string;
  child?: ChildProcess;
  log?: fs.WriteStream;
  logPath: string;
  tail: string;
  decoder: StringDecoder;
  stopRequested?: BackgroundJobEndReason;
  forceTimer?: ReturnType<typeof setTimeout>;
  leftoverTimer?: ReturnType<typeof setTimeout>;
  exited: Promise<void>;
  processStart?: string;
  /** Someone is waiting on this job right now and reports its end themselves. */
  watched?: boolean;
  /** An adopted job: the process group a command left running, with no child handle. */
  adoptedGroup?: number;
  adoptedTimer?: ReturnType<typeof setInterval>;
  /** Resolves true once the adopted job has ended, false when its end could not be confirmed. */
  adoptedStop?: Promise<boolean>;
  adoptedOutput?: { stdout: Readable; stderr: Readable };
  settleExited?: () => void;
  nextPortScanAt?: number;
}

/** Durable note of running jobs, so a launch after a crash can stop what was left. */
interface RunningRecordFile {
  version: 1;
  jobs: Array<{ id: string; pid: number; processStart?: string }>;
}

const RECORD_FILE = "running.json";
/** Forced rounds against marked leftovers, each preceded by a fresh look for what the last round missed. */
const FORCED_REAP_ROUNDS = 3;
const FORCED_REAP_WAIT_MS = 1_000;

export function newBackgroundJobId(): string {
  return `job_${randomBytes(4).toString("hex")}`;
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

export function defaultProcessStartTime(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2_000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const value = typeof stdout === "string" ? stdout.trim() : "";
      resolve(error || !value ? undefined : value);
    });
  });
}

export function defaultProcessGroups(): Promise<Map<number, number[]>> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pid=,pgid="], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== "string") return reject(error ?? new Error("ps printed nothing."));
      const groups = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pid, group] = line.trim().split(/\s+/u).map(Number);
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group) || pid! <= 1) continue;
        const members = groups.get(group!) ?? [];
        members.push(pid!);
        groups.set(group!, members);
      }
      resolve(groups);
    });
  });
}

export async function defaultProcessGroupMembers(pgid: number): Promise<number[]> {
  return (await defaultProcessGroups()).get(pgid) ?? [];
}

/** Gone, or a zombie: ended but not yet reaped. */
async function linuxProcessEnded(pid: number): Promise<boolean> {
  const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  // The state follows the command name, which is in parentheses and may hold spaces.
  return !stat || stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
}

export function defaultProcessHasEnvironment(pid: number, entry: string): Promise<boolean> {
  // A process that has gone carries nothing; one that still runs but could
  // not be read is unknown, never "not ours".
  const unreadable = (error: unknown) => (processExists(pid) ? Promise.reject(error) : Promise.resolve(false));
  if (process.platform === "linux") {
    return fsp.readFile(`/proc/${pid}/environ`, "utf8").then(
      (environment) => environment.split("\0").includes(entry),
      // An ended process that nothing has reaped yet has no environment to read.
      async (error: unknown) => ((await linuxProcessEnded(pid)) ? false : unreadable(error)),
    );
  }
  return new Promise<boolean>((resolve, reject) => {
    // macOS prints the environment a process started with after its command.
    execFile("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (!error && typeof stdout === "string") return resolve(stdout.split(/\s+/u).includes(entry));
      unreadable(error).then(resolve, reject);
    });
  });
}

/** A chat, or Aiden, already runs as many background jobs as it may. */
export class BackgroundJobLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundJobLimitError";
  }
}

function signalEach(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

export class BackgroundJobs {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly now: () => number;
  private readonly stopGraceMs: number;
  private readonly maxLogBytes: number;
  private readonly maxRunningPerChat: number;
  private readonly maxRunning: number;
  private readonly maxFinished: number;
  private readonly processStartTime: (pid: number) => Promise<string | undefined>;
  private readonly processGroups: () => Promise<Map<number, number[]>>;
  private readonly processGroupMembers: (pgid: number) => Promise<number[]>;
  private readonly processHasEnvironment: (pid: number, entry: string) => Promise<boolean>;
  private readonly listeningPorts: ((pids: readonly number[]) => Promise<Map<number, number[]>>) | null;
  private readonly portScanMs: number;
  private readonly adoptedPollMs: number;
  private readonly adoptSettleMs: number;
  private portTimer?: ReturnType<typeof setInterval>;
  private portScanRunning = false;
  private recordWrite: Promise<void> = Promise.resolve();
  /** Last launch's jobs whose marked processes outlived cleanup; kept in the record so the next launch tries again. */
  private carriedOver: RunningRecordFile["jobs"] = [];
  private closed = false;

  constructor(private readonly options: BackgroundJobsOptions) {
    this.now = options.now ?? Date.now;
    this.stopGraceMs = options.stopGraceMs ?? JOB_STOP_GRACE_MS;
    this.maxLogBytes = options.maxLogBytes ?? MAX_JOB_LOG_BYTES;
    this.maxRunningPerChat = options.maxRunningPerChat ?? MAX_RUNNING_JOBS_PER_CHAT;
    this.maxRunning = options.maxRunning ?? MAX_RUNNING_JOBS;
    this.maxFinished = options.maxFinished ?? MAX_FINISHED_JOBS;
    this.processStartTime = options.processStartTime ?? defaultProcessStartTime;
    this.processGroups = options.processGroups ?? defaultProcessGroups;
    this.processGroupMembers =
      options.processGroupMembers ?? (async (pgid) => (await this.processGroups()).get(pgid) ?? []);
    this.processHasEnvironment = options.processHasEnvironment ?? defaultProcessHasEnvironment;
    this.listeningPorts = options.listeningPorts === undefined ? defaultListeningPortsByProcess : options.listeningPorts;
    this.portScanMs = options.portScanMs ?? JOB_PORT_SCAN_MS;
    this.adoptedPollMs = options.adoptedPollMs ?? ADOPTED_JOB_POLL_MS;
    this.adoptSettleMs = options.adoptSettleMs ?? ADOPT_SETTLE_MS;
  }

  start(input: StartBackgroundJobInput): BackgroundJobView {
    if (this.closed) throw new Error("Aiden is closing; background jobs cannot start now.");
    if (process.platform === "win32") throw new Error("Background jobs run on macOS and Linux.");
    const command = input.command.trim();
    if (!command) throw new Error("Give the command to run.");
    if (command.length > MAX_JOB_COMMAND_CHARS) throw new Error("The command is too long.");
    this.assertRoomFor(input.chatId);
    fs.mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
    const id = newBackgroundJobId();
    const logPath = path.join(this.options.logDir, `${id}.log`);
    const log = fs.createWriteStream(logPath, { flags: "w", mode: 0o600 });
    log.on("error", (error) => this.options.log?.("A background job log could not be written.", error));
    const description = input.description ? oneLine(input.description, MAX_JOB_DESCRIPTION_CHARS) : "";
    const view: BackgroundJobView = {
      id,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      command,
      ...(description ? { description } : {}),
      state: "running",
      startedAt: this.now(),
      outputBytes: 0,
    };
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const record: JobRecord = {
      view,
      cwd: input.cwd,
      log,
      logPath,
      tail: "",
      decoder: new StringDecoder("utf8"),
      exited,
    };
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: input.cwd,
        detached: true,
        env: { ...input.env, [BACKGROUND_JOB_MARKER]: id },
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.end();
      throw error instanceof Error ? error : new Error(String(error));
    }
    record.child = child;
    if (child.pid) view.pid = child.pid;
    this.jobs.set(id, record);
    const capture = (chunk: Buffer) => this.capture(record, chunk);
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => {
      this.append(record, `\n[Aiden could not run this command: ${error.message}]\n`);
      this.finish(record, null, null);
      resolveExited();
    });
    child.once("exit", () => this.endLeftovers(record));
    child.once("close", (code, signal) => {
      this.finish(record, code, signal);
      resolveExited();
    });
    if (child.pid) {
      const pid = child.pid;
      void this.processStartTime(pid).then((start) => {
        if (start && record.view.state === "running") {
          record.processStart = start;
          this.writeRecord();
        }
      });
    }
    this.writeRecord();
    this.options.onChange?.(input.chatId);
    this.schedulePortScans();
    return { ...view };
  }

  private assertRoomFor(chatId: string): void {
    const running = [...this.jobs.values()].filter((job) => job.view.state === "running");
    if (running.filter((job) => job.view.chatId === chatId).length >= this.maxRunningPerChat) {
      throw new BackgroundJobLimitError(
        `This chat already has ${this.maxRunningPerChat} background jobs running. Stop one before starting another.`,
      );
    }
    if (running.length >= this.maxRunning) {
      throw new BackgroundJobLimitError(
        `Aiden already has ${this.maxRunning} background jobs running. Stop one before starting another.`,
      );
    }
  }

  /**
   * Track what a `run_command` call left running (a server started with a
   * trailing `&`) as a job of the chat, so it is listed, can be stopped, and
   * ends with the chat or with Aiden. Only processes in that group carrying
   * the command's marker count; nothing is adopted without one. Adopted jobs
   * have no exit code, and their end is not announced to the chat. What is
   * still exiting after a short wait is not taken over. Throws
   * `BackgroundJobLimitError` when the chat or Aiden has no room for another
   * job; nothing is adopted then.
   */
  async adopt(input: AdoptBackgroundJobInput): Promise<BackgroundJobView | undefined> {
    if (this.closed || process.platform === "win32") return undefined;
    const group = input.processGroup;
    if (!isBackgroundJobId(input.id) || this.jobs.has(input.id)) return undefined;
    if (!Number.isSafeInteger(group) || group <= 1 || !groupExists(group)) return undefined;
    if (this.adoptSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.adoptSettleMs));
    if (this.closed || this.jobs.has(input.id) || !groupExists(group)) return undefined;
    if (!(await this.markedMembers(group, input.id)).length) return undefined;
    if (this.closed || this.jobs.has(input.id)) return undefined;
    this.assertRoomFor(input.chatId);
    const command = oneLine(input.command, MAX_JOB_COMMAND_CHARS);
    const description = input.description ? oneLine(input.description, MAX_JOB_DESCRIPTION_CHARS) : "";
    const view: BackgroundJobView = {
      id: input.id,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      command,
      ...(description ? { description } : {}),
      state: "running",
      startedAt: this.now(),
      pid: group,
      outputBytes: 0,
      origin: "command",
    };
    let settleExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      settleExited = resolve;
    });
    const logPath = path.join(this.options.logDir, `${input.id}.log`);
    const record: JobRecord = {
      view,
      cwd: input.cwd,
      logPath,
      tail: input.output ? ADOPTED_JOB_OUTPUT_NOTE : ADOPTED_JOB_NOTE,
      decoder: new StringDecoder("utf8"),
      exited,
      adoptedGroup: group,
      settleExited,
    };
    if (input.output) {
      fs.mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
      record.log = fs.createWriteStream(logPath, { flags: "w", mode: 0o600 });
      record.log.on("error", (error) => this.options.log?.("A background job log could not be written.", error));
      record.adoptedOutput = input.output;
      const capture = (chunk: Buffer) => this.capture(record, chunk);
      input.output.stdout.on("data", capture);
      input.output.stderr.on("data", capture);
      // The command paused them when it returned, so nothing is lost meanwhile.
      input.output.stdout.resume();
      input.output.stderr.resume();
    }
    this.jobs.set(input.id, record);
    // The group can outlive the job: a helper started without the marker, or
    // ended processes nobody has reaped yet. So every few polls, look for live
    // marked processes too; a failed look proves nothing and changes nothing.
    let polls = 0;
    let looking = false;
    record.adoptedTimer = setInterval(() => {
      if (!groupExists(group)) {
        this.finishAdopted(record);
        return;
      }
      polls += 1;
      if (polls % ADOPTED_JOB_OWNER_CHECK_POLLS !== 0 || looking || record.adoptedStop) return;
      looking = true;
      void this.markedMembers(group, input.id)
        .then((left) => {
          if (left.length === 0 && !record.adoptedStop) this.finishAdopted(record);
        })
        .catch(() => undefined)
        .finally(() => {
          looking = false;
        });
    }, this.adoptedPollMs);
    record.adoptedTimer.unref?.();
    this.writeRecord();
    this.options.onChange?.(input.chatId);
    this.schedulePortScans();
    return { ...view };
  }

  list(chatId: string): BackgroundJobView[] {
    return [...this.jobs.values()]
      .filter((job) => job.view.chatId === chatId)
      .map((job) => ({ ...job.view }))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  get(chatId: string, jobId: string): BackgroundJobView | undefined {
    const job = this.jobs.get(jobId);
    return job && job.view.chatId === chatId ? { ...job.view } : undefined;
  }

  /** The newest output, at most `maxChars` (default all of the kept tail). */
  read(chatId: string, jobId: string, maxChars = JOB_TAIL_CHARS): { job: BackgroundJobView; output: string; truncated: boolean } {
    const job = this.jobs.get(jobId);
    if (!job || job.view.chatId !== chatId) throw new Error(`There is no background job "${jobId}" in this chat.`);
    const limit = Math.max(1, Math.min(JOB_TAIL_CHARS, Math.floor(maxChars)));
    const { text, truncated } = tailText(job.tail, limit);
    return { job: { ...job.view }, output: text, truncated: truncated || job.view.outputBytes > Buffer.byteLength(job.tail) };
  }

  /**
   * Wait up to `ms` for a job to end. A job that ends while someone waits is
   * reported to that waiter, not through `onEnded`.
   */
  async settle(chatId: string, jobId: string, ms: number): Promise<BackgroundJobView> {
    const job = this.jobs.get(jobId);
    if (!job || job.view.chatId !== chatId) throw new Error(`There is no background job "${jobId}" in this chat.`);
    if (job.view.state !== "running") return { ...job.view };
    job.watched = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally {
      if (timer) clearTimeout(timer);
      job.watched = false;
    }
    return { ...job.view };
  }

  runningCount(chatId?: string): number {
    return [...this.jobs.values()].filter(
      (job) => job.view.state === "running" && (chatId === undefined || job.view.chatId === chatId),
    ).length;
  }

  /** Stop one job: polite first, forced after the grace period. Resolves once it has ended. */
  async stop(chatId: string, jobId: string, reason: BackgroundJobEndReason): Promise<BackgroundJobView> {
    const job = this.jobs.get(jobId);
    if (!job || job.view.chatId !== chatId) throw new Error(`There is no background job "${jobId}" in this chat.`);
    await this.stopRecord(job, reason);
    return { ...job.view };
  }

  async stopChat(chatId: string, reason: BackgroundJobEndReason, forget = false): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => job.view.chatId === chatId);
    await Promise.all(jobs.map((job) => this.stopRecord(job, reason)));
    if (forget) {
      for (const job of jobs) {
        // A stop that could not be confirmed keeps the job, so quitting and
        // the next launch still stop what may be running.
        if (job.view.state === "running") continue;
        this.jobs.delete(job.view.id);
        await fsp.rm(job.logPath, { force: true }).catch(() => undefined);
      }
      this.options.onChange?.(chatId);
    }
  }

  async stopWorkspace(workspaceId: string, reason: BackgroundJobEndReason): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => job.view.workspaceId === workspaceId);
    await Promise.all(jobs.map((job) => this.stopRecord(job, reason)));
  }

  /** Stop everything for quit; no new jobs start afterwards. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.portTimer) clearInterval(this.portTimer);
    this.portTimer = undefined;
    await Promise.all([...this.jobs.values()].map((job) => this.stopRecord(job, "app-quit")));
    await this.recordWrite;
  }

  /**
   * After a crash, jobs from the last launch may still run. Stop each one whose
   * pid still names the same process (same start time). When that shell has
   * already gone, stop what it left in its group, but only processes that
   * carry the job's marker, so a reused pid is never mistaken for a job. A
   * process can start another while it ends, so each forced round looks for
   * marked members again, and a job whose marked processes still run stays
   * in the record for the next launch. Then clear old logs.
   */
  async reapPreviousLaunch(): Promise<number> {
    const recordPath = path.join(this.options.logDir, RECORD_FILE);
    let parsed: RunningRecordFile | undefined;
    try {
      const value = JSON.parse(await fsp.readFile(recordPath, "utf8")) as RunningRecordFile;
      if (value?.version === 1 && Array.isArray(value.jobs)) parsed = value;
    } catch {
      parsed = undefined;
    }
    let stopped = 0;
    const survivors: RunningRecordFile["jobs"] = [];
    for (const entry of parsed?.jobs ?? []) {
      if (!Number.isSafeInteger(entry.pid) || entry.pid <= 1 || !groupExists(entry.pid)) continue;
      const current = entry.processStart ? await this.processStartTime(entry.pid) : undefined;
      if (current && current === entry.processStart) {
        signalGroup(entry.pid, "SIGTERM");
        await this.waitUntil(() => !groupExists(entry.pid));
        if (groupExists(entry.pid)) signalGroup(entry.pid, "SIGKILL");
        stopped += 1;
        continue;
      }
      if (typeof entry.id !== "string" || !/^job_[0-9a-f]{8}$/u.test(entry.id)) continue;
      // A look that failed keeps the job for the next launch rather than counting it as gone.
      const left = await this.endMarked(entry.pid, entry.id).catch(() => undefined);
      if (left === undefined) {
        survivors.push(entry);
        continue;
      }
      if (left.signalled === 0) continue;
      if (left.remaining) survivors.push(entry);
      else stopped += 1;
    }
    this.carriedOver = survivors;
    try {
      for (const name of await fsp.readdir(this.options.logDir)) {
        if (/^job_[0-9a-f]{8}\.log$/u.test(name) || (name === RECORD_FILE && !survivors.length)) {
          await fsp.rm(path.join(this.options.logDir, name), { force: true });
        }
      }
    } catch {
      // No log directory yet.
    }
    if (survivors.length) {
      this.writeRecord();
      await this.recordWrite;
    }
    return stopped;
  }

  /**
   * Ends the processes in the group that carry this job's marker: politely,
   * then forced, looking again each round for any they started meanwhile.
   * Rejects when a look failed, since that proves nothing ended.
   */
  private async endMarked(group: number, jobId: string): Promise<{ signalled: number; remaining: number }> {
    let left = await this.markedMembers(group, jobId);
    const signalled = left.length;
    if (!signalled) return { signalled, remaining: 0 };
    signalEach(left, "SIGTERM");
    const asked = left;
    await this.waitUntil(() => asked.every((pid) => !processExists(pid)));
    for (let round = 0; (left = await this.markedMembers(group, jobId)).length && round < FORCED_REAP_ROUNDS; round += 1) {
      const forced = left;
      signalEach(forced, "SIGKILL");
      await this.waitUntil(() => forced.every((pid) => !processExists(pid)), FORCED_REAP_WAIT_MS);
    }
    return { signalled, remaining: left.length };
  }

  /** Processes in the group that carry this job's marker. */
  private async markedMembers(group: number, jobId: string): Promise<number[]> {
    const marker = `${BACKGROUND_JOB_MARKER}=${jobId}`;
    const found: number[] = [];
    for (const pid of await this.processGroupMembers(group)) {
      if (await this.processHasEnvironment(pid, marker)) found.push(pid);
    }
    return found;
  }

  private async waitUntil(done: () => boolean, withinMs = this.stopGraceMs): Promise<void> {
    const deadline = this.now() + withinMs;
    while (!done() && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * The shell has exited, but what it started in the background can keep the
   * output pipes, and so the job, open. End the rest of its group: politely
   * first, then forced, then let go of the pipes.
   */
  private endLeftovers(job: JobRecord): void {
    const pid = job.child?.pid;
    if (!pid || job.view.state !== "running" || job.forceTimer || !groupExists(pid)) return;
    signalGroup(pid, "SIGTERM");
    job.leftoverTimer = setTimeout(() => {
      if (groupExists(pid)) signalGroup(pid, "SIGKILL");
      const release = setTimeout(() => {
        job.child?.stdout?.destroy();
        job.child?.stderr?.destroy();
      }, 1_000);
      release.unref?.();
    }, this.stopGraceMs);
    job.leftoverTimer.unref?.();
  }

  private stopRecord(job: JobRecord, reason: BackgroundJobEndReason): Promise<void> {
    if (job.view.state !== "running") return job.exited;
    job.stopRequested ??= reason;
    if (job.adoptedGroup !== undefined) {
      const stopping = (job.adoptedStop ??= this.stopAdopted(job, job.adoptedGroup));
      // A stop that could not confirm the end leaves the job running.
      return stopping.then((ended) => (ended ? job.exited : undefined));
    }
    const pid = job.child?.pid;
    if (!pid) return job.exited;
    if (!job.forceTimer) {
      signalGroup(pid, "SIGTERM");
      job.forceTimer = setTimeout(() => {
        if (groupExists(pid)) signalGroup(pid, "SIGKILL");
        // A process that left the group can still hold the output pipes open.
        const release = setTimeout(() => {
          job.child?.stdout?.destroy();
          job.child?.stderr?.destroy();
        }, 1_000);
        release.unref?.();
      }, this.stopGraceMs);
      job.forceTimer.unref?.();
    }
    return job.exited;
  }

  /**
   * Polite, then forced, and only ever to processes carrying the job's marker.
   * The job ends only once its group is gone or a look finds none of them
   * left; otherwise it stays running and listed, and Stop can be tried again.
   */
  private async stopAdopted(job: JobRecord, group: number): Promise<boolean> {
    const left = groupExists(group) ? await this.endMarked(group, job.view.id).catch(() => undefined) : { remaining: 0 };
    if (!groupExists(group) || left?.remaining === 0) {
      this.finishAdopted(job);
      return true;
    }
    this.options.log?.("An adopted background job could not be confirmed stopped; it stays listed.");
    job.adoptedStop = undefined;
    // Not stopping any more: a later end of its own reads as one, and the output limit still applies.
    job.stopRequested = undefined;
    return false;
  }

  private finishAdopted(job: JobRecord): void {
    if (job.view.state !== "running") return;
    if (job.adoptedTimer) clearInterval(job.adoptedTimer);
    // A process that left the group can still hold the output open.
    job.adoptedOutput?.stdout.destroy();
    job.adoptedOutput?.stderr.destroy();
    if (job.log) {
      this.appendTail(job, job.decoder.end());
      job.log.end();
      job.log = undefined;
    }
    const reason = job.stopRequested;
    job.view.state = reason ? "stopped" : "exited";
    job.view.endedAt = this.now();
    delete job.view.ports;
    if (reason) job.view.endReason = reason;
    this.forgetOldFinished(job.view.chatId);
    this.writeRecord();
    this.options.onChange?.(job.view.chatId);
    job.settleExited?.();
  }

  private schedulePortScans(): void {
    if (this.portTimer || !this.listeningPorts || this.closed) return;
    this.portTimer = setInterval(() => void this.scanPorts(), this.portScanMs);
    this.portTimer.unref?.();
  }

  /**
   * Look up the ports each running job listens on: every few seconds for a
   * new job (a dev server takes a moment to bind), less often after its first
   * minute, and not at all once nothing runs.
   */
  async scanPorts(): Promise<void> {
    const lookUp = this.listeningPorts;
    if (!lookUp || this.portScanRunning) return;
    this.portScanRunning = true;
    try {
      const running = [...this.jobs.values()].filter((job) => job.view.state === "running");
      if (!running.length) {
        if (this.portTimer) clearInterval(this.portTimer);
        this.portTimer = undefined;
        return;
      }
      const now = this.now();
      const due = running.filter((job) => (job.nextPortScanAt ?? 0) <= now && (job.adoptedGroup ?? job.child?.pid));
      if (!due.length) return;
      for (const job of due) {
        job.nextPortScanAt =
          now + (now - job.view.startedAt < JOB_PORT_SETTLE_AGE_MS ? 0 : JOB_SETTLED_PORT_SCAN_MS);
      }
      // One look at the process table and one port lookup for every job due.
      const groups = await this.processGroups();
      const members = new Map(due.map((job) => [job, groups.get((job.adoptedGroup ?? job.child?.pid)!) ?? []]));
      const byProcess = await lookUp([...new Set([...members.values()].flat())]);
      for (const job of due) {
        const found = (members.get(job) ?? []).flatMap((pid) => byProcess.get(pid) ?? []);
        const ports = [...new Set(found)]
          .filter((port) => !UNLISTED_PORTS.has(port))
          .sort((left, right) => left - right)
          .slice(0, MAX_BACKGROUND_JOB_PORTS);
        if (job.view.state !== "running") continue;
        const before = job.view.ports ?? [];
        if (ports.length === before.length && ports.every((port, index) => port === before[index])) continue;
        if (ports.length) job.view.ports = ports;
        else delete job.view.ports;
        this.options.onChange?.(job.view.chatId);
      }
    } catch (error) {
      this.options.log?.("Background job ports could not be read.", error);
    } finally {
      this.portScanRunning = false;
    }
  }

  private capture(job: JobRecord, chunk: Buffer): void {
    job.view.outputBytes += chunk.length;
    if (job.view.outputBytes > this.maxLogBytes) {
      if (!job.stopRequested) {
        this.append(job, `\n[Aiden stopped this job: its output passed ${Math.round(this.maxLogBytes / (1024 * 1024))} MB.]\n`);
        void this.stopRecord(job, "output-limit");
      }
      return;
    }
    job.log?.write(chunk);
    this.appendTail(job, job.decoder.write(chunk));
  }

  private append(job: JobRecord, text: string): void {
    job.log?.write(text);
    this.appendTail(job, text);
  }

  private appendTail(job: JobRecord, text: string): void {
    if (!text) return;
    const combined = job.tail + text;
    job.tail = combined.length > JOB_TAIL_CHARS * 2 ? tailText(combined, JOB_TAIL_CHARS).text : combined;
  }

  private finish(job: JobRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (job.view.state !== "running") return;
    if (job.forceTimer) clearTimeout(job.forceTimer);
    if (job.leftoverTimer) clearTimeout(job.leftoverTimer);
    // Anything still in the group after the shell left is ended with it.
    const pid = job.child?.pid;
    if (pid && groupExists(pid)) signalGroup(pid, "SIGKILL");
    this.appendTail(job, job.decoder.end());
    job.log?.end();
    job.log = undefined;
    job.child = undefined;
    const reason = job.stopRequested;
    const state: BackgroundJobState = reason ? "stopped" : code === 0 ? "exited" : "failed";
    job.view.state = state;
    job.view.endedAt = this.now();
    delete job.view.ports;
    job.view.exitCode = code;
    if (signal) job.view.signal = signal;
    if (reason) job.view.endReason = reason;
    this.forgetOldFinished(job.view.chatId);
    this.writeRecord();
    this.options.onChange?.(job.view.chatId);
    if ((!reason || reason === "output-limit") && !job.watched) {
      this.options.onEnded?.({ job: { ...job.view }, tail: job.tail });
    }
  }

  private forgetOldFinished(chatId: string): void {
    const oldestFirst = (left: JobRecord, right: JobRecord) => (left.view.endedAt ?? 0) - (right.view.endedAt ?? 0);
    const byChat = new Map<string, JobRecord[]>();
    let total = 0;
    for (const job of [...this.jobs.values()].filter((record) => record.view.state !== "running").sort(oldestFirst)) {
      const list = byChat.get(job.view.chatId) ?? [];
      list.push(job);
      byChat.set(job.view.chatId, list);
      total += 1;
    }
    const forget: JobRecord[] = [];
    const chatFinished = byChat.get(chatId) ?? [];
    while (chatFinished.length > MAX_FINISHED_JOBS_PER_CHAT) {
      forget.push(chatFinished.shift()!);
      total -= 1;
    }
    while (total > this.maxFinished) {
      // The chat with the most finished jobs gives up its oldest; ties go to the older job.
      let fullest: JobRecord[] | undefined;
      for (const list of byChat.values()) {
        if (
          list.length > 0 &&
          (!fullest ||
            list.length > fullest.length ||
            (list.length === fullest.length && oldestFirst(list[0], fullest[0]) < 0))
        ) {
          fullest = list;
        }
      }
      forget.push(fullest!.shift()!);
      total -= 1;
    }
    const otherChats = new Set<string>();
    for (const job of forget) {
      this.jobs.delete(job.view.id);
      void fsp.rm(job.logPath, { force: true }).catch(() => undefined);
      if (job.view.chatId !== chatId) otherChats.add(job.view.chatId);
    }
    for (const other of otherChats) this.options.onChange?.(other);
  }

  private writeRecord(): void {
    const file: RunningRecordFile = {
      version: 1,
      jobs: [
        ...this.carriedOver,
        ...[...this.jobs.values()]
          .filter((job) => job.view.state === "running" && job.view.pid)
          .map((job) => ({ id: job.view.id, pid: job.view.pid!, ...(job.processStart ? { processStart: job.processStart } : {}) })),
      ],
    };
    const target = path.join(this.options.logDir, RECORD_FILE);
    this.recordWrite = this.recordWrite
      .then(async () => {
        await fsp.mkdir(this.options.logDir, { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
        await fsp.rename(temporary, target);
      })
      .catch((error: unknown) => this.options.log?.("The background job record could not be saved.", error));
  }
}

/** One status line for the model and the card: what ran and how it ended. */
export function describeJobEnd(job: BackgroundJobView): string {
  if (job.state === "running") return "still running";
  if (job.endReason === "output-limit") return "stopped: its output passed the size limit";
  if (job.endReason) return "stopped";
  if (job.origin === "command") return "ended";
  if (job.signal) return `ended by signal ${job.signal}`;
  return `exited with code ${job.exitCode ?? "unknown"}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
