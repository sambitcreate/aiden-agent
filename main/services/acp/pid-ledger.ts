/**
 * Durable record of live ACP agent process groups.
 *
 * Agents run in their own process group so tool grandchildren can be stopped
 * together. If Aiden crashes, nothing signals that group, so each spawn is
 * recorded here and the next launch stops survivors. A recorded pid is only
 * signalled when the running process still executes the recorded binary, so
 * a recycled pid can never take down an unrelated program.
 *
 * The agent itself often dies with Aiden while the tools it started keep
 * running in its group. A group id cannot be reused while any member lives,
 * so a group whose leader is gone is still the one Aiden created, unless the
 * whole group ended and its pid was recycled into a new group in between. To
 * rule that out, such a group is stopped only when a member carries the run
 * marker Aiden put in the agent's environment, or runs from the agent's
 * runtime directory.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PidLedgerEntry {
  pid: number;
  executable: string;
  startedAt: number;
  /** `AIDEN_ACP_RUN` value the agent and its tools inherited. */
  marker?: string;
}

export interface PidLedgerDependencies {
  isAlive(pid: number): boolean;
  commandOf(pid: number): Promise<string | undefined>;
  killGroup(pid: number): void;
  /** Whether any process is still in this group, leader or not. */
  groupExists(pgid: number): boolean;
  groupMembers(pgid: number): Promise<number[]>;
  /** Whether the process started with this exact `NAME=value` entry. */
  hasEnvironment(pid: number, entry: string): Promise<boolean>;
}

/** Environment variable that tags every process of one agent launch. */
export const ACP_RUN_MARKER_ENV = "AIDEN_ACP_RUN";

const MAX_ENTRIES = 64;
const MARKER_PATTERN = /^[0-9a-f]{16,64}$/u;
/** How long a killed group gets to disappear before its entry is kept for the next sweep. */
const GROUP_EXIT_WAIT_MS = 1_000;

export const systemPidLedgerDependencies: PidLedgerDependencies = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  commandOf(pid) {
    if (process.platform === "win32") return Promise.resolve(undefined);
    if (process.platform === "linux") {
      // /proc needs no procps package, which minimal Linux images lack.
      return readFile(`/proc/${pid}/cmdline`, "utf8")
        .then((cmdline) => cmdline.split("\0").filter(Boolean).join(" ") || undefined)
        .catch(() => undefined);
    }
    return new Promise((resolve) => {
      execFile("/bin/ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
        resolve(error ? undefined : stdout.trim() || undefined);
      });
    });
  },
  groupExists(pgid) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  async groupMembers(pgid) {
    if (process.platform === "win32") return [];
    if (process.platform === "linux") {
      const names = await readdir("/proc").catch(() => [] as string[]);
      const members: number[] = [];
      await Promise.all(
        names
          .filter((name) => /^\d+$/u.test(name))
          .map(async (name) => {
            const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
            // Fields after the parenthesised command: state, ppid, pgrp.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (Number(fields[2]) === pgid) members.push(Number(name));
          }),
      );
      return members;
    }
    return new Promise((resolve) => {
      execFile("/bin/ps", ["-A", "-o", "pid=,pgid="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve([]);
        const members: number[] = [];
        for (const line of stdout.split("\n")) {
          const [pid, group] = line.trim().split(/\s+/u).map(Number);
          if (group === pgid && Number.isSafeInteger(pid) && pid! > 1) members.push(pid!);
        }
        resolve(members);
      });
    });
  },
  hasEnvironment(pid, entry) {
    if (process.platform === "win32") return Promise.resolve(false);
    if (process.platform === "linux") {
      return readFile(`/proc/${pid}/environ`, "utf8")
        .then((environment) => environment.split("\0").includes(entry))
        .catch(() => false);
    }
    // macOS prints the starting environment after the command. It hides it for
    // system binaries, so those members are recognised by command alone.
    return new Promise((resolve) => {
      execFile("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(!error && stdout.split(/\s+/u).includes(entry));
      });
    });
  },
  killGroup(pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  },
};

export class AcpPidLedger {
  private entries: PidLedgerEntry[];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly dependencies: PidLedgerDependencies = systemPidLedgerDependencies,
  ) {
    this.entries = readEntries(file);
  }

  record(pid: number, executable: string, marker?: string): void {
    this.entries = [
      ...this.entries.filter((entry) => entry.pid !== pid),
      { pid, executable, startedAt: Date.now(), ...(marker && MARKER_PATTERN.test(marker) ? { marker } : {}) },
    ].slice(-MAX_ENTRIES);
    this.persist();
  }

  release(pid: number | undefined): void {
    if (pid === undefined) return;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.pid !== pid);
    if (this.entries.length !== before) this.persist();
  }

  /**
   * Stop survivors from a previous Aiden process. Returns how many groups were
   * stopped. A group that outlives the kill stays recorded for the next sweep.
   */
  async sweep(): Promise<number> {
    const survivors = this.entries;
    this.entries = [];
    const killed: PidLedgerEntry[] = [];
    for (const entry of survivors) {
      if (this.dependencies.isAlive(entry.pid)) {
        const command = await this.dependencies.commandOf(entry.pid);
        if (!command || !command.includes(entry.executable)) continue;
      } else {
        if (!this.dependencies.groupExists(entry.pid)) continue;
        if (!(await this.ownsLeaderlessGroup(entry))) continue;
      }
      this.dependencies.killGroup(entry.pid);
      killed.push(entry);
    }
    // Wait for every killed group at once, so several survivors share one grace period.
    const gone = await Promise.all(killed.map((entry) => this.groupGone(entry.pid)));
    const retained = killed.filter((_entry, index) => !gone[index]);
    const stopped = killed.length;
    this.entries = [...retained, ...this.entries].slice(-MAX_ENTRIES);
    this.persist();
    await this.writing;
    return stopped;
  }

  private async ownsLeaderlessGroup(entry: PidLedgerEntry): Promise<boolean> {
    const runtimeDir = path.dirname(entry.executable);
    const markerEntry = entry.marker ? `${ACP_RUN_MARKER_ENV}=${entry.marker}` : undefined;
    for (const member of await this.dependencies.groupMembers(entry.pid)) {
      if (markerEntry && (await this.dependencies.hasEnvironment(member, markerEntry))) return true;
      const command = await this.dependencies.commandOf(member);
      if (runtimeDir.length > 1 && command?.includes(runtimeDir)) return true;
    }
    return false;
  }

  private async groupGone(pgid: number): Promise<boolean> {
    for (let waited = 0; waited < GROUP_EXIT_WAIT_MS; waited += 50) {
      if (!this.dependencies.groupExists(pgid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !this.dependencies.groupExists(pgid);
  }

  /** Test and diagnostics view. */
  snapshot(): readonly PidLedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): void {
    const body = `${JSON.stringify({ version: 1, entries: this.entries })}\n`;
    const file = this.file;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, file);
      })
      .catch(() => undefined);
  }
}

function readEntries(file: string): PidLedgerEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter(
        (entry): entry is PidLedgerEntry =>
          !!entry &&
          typeof entry === "object" &&
          Number.isSafeInteger((entry as PidLedgerEntry).pid) &&
          (entry as PidLedgerEntry).pid > 1 &&
          typeof (entry as PidLedgerEntry).executable === "string" &&
          (entry as PidLedgerEntry).executable.length > 0 &&
          typeof (entry as PidLedgerEntry).startedAt === "number" &&
          ((entry as PidLedgerEntry).marker === undefined ||
            (typeof (entry as PidLedgerEntry).marker === "string" &&
              MARKER_PATTERN.test((entry as PidLedgerEntry).marker!))),
      )
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}
