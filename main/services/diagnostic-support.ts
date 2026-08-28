import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

import {
  deleteDiagnosticJournalFiles,
  diagnosticJournalStatus,
  pruneDiagnosticJournalRetention,
  snapshotDiagnosticJournalFiles,
  MAX_DIAGNOSTIC_LOG_FILES,
} from "./diagnostic-journal.js";
import {
  deleteDiagnosticHealth,
  diagnosticHealthPersistenceFailed,
  diagnosticHealthSnapshot,
  flushDiagnosticHealth,
  type DiagnosticHealthDatabase,
} from "./diagnostic-health.js";
import {
  DIAGNOSTIC_AREAS,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
  exportableDiagnosticFields,
  isDiagnosticEventName,
  normalizeDiagnosticFields,
  type DiagnosticEventV1,
  type DiagnosticSafeFields,
} from "./diagnostics-contract.js";
import {
  deleteSubagentRuntimeDiagnostics,
  pruneSubagentRuntimeDiagnosticRetention,
  PROVIDER_FAILURE_CATEGORIES,
  snapshotSubagentRuntimeDiagnostics,
  SUBAGENT_RUNTIME_DIAGNOSTIC_CODES,
  SUBAGENT_RUNTIME_DIAGNOSTIC_STAGES,
  SUBAGENT_RUNTIME_FAILURES,
  subagentRuntimeDiagnosticSinkFailed,
} from "./subagents/subagent-runtime-diagnostics.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_CRASH_DUMPS = 3;
const MAX_CRASH_DUMP_BYTES = 16 * 1024 * 1024;
const CRASH_DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const EXPORT_VERSION = 1 as const;
const SAFE_DIAGNOSTIC_NAMES = new Set([
  "aiden.log",
  "aiden-dev.log",
  "aiden-fatal.log",
  "aiden-dev.legacy.log",
  "aiden-dev.legacy.prev.log",
  "subagent-runtime.log",
  "subagent-runtime.prev.log",
  "diagnostic-health.json",
]);
const PROHIBITED_TEXT =
  /(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+|(?:AKIA|AIza|gh[pousr]_|github_pat_|npm_|sk-)[A-Za-z0-9_-]+|(?:https?|wss?|file):\/\/|(?:^|[\s"'])\/(?:Users|home|workspace|private|tmp)\/|[A-Za-z]:[\\/]/iu;

export interface DiagnosticSupportStatus {
  retainedBytes: number;
  fileCount: number;
  oldestAt: string | null;
  newestAt: string | null;
  sinkFailed: boolean;
  droppedWrites: number;
  diagnosticMode: {
    enabled: boolean;
    expiresAt: string | null;
    disablesOnRestart: boolean;
    crashDumpCount: number;
  };
}

export interface DiagnosticExportManifest {
  exportVersion: typeof EXPORT_VERSION;
  diagnosticSchemaVersion: 1;
  createdAt: string;
  app: { name: string; version: string; runtimeProfile: "development" | "production" };
  platform: { name: NodeJS.Platform; arch: string; node: string; electron: string | null };
  timeRange: { oldestAt: string | null; newestAt: string | null };
  included: { generalRecords: number; subagentRecords: number; healthDays: number; crashDumps: number };
  omitted: readonly string[];
}

export interface DiagnosticExportBundle {
  manifest: DiagnosticExportManifest;
  general: unknown[];
  subagents: unknown[];
  health: DiagnosticHealthDatabase;
  crashDumps?: Array<{ name: string; bytes: number; base64: string }>;
}

interface DiagnosticSupportRoots {
  logsPath: string;
  crashDumpsPath: string;
}

interface ExportOptions extends DiagnosticSupportRoots {
  destination: string;
  includeCrashDumps: boolean;
  app: DiagnosticExportManifest["app"];
  tempRoot?: string;
  now?: () => Date;
}

let diagnosticModeEnabled = false;
let crashMaintenanceQueue: Promise<void> = Promise.resolve();

function withCrashMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  const result = crashMaintenanceQueue.then(operation);
  crashMaintenanceQueue = result.then(() => undefined, () => undefined);
  return result;
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function safeKnownFile(root: string, candidate: string): Promise<boolean> {
  if (!withinRoot(root, candidate)) return false;
  try {
    const [rootReal, candidateReal, metadata] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
      fs.lstat(candidate),
    ]);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && withinRoot(rootReal, candidateReal);
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(root: string): Promise<string> {
  try {
    const metadata = await fs.lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid diagnostic directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await fs.lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid diagnostic directory.");
  }
  const handle = await fs.open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error("Diagnostic directory changed during validation.");
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
  return fs.realpath(root);
}

function journalCandidateNames(): string[] {
  const names: string[] = ["aiden-fatal.log"];
  for (const base of ["aiden.log", "aiden-dev.log"]) {
    names.push(base);
    for (let index = 1; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) names.push(`${base}.${index}`);
  }
  return names;
}

async function readJsonLines(file: string, byteLimit: number): Promise<unknown[]> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let contents: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > byteLimit) {
      throw new Error("Diagnostic source exceeds its export budget.");
    }
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const records: unknown[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
  return records;
}

const GENERAL_RECORD_KEYS = new Set([
  "version",
  "at",
  "sessionId",
  "level",
  "area",
  "event",
  "operationId",
  "durationMs",
  "outcome",
  "code",
  "fields",
]);

function projectGeneralRecord(value: unknown): DiagnosticEventV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !GENERAL_RECORD_KEYS.has(key))) return null;
  if (
    record.version !== 1 ||
    typeof record.at !== "string" ||
    record.at.length > 32 ||
    !Number.isFinite(Date.parse(record.at)) ||
    typeof record.sessionId !== "string" ||
    !/^session-[A-Za-z0-9-]{1,80}$/u.test(record.sessionId) ||
    !DIAGNOSTIC_LEVELS.includes(record.level as never) ||
    !DIAGNOSTIC_AREAS.includes(record.area as never) ||
    !isDiagnosticEventName(record.event) ||
    (record.outcome !== undefined && !DIAGNOSTIC_OUTCOMES.includes(record.outcome as never)) ||
    (record.code !== undefined && !DIAGNOSTIC_CODES.includes(record.code as never)) ||
    (record.durationMs !== undefined &&
      (typeof record.durationMs !== "number" || !Number.isSafeInteger(record.durationMs) || record.durationMs < 0)) ||
    (record.operationId !== undefined &&
      (typeof record.operationId !== "string" || !/^op-[0-9a-f]{16}$/u.test(record.operationId))) ||
    (record.fields !== undefined &&
      (!record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)))
  ) return null;
  const inputFields = record.fields as DiagnosticSafeFields | undefined;
  const normalizedFields = normalizeDiagnosticFields(inputFields);
  if (inputFields) {
    for (const [key, fieldValue] of Object.entries(inputFields)) {
      if (normalizedFields?.[key] !== fieldValue) return null;
    }
  }
  const fields = exportableDiagnosticFields(inputFields);
  return {
    version: 1,
    at: record.at,
    sessionId: record.sessionId,
    level: record.level as DiagnosticEventV1["level"],
    area: record.area as DiagnosticEventV1["area"],
    event: record.event,
    ...(typeof record.operationId === "string" ? { operationId: record.operationId } : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    ...(typeof record.outcome === "string" ? { outcome: record.outcome as DiagnosticEventV1["outcome"] } : {}),
    ...(typeof record.code === "string" ? { code: record.code as DiagnosticEventV1["code"] } : {}),
    ...(fields ? { fields } : {}),
  };
}

function projectSubagentRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["at", "diagnosticId", "runId", "generationId", "childId", "providerId", "modelId", "failure", "attempts", "diagnostics"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof record.at !== "string" || record.at.length > 32 || !Number.isFinite(Date.parse(record.at)) ||
    typeof record.diagnosticId !== "string" || record.diagnosticId.length > 80 ||
    typeof record.providerId !== "string" || record.providerId.length > 240 ||
    typeof record.modelId !== "string" || record.modelId.length > 240 ||
    !SUBAGENT_RUNTIME_FAILURES.includes(record.failure as never) ||
    !Number.isSafeInteger(record.attempts) || Number(record.attempts) < 1 || Number(record.attempts) > 16 ||
    !Array.isArray(record.diagnostics) || record.diagnostics.length > 4
  ) return null;
  for (const key of ["runId", "generationId", "childId"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || record[key].length > 240)) return null;
  }
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const entry of record.diagnostics) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const itemKeys = new Set(["stage", "code", "durationMs", "exitCode", "providerCategory", "detail"]);
    if (
      Object.keys(item).some((key) => !itemKeys.has(key)) ||
      !SUBAGENT_RUNTIME_DIAGNOSTIC_STAGES.includes(item.stage as never) ||
      !SUBAGENT_RUNTIME_DIAGNOSTIC_CODES.includes(item.code as never) ||
      (item.durationMs !== undefined && (!Number.isSafeInteger(item.durationMs) || Number(item.durationMs) < 0)) ||
      (item.exitCode !== undefined && item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) ||
      (item.providerCategory !== undefined && !PROVIDER_FAILURE_CATEGORIES.includes(item.providerCategory as never)) ||
      (item.detail !== undefined && (typeof item.detail !== "string" || item.detail.length > 2_048))
    ) return null;
    diagnostics.push({
      stage: item.stage,
      code: item.code,
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      ...(typeof item.exitCode === "number" || item.exitCode === null ? { exitCode: item.exitCode } : {}),
      ...(typeof item.providerCategory === "string" ? { providerCategory: item.providerCategory } : {}),
    });
  }
  return {
    at: record.at,
    failure: record.failure,
    attempts: typeof record.attempts === "number" ? record.attempts : 0,
    diagnostics,
  };
}

function recordTimes(records: readonly unknown[]): string[] {
  return records.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const at = (value as Record<string, unknown>).at;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? [at] : [];
  });
}

async function crashDumpCandidatesUnsafe(
  crashDumpsPath: string,
  now: Date,
): Promise<Array<{ path: string; name: string; bytes: number; mtimeMs: number }>> {
  await ensurePrivateDirectory(crashDumpsPath);
  const entries = await fs.readdir(crashDumpsPath, { withFileTypes: true });
  const candidates: Array<{ path: string; name: string; bytes: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".dmp")) continue;
    const candidate = path.join(crashDumpsPath, entry.name);
    if (!(await safeKnownFile(crashDumpsPath, candidate))) continue;
    let metadata;
    try {
      metadata = await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) continue;
    if (metadata.mtimeMs < now.getTime() - CRASH_DUMP_MAX_AGE_MS || metadata.size > MAX_CRASH_DUMP_BYTES) {
      await fs.rm(candidate, { force: true });
      continue;
    }
    try {
      await fs.chmod(candidate, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    candidates.push({ path: candidate, name: entry.name, bytes: metadata.size, mtimeMs: metadata.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of candidates.slice(MAX_CRASH_DUMPS)) await fs.rm(stale.path, { force: true });
  return candidates.slice(0, MAX_CRASH_DUMPS);
}

function crashDumpCandidates(
  crashDumpsPath: string,
  now: Date,
): Promise<Array<{ path: string; name: string; bytes: number; mtimeMs: number }>> {
  return withCrashMaintenance(() => crashDumpCandidatesUnsafe(crashDumpsPath, now));
}

export async function pruneExpiredDiagnosticCrashDumps(crashDumpsPath: string): Promise<void> {
  await crashDumpCandidates(crashDumpsPath, new Date());
}

export function diagnosticModeStatus(): { enabled: boolean; expiresAt: null; disablesOnRestart: true } {
  return { enabled: diagnosticModeEnabled, expiresAt: null, disablesOnRestart: true };
}

export function enableLocalCrashCapture(
  start: () => void,
): { enabled: true; expiresAt: null; disablesOnRestart: true } {
  if (!diagnosticModeEnabled) start();
  diagnosticModeEnabled = true;
  return { enabled: true, expiresAt: null, disablesOnRestart: true };
}

export async function diagnosticSupportStatus(
  roots: DiagnosticSupportRoots,
): Promise<DiagnosticSupportStatus> {
  await ensurePrivateDirectory(roots.logsPath);
  const supportNow = new Date();
  await Promise.all([
    pruneDiagnosticJournalRetention(supportNow),
    pruneSubagentRuntimeDiagnosticRetention(supportNow),
  ]);
  const files: string[] = [];
  for (const name of [...journalCandidateNames(), ...SAFE_DIAGNOSTIC_NAMES]) {
    const candidate = path.join(roots.logsPath, name);
    if (await safeKnownFile(roots.logsPath, candidate)) files.push(candidate);
  }
  const unique = [...new Set(files)];
  let retainedBytes = 0;
  let corruptEvidence = false;
  const times: string[] = [];
  for (const file of unique) {
    const metadata = await fs.stat(file);
    retainedBytes += metadata.size;
    if (path.basename(file) === "diagnostic-health.json" || path.basename(file).includes(".legacy")) continue;
    try {
      times.push(...recordTimes(await readJsonLines(file, 8 * 1024 * 1024)));
    } catch {
      corruptEvidence = true;
    }
  }
  const dumps = await crashDumpCandidates(roots.crashDumpsPath, new Date());
  retainedBytes += dumps.reduce((total, dump) => total + dump.bytes, 0);
  times.sort();
  const journal = diagnosticJournalStatus();
  const mode = diagnosticModeStatus();
  return {
    retainedBytes,
    fileCount: unique.length + dumps.length,
    oldestAt: times[0] ?? null,
    newestAt: times[times.length - 1] ?? null,
    sinkFailed: journal.writeFailed || corruptEvidence || diagnosticHealthPersistenceFailed() || subagentRuntimeDiagnosticSinkFailed(),
    droppedWrites: journal.droppedWrites,
    diagnosticMode: { ...mode, crashDumpCount: dumps.length },
  };
}

export async function createDiagnosticExport(options: ExportOptions): Promise<DiagnosticExportManifest> {
  const now = options.now?.() ?? new Date();
  await ensurePrivateDirectory(options.logsPath);
  const stagingRoot = await fs.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "aiden-diagnostics-"));
  await fs.chmod(stagingRoot, 0o700);
  let destinationTemporary: string | null = null;
  try {
    const [generalFiles, subagentFiles] = await Promise.all([
      snapshotDiagnosticJournalFiles(path.join(stagingRoot, "general"), now),
      snapshotSubagentRuntimeDiagnostics(path.join(stagingRoot, "subagents"), now),
      flushDiagnosticHealth(),
    ]).then(([generalSnapshot, subagentSnapshot]) => [generalSnapshot, subagentSnapshot] as const);
    const general: unknown[] = [];
    for (const candidate of generalFiles) {
      for (const record of await readJsonLines(candidate, 8 * 1024 * 1024)) {
        const projected = projectGeneralRecord(record);
        if (!projected) throw new Error("The diagnostic journal contains an unknown record.");
        general.push(projected);
      }
    }
    const subagents: unknown[] = [];
    for (const candidate of subagentFiles) {
      for (const record of await readJsonLines(candidate, 4 * 1024 * 1024)) {
        const projected = projectSubagentRecord(record);
        if (!projected) throw new Error("The subagent journal contains an unknown record.");
        subagents.push(projected);
      }
    }
    const crashDumps = options.includeCrashDumps
      ? await Promise.all(
        (await crashDumpCandidates(options.crashDumpsPath, now)).map(async (dump) => {
          if (dump.bytes > MAX_CRASH_DUMP_BYTES) throw new Error("A crash dump exceeds the export budget.");
          const handle = await fs.open(dump.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== dump.bytes) {
              throw new Error("A crash dump changed during export.");
            }
            return { name: dump.name, bytes: dump.bytes, base64: (await handle.readFile()).toString("base64") };
          } finally {
            await handle.close();
          }
        }),
        )
      : [];
    const health = diagnosticHealthSnapshot();
    const times = [...recordTimes(general), ...recordTimes(subagents)].sort();
    const manifest: DiagnosticExportManifest = {
    exportVersion: EXPORT_VERSION,
    diagnosticSchemaVersion: 1,
    createdAt: now.toISOString(),
    app: options.app,
    platform: {
      name: process.platform,
      arch: process.arch,
      node: process.version,
      electron: process.versions.electron ?? null,
    },
    timeRange: { oldestAt: times[0] ?? null, newestAt: times[times.length - 1] ?? null },
    included: { generalRecords: general.length, subagentRecords: subagents.length, healthDays: health.days.length, crashDumps: crashDumps.length },
    omitted: [
      "prompts and responses",
      "reasoning and tool traffic",
      "terminal and attachment contents",
      "credentials, headers, URLs, and local paths",
      "configuration, chats, caches, and authoritative application state",
    ],
    };
    const bundle: DiagnosticExportBundle = {
    manifest,
    general,
    subagents,
    health,
    ...(crashDumps.length ? { crashDumps } : {}),
    };
    const scanTarget = JSON.stringify({ manifest, general, subagents, health });
    if (PROHIBITED_TEXT.test(scanTarget)) throw new Error("Diagnostic export privacy validation failed.");
    const serialized = Buffer.from(JSON.stringify(bundle, null, 2), "utf8");
    if (serialized.length > MAX_EXPORT_BYTES) throw new Error("Diagnostic export exceeds its total budget.");
    const staged = path.join(stagingRoot, "diagnostics.json.gz");
    const compressed = await gzipAsync(serialized, { level: 9 });
    await fs.writeFile(staged, compressed, { mode: 0o600, flag: "wx" });
    const roundTrip = JSON.parse((await gunzipAsync(await fs.readFile(staged))).toString("utf8")) as DiagnosticExportBundle;
    if (roundTrip.manifest.exportVersion !== EXPORT_VERSION) throw new Error("Diagnostic export validation failed.");
    const destinationDirectory = path.dirname(options.destination);
    destinationTemporary = path.join(destinationDirectory, `.${path.basename(options.destination)}.aiden-${randomUUID()}.tmp`);
    const destination = await fs.open(destinationTemporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await destination.writeFile(await fs.readFile(staged));
      await destination.chmod(0o600);
      await destination.sync();
    } finally {
      await destination.close();
    }
    await fs.rename(destinationTemporary, options.destination);
    destinationTemporary = null;
    return manifest;
  } finally {
    if (destinationTemporary) await fs.rm(destinationTemporary, { force: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function deleteAllDiagnosticData(roots: DiagnosticSupportRoots): Promise<void> {
  await ensurePrivateDirectory(roots.logsPath);
  await deleteDiagnosticJournalFiles();
  await deleteDiagnosticHealth();
  await deleteSubagentRuntimeDiagnostics();
  for (const name of [
    ...journalCandidateNames(),
    "aiden-dev.prev.log",
    "aiden-dev.legacy.log",
    "aiden-dev.legacy.prev.log",
    "subagent-runtime.log",
    "subagent-runtime.prev.log",
    "diagnostic-health.json",
  ]) {
    const candidate = path.join(roots.logsPath, name);
    if (withinRoot(roots.logsPath, candidate)) await fs.rm(candidate, { force: true });
  }
  await withCrashMaintenance(async () => {
    await ensurePrivateDirectory(roots.crashDumpsPath);
    for (const entry of await fs.readdir(roots.crashDumpsPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".dmp")) {
        await fs.rm(path.join(roots.crashDumpsPath, entry.name), { force: true });
      }
    }
  });
}
