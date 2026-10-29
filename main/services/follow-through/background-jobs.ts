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
import { StringDecoder } from "node:string_decoder";
import type {
  BackgroundJobEndReason,
  BackgroundJobState,
  BackgroundJobView,
} from "../../../renderer/shared/background-jobs.js";
import { tailText } from "../../../renderer/shared/agent-notices.js";

export const MAX_RUNNING_JOBS_PER_CHAT = 10;
export const MAX_RUNNING_JOBS = 20;
export const MAX_JOB_LOG_BYTES = 50 * 1024 * 1024;
/** Characters kept in memory per job; reads return at most this much. */
export const JOB_TAIL_CHARS = 20_000;
export const JOB_STOP_GRACE_MS = 4_000;
/** Finished jobs each chat keeps listing (with their logs) in this session. */
export const MAX_FINISHED_JOBS_PER_CHAT = 10;
/** Finished jobs kept across all chats, so many open chats cannot pile up tails. */
export const MAX_FINISHED_JOBS = 50;
export const MAX_JOB_COMMAND_CHARS = 4_000;
export const MAX_JOB_DESCRIPTION_CHARS = 120;

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
  /** Lists the processes in a process group. */
  processGroupMembers?: (pgid: number) => Promise<number[]>;
  /** Whether a process was started with this `NAME=value` in its environment. */
  processHasEnvironment?: (pid: number, entry: string) => Promise<boolean>;
  log?: (message: string, error?: unknown) => void;
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

function newJobId(): string {
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

export function defaultProcessGroupMembers(pgid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,pgid="], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== "string") return resolve([]);
      const members: number[] = [];
      for (const line of stdout.split("\n")) {
        const [pid, group] = line.trim().split(/\s+/u).map(Number);
        if (group === pgid && Number.isSafeInteger(pid) && pid! > 1) members.push(pid!);
      }
      resolve(members);
    });
  });
}

export function defaultProcessHasEnvironment(pid: number, entry: string): Promise<boolean> {
  if (process.platform === "linux") {
    return fsp
      .readFile(`/proc/${pid}/environ`, "utf8")
      .then((environment) => environment.split("\0").includes(entry))
      .catch(() => false);
  }
  return new Promise((resolve) => {
    // macOS prints the environment a process started with after its command.
    execFile("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(!error && typeof stdout === "string" && stdout.split(/\s+/u).includes(entry));
    });
  });
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
  private readonly processGroupMembers: (pgid: number) => Promise<number[]>;
  private readonly processHasEnvironment: (pid: number, entry: string) => Promise<boolean>;
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
    this.processGroupMembers = options.processGroupMembers ?? defaultProcessGroupMembers;
    this.processHasEnvironment = options.processHasEnvironment ?? defaultProcessHasEnvironment;
  }

  start(input: StartBackgroundJobInput): BackgroundJobView {
    if (this.closed) throw new Error("Aiden is closing; background jobs cannot start now.");
    if (process.platform === "win32") throw new Error("Background jobs run on macOS and Linux.");
    const command = input.command.trim();
    if (!command) throw new Error("Give the command to run.");
    if (command.length > MAX_JOB_COMMAND_CHARS) throw new Error("The command is too long.");
    const running = [...this.jobs.values()].filter((job) => job.view.state === "running");
    if (running.filter((job) => job.view.chatId === input.chatId).length >= this.maxRunningPerChat) {
      throw new Error(
        `This chat already has ${this.maxRunningPerChat} background jobs running. Stop one before starting another.`,
      );
    }
    if (running.length >= this.maxRunning) {
      throw new Error(`Aiden already has ${this.maxRunning} background jobs running. Stop one before starting another.`);
    }
    fs.mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
    const id = newJobId();
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
        env: { ...input.env, AIDEN_BACKGROUND_JOB: id },
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
      const marker = `AIDEN_BACKGROUND_JOB=${entry.id}`;
      const marked = async () => {
        const found: number[] = [];
        for (const pid of await this.processGroupMembers(entry.pid)) {
          if (await this.processHasEnvironment(pid, marker)) found.push(pid);
        }
        return found;
      };
      let left = await marked();
      if (!left.length) continue;
      signalEach(left, "SIGTERM");
      const asked = left;
      await this.waitUntil(() => asked.every((pid) => !processExists(pid)));
      for (let round = 0; (left = await marked()).length && round < FORCED_REAP_ROUNDS; round += 1) {
        const forced = left;
        signalEach(forced, "SIGKILL");
        await this.waitUntil(() => forced.every((pid) => !processExists(pid)), FORCED_REAP_WAIT_MS);
      }
      if (left.length) survivors.push(entry);
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
    const newestFirst = (left: JobRecord, right: JobRecord) => (right.view.endedAt ?? 0) - (left.view.endedAt ?? 0);
    const finished = [...this.jobs.values()].filter((job) => job.view.state !== "running").sort(newestFirst);
    const chatFinished = finished.filter((job) => job.view.chatId === chatId);
    const forget = new Set([...chatFinished.slice(MAX_FINISHED_JOBS_PER_CHAT), ...finished.slice(this.maxFinished)]);
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
