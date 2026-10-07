/**
 * Durable record of live ACP agent process groups.
 *
 * Agents run in their own process group so tool grandchildren can be stopped
 * together. If Aiden crashes, nothing signals that group, so each spawn is
 * recorded here and the next launch stops survivors. A recorded pid is only
 * signalled when the running process still executes the recorded binary, so
 * a recycled pid can never take down an unrelated program.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PidLedgerEntry {
  pid: number;
  executable: string;
  startedAt: number;
}

export interface PidLedgerDependencies {
  isAlive(pid: number): boolean;
  commandOf(pid: number): Promise<string | undefined>;
  killGroup(pid: number): void;
}

const MAX_ENTRIES = 64;

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
    return new Promise((resolve) => {
      execFile("/bin/ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
        resolve(error ? undefined : stdout.trim() || undefined);
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

  record(pid: number, executable: string): void {
    this.entries = [
      ...this.entries.filter((entry) => entry.pid !== pid),
      { pid, executable, startedAt: Date.now() },
    ].slice(-MAX_ENTRIES);
    this.persist();
  }

  release(pid: number | undefined): void {
    if (pid === undefined) return;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.pid !== pid);
    if (this.entries.length !== before) this.persist();
  }

  /** Stop survivors from a previous Aiden process. Returns how many were stopped. */
  async sweep(): Promise<number> {
    const survivors = this.entries;
    this.entries = [];
    let stopped = 0;
    for (const entry of survivors) {
      if (!this.dependencies.isAlive(entry.pid)) continue;
      const command = await this.dependencies.commandOf(entry.pid);
      if (!command || !command.includes(entry.executable)) continue;
      this.dependencies.killGroup(entry.pid);
      stopped += 1;
    }
    this.persist();
    await this.writing;
    return stopped;
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
          typeof (entry as PidLedgerEntry).startedAt === "number",
      )
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}
