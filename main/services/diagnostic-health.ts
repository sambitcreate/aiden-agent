import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DIAGNOSTIC_AREAS,
  type DiagnosticArea,
  type DiagnosticEventV1,
} from "./diagnostics-contract.js";

export const DIAGNOSTIC_HEALTH_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_HEALTH_DAYS = 90;

export interface DiagnosticHealthCount {
  area: DiagnosticArea;
  started: number;
  completed: number;
  degraded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  success2xx: number;
  clientError4xx: number;
  serverError5xx: number;
  slow: number;
}

export interface DiagnosticHealthDay {
  date: string;
  counts: DiagnosticHealthCount[];
}

export interface DiagnosticHealthDatabase {
  version: typeof DIAGNOSTIC_HEALTH_VERSION;
  days: DiagnosticHealthDay[];
}

let targetPath: string | null = null;
let database: DiagnosticHealthDatabase = { version: DIAGNOSTIC_HEALTH_VERSION, days: [] };
let dirty = false;
let timer: NodeJS.Timeout | null = null;
let queue: Promise<void> = Promise.resolve();
let persistenceFailed = false;

function ensurePrivateHealthDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid diagnostic health directory.");
  const descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isDirectory()) throw new Error("Diagnostic health directory changed.");
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
}

function readHealthFile(file: string): string {
  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid diagnostic health file.");
    fchmodSync(descriptor, 0o600);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function emptyCount(area: DiagnosticArea): DiagnosticHealthCount {
  return {
    area,
    started: 0,
    completed: 0,
    degraded: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    success2xx: 0,
    clientError4xx: 0,
    serverError5xx: 0,
    slow: 0,
  };
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

export function normalizeDiagnosticHealth(value: unknown): DiagnosticHealthDatabase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, days: [] };
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.days)) return { version: 1, days: [] };
  const days = input.days.flatMap((raw): DiagnosticHealthDay[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const candidate = raw as Record<string, unknown>;
    if (!validDate(candidate.date) || !Array.isArray(candidate.counts)) return [];
    const byArea = new Map<DiagnosticArea, DiagnosticHealthCount>();
    for (const item of candidate.counts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const count = item as Record<string, unknown>;
      if (!DIAGNOSTIC_AREAS.includes(count.area as DiagnosticArea)) continue;
      const area = count.area as DiagnosticArea;
      byArea.set(area, {
        area,
        started: safeCount(count.started),
        completed: safeCount(count.completed),
        degraded: safeCount(count.degraded),
        failed: safeCount(count.failed),
        cancelled: safeCount(count.cancelled),
        timedOut: safeCount(count.timedOut),
        success2xx: safeCount(count.success2xx),
        clientError4xx: safeCount(count.clientError4xx),
        serverError5xx: safeCount(count.serverError5xx),
        slow: safeCount(count.slow),
      });
    }
    return [{ date: candidate.date, counts: [...byArea.values()].sort((a, b) => a.area.localeCompare(b.area)) }];
  });
  return {
    version: DIAGNOSTIC_HEALTH_VERSION,
    days: days.sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DIAGNOSTIC_HEALTH_DAYS),
  };
}

export function initDiagnosticHealth(file: string, enabled = true): void {
  targetPath = enabled ? file : null;
  persistenceFailed = false;
  if (!enabled) {
    database = { version: DIAGNOSTIC_HEALTH_VERSION, days: [] };
    return;
  }
  try {
    ensurePrivateHealthDirectory(path.dirname(file));
    database = normalizeDiagnosticHealth(JSON.parse(readHealthFile(file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      persistenceFailed = true;
      targetPath = null;
    }
    database = { version: DIAGNOSTIC_HEALTH_VERSION, days: [] };
  }
}

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function persistSoon(): void {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushDiagnosticHealth();
  }, 1_000);
  timer.unref?.();
}

export function recordDiagnosticHealth(event: DiagnosticEventV1): void {
  if (!targetPath) return;
  const date = event.at.slice(0, 10);
  if (!validDate(date)) return;
  let day = database.days.find((candidate) => candidate.date === date);
  if (!day) {
    day = { date, counts: [] };
    database.days.push(day);
    database.days.sort((a, b) => a.date.localeCompare(b.date));
    database.days = database.days.slice(-MAX_DIAGNOSTIC_HEALTH_DAYS);
  }
  let count = day.counts.find((candidate) => candidate.area === event.area);
  if (!count) {
    count = emptyCount(event.area);
    day.counts.push(count);
    day.counts.sort((a, b) => a.area.localeCompare(b.area));
  }
  if (event.outcome === "started") count.started = increment(count.started);
  else if (event.outcome === "completed" || event.outcome === "recovered") count.completed = increment(count.completed);
  else if (event.outcome === "degraded" || event.outcome === "unavailable") count.degraded = increment(count.degraded);
  else if (event.outcome === "cancelled" || event.outcome === "rejected") count.cancelled = increment(count.cancelled);
  else if (event.outcome === "timed-out") count.timedOut = increment(count.timedOut);
  else if (event.outcome === "failed" || event.level === "error" || event.level === "fatal") count.failed = increment(count.failed);
  else return;
  persistSoon();
}

export function recordRemoteRequestHealth(status: number, latencyMs: number, at = new Date()): void {
  if (!targetPath || !Number.isFinite(status) || !Number.isFinite(latencyMs)) return;
  const event = {
    version: 1,
    at: at.toISOString(),
    sessionId: "aggregate-only",
    level: "info",
    area: "remote",
    event: "legacy-log",
  } as const;
  const date = event.at.slice(0, 10);
  let day = database.days.find((candidate) => candidate.date === date);
  if (!day) {
    day = { date, counts: [] };
    database.days.push(day);
    database.days.sort((a, b) => a.date.localeCompare(b.date));
    database.days = database.days.slice(-MAX_DIAGNOSTIC_HEALTH_DAYS);
  }
  let count = day.counts.find((candidate) => candidate.area === "remote");
  if (!count) {
    count = emptyCount("remote");
    day.counts.push(count);
    day.counts.sort((a, b) => a.area.localeCompare(b.area));
  }
  if (status >= 200 && status < 300) count.success2xx = increment(count.success2xx);
  else if (status >= 400 && status < 500) count.clientError4xx = increment(count.clientError4xx);
  else if (status >= 500) count.serverError5xx = increment(count.serverError5xx);
  if (latencyMs >= 2_000) count.slow = increment(count.slow);
  persistSoon();
}

export async function flushDiagnosticHealth(timeoutMs?: number): Promise<boolean> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (targetPath && dirty) {
    dirty = false;
    const target = targetPath;
    const snapshot = `${JSON.stringify(normalizeDiagnosticHealth(database), null, 2)}\n`;
    queue = queue
      .then(async () => {
        ensurePrivateHealthDirectory(path.dirname(target));
        const temporary = `${target}.${randomUUID()}.tmp`;
        const handle = await fs.open(
          temporary,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid diagnostic health temporary file.");
          await handle.writeFile(snapshot, "utf8");
          await handle.chmod(0o600);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.rename(temporary, target);
        } catch (error) {
          await fs.rm(temporary, { force: true });
          throw error;
        }
      })
      .catch(() => {
        persistenceFailed = true;
        targetPath = null;
      });
  }
  if (timeoutMs === undefined) {
    await queue;
    return true;
  }
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      queue.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function diagnosticHealthSnapshot(): DiagnosticHealthDatabase {
  return structuredClone(normalizeDiagnosticHealth(database));
}

export function diagnosticHealthPersistenceFailed(): boolean {
  return persistenceFailed;
}

export async function deleteDiagnosticHealth(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  await queue;
  database = { version: DIAGNOSTIC_HEALTH_VERSION, days: [] };
  if (targetPath) {
    await fs.rm(targetPath, { force: true });
  }
}
