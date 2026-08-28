import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  MAX_DIAGNOSTIC_EVENT_BYTES,
  createDiagnosticEvent,
  createDiagnosticSessionId,
  diagnosticEventLine,
  exportableDiagnosticFields,
  projectDiagnosticError,
  sanitizeDiagnosticText,
  type DiagnosticArea,
  type DiagnosticEventInput,
  type DiagnosticEventV1,
  type DiagnosticLevel,
  type DiagnosticEventName,
} from "./diagnostics-contract.js";
import { recordDiagnosticHealth } from "./diagnostic-health.js";

export const MAX_DIAGNOSTIC_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_DIAGNOSTIC_LOG_FILES = 4;
export const MAX_DIAGNOSTIC_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_DIAGNOSTIC_FATAL_BYTES = 64 * 1024;
const MAX_PENDING_WRITES = 1_024;
const MAX_STALE_ROTATION_INDEX = 32;

export type DiagnosticRuntimeProfile = "development" | "production";

export interface DiagnosticJournalOptions {
  targetPath: string;
  profile: DiagnosticRuntimeProfile;
  writeMode?: "all" | "fatal-only";
  now?: () => Date;
  sessionId?: string;
}

export interface DiagnosticJournalStatus {
  enabled: boolean;
  path: string | null;
  profile: DiagnosticRuntimeProfile | null;
  pendingWrites: number;
  droppedWrites: number;
  writeFailed: boolean;
}

let targetPath: string | null = null;
let runtimeProfile: DiagnosticRuntimeProfile | null = null;
let now: () => Date = () => new Date();
let sessionId = createDiagnosticSessionId();
let queue: Promise<void> = Promise.resolve();
let pendingWrites = 0;
let droppedWrites = 0;
let writeFailed = false;
let writeMode: "all" | "fatal-only" = "all";
let activeSegmentStartedAtMs = 0;
let fatalSegmentStartedAtMs = 0;
let retentionTimer: NodeJS.Timeout | undefined;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

function rotatedPath(target: string, index: number): string {
  return `${target}.${index}`;
}

function fatalPath(target: string): string {
  return path.join(path.dirname(target), "aiden-fatal.log");
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Diagnostic directory is not a private directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Diagnostic directory is not a private directory.");
    }
  }
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isDirectory()) throw new Error("Diagnostic directory changed during validation.");
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
}

function ensureJournalFile(target: string): void {
  ensurePrivateDirectory(path.dirname(target));
  const descriptor = openSync(
    target,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("Diagnostic journal is not an owned regular file.");
    }
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function removeLegacyDevelopmentLogs(target: string): void {
  if (path.basename(target) !== "aiden-dev.log") return;
  const directory = path.dirname(target);
  const pruneExistingLegacy = (candidate: string): void => {
    try {
      const metadata = lstatSync(candidate);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > MAX_DIAGNOSTIC_LOG_BYTES ||
        metadata.mtimeMs < now().getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS
      ) rmSync(candidate, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  pruneExistingLegacy(path.join(directory, "aiden-dev.legacy.log"));
  pruneExistingLegacy(path.join(directory, "aiden-dev.legacy.prev.log"));
  const preserveLegacy = (source: string, destination: string): void => {
    try {
      const metadata = lstatSync(source);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > MAX_DIAGNOSTIC_LOG_BYTES ||
        metadata.mtimeMs < now().getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS
      ) {
        rmSync(source, { force: true });
        return;
      }
      rmSync(destination, { force: true });
      renameSync(source, destination);
      const descriptor = openSync(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  preserveLegacy(
    path.join(directory, "aiden-dev.prev.log"),
    path.join(directory, "aiden-dev.legacy.prev.log"),
  );
  try {
    const metadata = lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return;
    if (metadata.size === 0) return;
    const descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let isLegacy = false;
    try {
      const prefix = Buffer.alloc(Math.min(256, metadata.size));
      readSync(descriptor, prefix, 0, prefix.length, 0);
      isLegacy = !prefix.toString("utf8").trimStart().startsWith("{");
    } finally {
      closeSync(descriptor);
    }
    if (isLegacy) preserveLegacy(target, path.join(directory, "aiden-dev.legacy.log"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function oldestRecordAtMs(target: string): number | null {
  const descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size === 0) return null;
    const prefix = Buffer.alloc(Math.min(MAX_DIAGNOSTIC_EVENT_BYTES + 1, metadata.size));
    readSync(descriptor, prefix, 0, prefix.length, 0);
    const firstLine = prefix.toString("utf8").split("\n", 1)[0];
    if (!firstLine) return null;
    const at = (JSON.parse(firstLine) as { at?: unknown }).at;
    if (typeof at !== "string") return null;
    const value = Date.parse(at);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

function removeStaleRotationArtifacts(target: string): void {
  rmSync(`${target}.tmp`, { force: true });
  for (let index = MAX_DIAGNOSTIC_LOG_FILES; index <= MAX_STALE_ROTATION_INDEX; index += 1) {
    rmSync(rotatedPath(target, index), { force: true });
  }
}

function rotateSync(target: string): void {
  rmSync(rotatedPath(target, MAX_DIAGNOSTIC_LOG_FILES - 1), { force: true });
  for (let index = MAX_DIAGNOSTIC_LOG_FILES - 2; index >= 1; index -= 1) {
    try {
      renameSync(rotatedPath(target, index), rotatedPath(target, index + 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    renameSync(target, rotatedPath(target, 1));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  ensureJournalFile(target);
}

function pruneExpiredSync(target: string): void {
  const cutoff = now().getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS;
  for (let index = 1; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) {
    const candidate = rotatedPath(target, index);
    try {
      const metadata = lstatSync(candidate);
      const oldestAtMs = oldestRecordAtMs(candidate);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > MAX_DIAGNOSTIC_LOG_BYTES ||
        metadata.mtimeMs < cutoff ||
        oldestAtMs === null ||
        oldestAtMs < cutoff
      ) {
        rmSync(candidate, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function appendNoFollow(target: string, line: string): Promise<void> {
  ensurePrivateDirectory(path.dirname(target));
  const handle = await fs.open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("Diagnostic journal is not an owned regular file.");
    }
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

async function rotateBeforeAppend(target: string, incomingBytes: number): Promise<void> {
  let currentBytes = 0;
  try {
    const metadata = await fs.lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("Diagnostic journal is not an owned regular file.");
    }
    currentBytes = metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ageExpired = now().getTime() - activeSegmentStartedAtMs >= MAX_DIAGNOSTIC_LOG_AGE_MS;
  if (
    currentBytes + incomingBytes <= MAX_DIAGNOSTIC_LOG_BYTES &&
    !ageExpired
  ) return;

  if (ageExpired) {
    await fs.rm(target, { force: true });
    await appendNoFollow(target, "");
    activeSegmentStartedAtMs = now().getTime();
    return;
  }

  await fs.rm(rotatedPath(target, MAX_DIAGNOSTIC_LOG_FILES - 1), { force: true });
  for (let index = MAX_DIAGNOSTIC_LOG_FILES - 2; index >= 1; index -= 1) {
    try {
      await fs.rename(rotatedPath(target, index), rotatedPath(target, index + 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (currentBytes > 0) {
    await fs.rename(target, rotatedPath(target, 1));
  }
  await appendNoFollow(target, "");
  activeSegmentStartedAtMs = now().getTime();
}

async function pruneExpired(target: string): Promise<void> {
  const cutoff = now().getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS;
  for (let index = 1; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) {
    const candidate = rotatedPath(target, index);
    try {
      const metadata = await fs.lstat(candidate);
      const oldestAtMs = oldestRecordAtMs(candidate);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > MAX_DIAGNOSTIC_LOG_BYTES ||
        metadata.mtimeMs < cutoff ||
        oldestAtMs === null ||
        oldestAtMs < cutoff
      ) {
        await fs.rm(candidate, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function pruneRetentionAt(target: string, currentMs: number): Promise<void> {
  const cutoff = currentMs - MAX_DIAGNOSTIC_LOG_AGE_MS;
  const removeExpiredStructured = async (candidate: string, maximumBytes: number): Promise<boolean> => {
    try {
      const metadata = await fs.lstat(candidate);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > maximumBytes
      ) {
        await fs.rm(candidate, { force: true });
        return true;
      }
      const oldestAtMs = oldestRecordAtMs(candidate);
      if (
        metadata.size > 0 &&
        (oldestAtMs === null ? metadata.mtimeMs < cutoff : oldestAtMs < cutoff)
      ) {
        await fs.rm(candidate, { force: true });
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return false;
  };

  if (await removeExpiredStructured(target, MAX_DIAGNOSTIC_LOG_BYTES)) {
    await appendNoFollow(target, "");
    activeSegmentStartedAtMs = currentMs;
  }
  for (let index = 1; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) {
    await removeExpiredStructured(rotatedPath(target, index), MAX_DIAGNOSTIC_LOG_BYTES);
  }
  pruneFatalRetentionSync(target, currentMs);
  if (path.basename(target) === "aiden-dev.log") {
    for (const name of ["aiden-dev.legacy.log", "aiden-dev.legacy.prev.log"]) {
      const candidate = path.join(path.dirname(target), name);
      try {
        const metadata = await fs.lstat(candidate);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.nlink !== 1 ||
          metadata.size > MAX_DIAGNOSTIC_LOG_BYTES ||
          metadata.mtimeMs < cutoff
        ) await fs.rm(candidate, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function pruneFatalRetentionSync(target: string, currentMs: number): void {
  const fatal = fatalPath(target);
  const cutoff = currentMs - MAX_DIAGNOSTIC_LOG_AGE_MS;
  try {
    const metadata = lstatSync(fatal);
    let remove =
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_DIAGNOSTIC_FATAL_BYTES;
    if (!remove && metadata.size > 0) {
      const oldestAtMs = oldestRecordAtMs(fatal);
      remove = oldestAtMs === null ? metadata.mtimeMs < cutoff : oldestAtMs < cutoff;
    }
    if (remove) {
      rmSync(fatal, { force: true });
      ensureJournalFile(fatal);
      fatalSegmentStartedAtMs = currentMs;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function pruneDiagnosticJournalRetention(at = new Date()): Promise<void> {
  if (!targetPath) return Promise.resolve();
  const target = targetPath;
  const sweep = queue.then(() => pruneRetentionAt(target, at.getTime()));
  queue = sweep.catch(() => { writeFailed = true; });
  return sweep;
}

export function initDiagnosticJournal(options: DiagnosticJournalOptions): void {
  if (retentionTimer) clearInterval(retentionTimer);
  targetPath = options.targetPath;
  runtimeProfile = options.profile;
  now = options.now ?? (() => new Date());
  sessionId = options.sessionId ?? createDiagnosticSessionId();
  queue = Promise.resolve();
  pendingWrites = 0;
  droppedWrites = 0;
  writeFailed = false;
  writeMode = options.writeMode ?? "all";
  activeSegmentStartedAtMs = now().getTime();
  fatalSegmentStartedAtMs = activeSegmentStartedAtMs;
  try {
    ensurePrivateDirectory(path.dirname(options.targetPath));
    removeLegacyDevelopmentLogs(options.targetPath);
    removeStaleRotationArtifacts(options.targetPath);
    ensureJournalFile(options.targetPath);
    const currentMetadata = lstatSync(options.targetPath);
    if (!currentMetadata.isFile() || currentMetadata.isSymbolicLink() || currentMetadata.nlink !== 1) {
      throw new Error("Diagnostic journal is not an owned regular file.");
    }
    if (currentMetadata.size > MAX_DIAGNOSTIC_LOG_BYTES) {
      rmSync(options.targetPath, { force: true });
      ensureJournalFile(options.targetPath);
    } else if (currentMetadata.size > 0) {
      rotateSync(options.targetPath);
    }
    pruneExpiredSync(options.targetPath);
    const fatal = fatalPath(options.targetPath);
    ensureJournalFile(fatal);
    const fatalMetadata = lstatSync(fatal);
    const oldestFatalAtMs = oldestRecordAtMs(fatal);
    if (
      fatalMetadata.size > MAX_DIAGNOSTIC_FATAL_BYTES ||
      (fatalMetadata.size > 0 && (
        oldestFatalAtMs === null ||
        oldestFatalAtMs < now().getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS
      ))
    ) {
      rmSync(fatal, { force: true });
      ensureJournalFile(fatal);
    } else if (oldestFatalAtMs !== null) {
      fatalSegmentStartedAtMs = oldestFatalAtMs;
    }
  } catch {
    writeFailed = true;
    targetPath = null;
  }
  writeDiagnosticEvent({
    level: "info",
    area: "diagnostics",
    event: "session-started",
    outcome: "started",
    fields: { profile: options.profile },
  });
  retentionTimer = setInterval(() => {
    void pruneDiagnosticJournalRetention(now()).catch(() => undefined);
  }, RETENTION_SWEEP_INTERVAL_MS);
  retentionTimer.unref?.();
}

export function diagnosticJournalPath(): string | null {
  return targetPath;
}

export function diagnosticJournalProfile(): DiagnosticRuntimeProfile | null {
  return runtimeProfile;
}

export function diagnosticJournalStatus(): DiagnosticJournalStatus {
  return {
    enabled: targetPath !== null,
    path: targetPath,
    profile: runtimeProfile,
    pendingWrites,
    droppedWrites,
    writeFailed,
  };
}

function enqueueLine(line: string): void {
  if (!targetPath) return;
  if (pendingWrites >= MAX_PENDING_WRITES) {
    droppedWrites += 1;
    return;
  }
  const target = targetPath;
  pendingWrites += 1;
  queue = queue
    .then(async () => {
      await pruneExpired(target);
      await rotateBeforeAppend(target, Buffer.byteLength(line));
      await appendNoFollow(target, line);
    })
    .catch(() => {
      writeFailed = true;
    })
    .finally(() => {
      pendingWrites -= 1;
    });
}

function eventForRuntime(input: DiagnosticEventInput): DiagnosticEventV1 {
  const event = createDiagnosticEvent(input, sessionId, now);
  if (runtimeProfile !== "production" || !event.fields) return event;
  const fields = exportableDiagnosticFields(event.fields);
  const { fields: _developmentOnlyFields, ...base } = event;
  return fields ? { ...base, fields } : base;
}

export function writeDiagnosticEvent(input: DiagnosticEventInput): DiagnosticEventV1 {
  const event = eventForRuntime(input);
  if (writeMode === "fatal-only" && event.level !== "fatal") return event;
  recordDiagnosticHealth(event);
  enqueueLine(diagnosticEventLine(event));
  return event;
}

export function writeDiagnosticEventSync(input: DiagnosticEventInput): DiagnosticEventV1 {
  const event = eventForRuntime(input);
  if (writeMode === "fatal-only" && event.level !== "fatal") return event;
  recordDiagnosticHealth(event);
  if (!targetPath) return event;
  const line = diagnosticEventLine(event);
  const target = fatalPath(targetPath);
  try {
    ensurePrivateDirectory(path.dirname(target));
    ensureJournalFile(target);
    const current = lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw new Error("Invalid fatal journal.");
    if (
      current.size + Buffer.byteLength(line) > MAX_DIAGNOSTIC_FATAL_BYTES ||
      now().getTime() - fatalSegmentStartedAtMs >= MAX_DIAGNOSTIC_LOG_AGE_MS
    ) {
      rmSync(target, { force: true });
      ensureJournalFile(target);
      fatalSegmentStartedAtMs = now().getTime();
    }
    const descriptor = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid fatal journal.");
      writeSync(descriptor, line, undefined, "utf8");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    writeFailed = true;
  }
  return event;
}

const LEGACY_AREA_MAP: Readonly<Record<string, DiagnosticArea>> = {
  app: "app",
  assistant: "assistant",
  "aiden-remote": "remote",
  bots: "bots",
  chat: "chat",
  config: "config",
  devlog: "diagnostics",
  "dev-log": "diagnostics",
  dictation: "dictation",
  electron: "electron",
  "electron-lifecycle": "electron",
  git: "git",
  handlers: "ipc",
  ipc: "ipc",
  main: "app",
  "main-window": "renderer",
  mcp: "mcp",
  "mcp-oauth": "mcp",
  models: "models",
  "models-catalog": "models",
  pi: "generation",
  process: "diagnostics",
  providers: "providers",
  "provider-auth": "providers",
  "renderer-lifecycle": "renderer",
  renderer: "renderer",
  schedule: "schedules",
  "scheduled-tasks": "schedules",
  shortcut: "shortcuts",
  subagents: "subagents",
  telegram: "telegram",
  terminal: "terminal",
  updater: "updater",
  usage: "usage",
  voice: "voice",
};

function legacyText(values: unknown[]): string {
  return sanitizeDiagnosticText(
    values
      .filter((value) => !(value instanceof Error))
      .map((value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" "),
    1_024,
  );
}

function legacyEventName(level: Exclude<DiagnosticLevel, "fatal">, area: DiagnosticArea): DiagnosticEventName {
  if (level === "error") return `${area}-failed`;
  if (level === "warn") return `${area}-degraded`;
  return "legacy-log";
}

export function writeLegacyDiagnostic(
  level: Exclude<DiagnosticLevel, "fatal">,
  scope: string,
  values: unknown[],
  synchronous = false,
): DiagnosticEventV1 {
  const error = values.find((value): value is Error => value instanceof Error);
  const projection = error ? projectDiagnosticError(error) : undefined;
  const input: DiagnosticEventInput = {
    level,
    area: LEGACY_AREA_MAP[scope] ?? "diagnostics",
    event: runtimeProfile === "production" ? legacyEventName(level, LEGACY_AREA_MAP[scope] ?? "diagnostics") : "legacy-log",
    ...(level === "error" ? { outcome: "failed" as const } : level === "warn" ? { outcome: "degraded" as const } : {}),
    ...(projection ? { code: projection.code } : {}),
    fields: {
      legacyScope: sanitizeDiagnosticText(scope, 64) || "unknown",
      ...(runtimeProfile === "development" && legacyText(values)
        ? { message: legacyText(values) }
        : {}),
      ...(projection ? { errorType: projection.errorType } : {}),
      ...(projection?.fingerprint ? { fingerprint: projection.fingerprint } : {}),
    },
  };
  if (runtimeProfile === "production" && (level === "debug" || level === "info")) {
    return createDiagnosticEvent(input, sessionId, now);
  }
  return synchronous ? writeDiagnosticEventSync(input) : writeDiagnosticEvent(input);
}

export function formatDiagnosticConsole(event: DiagnosticEventV1): string {
  const details = {
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.code ? { code: event.code } : {}),
    ...(event.fields ? event.fields : {}),
  };
  return `${event.at} ${event.level.toUpperCase()} [${event.area}:${event.event}]${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`;
}

export async function flushDiagnosticJournal(timeoutMs?: number): Promise<boolean> {
  if (timeoutMs === undefined) {
    await queue;
    return true;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      queue.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listDiagnosticJournalFiles(): Promise<string[]> {
  if (!targetPath) return [];
  await flushDiagnosticJournal();
  const files: string[] = [];
  for (let index = 0; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) {
    const candidate = index === 0 ? targetPath : rotatedPath(targetPath, index);
    try {
      const metadata = await fs.stat(candidate);
      if (metadata.isFile()) files.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const fatal = fatalPath(targetPath);
  try {
    const metadata = await fs.lstat(fatal);
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) files.push(fatal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return files;
}

async function copyNoFollow(source: string, destination: string): Promise<boolean> {
  let sourceHandle: fs.FileHandle | undefined;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await sourceHandle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid diagnostic source.");
    const destinationHandle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await destinationHandle.writeFile(await sourceHandle.readFile());
      await destinationHandle.chmod(0o600);
    } finally {
      await destinationHandle.close();
    }
    return true;
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    await sourceHandle?.close();
  }
}

export async function snapshotDiagnosticJournalFiles(destinationDirectory: string, at = new Date()): Promise<string[]> {
  if (!targetPath) return [];
  await pruneDiagnosticJournalRetention(at);
  const target = targetPath;
  const snapshot = queue.then(async () => {
    await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    const sources = [target, ...Array.from({ length: MAX_DIAGNOSTIC_LOG_FILES - 1 }, (_, index) => rotatedPath(target, index + 1)), fatalPath(target)];
    const copied: string[] = [];
    for (const source of sources) {
      const destination = path.join(destinationDirectory, path.basename(source));
      if (await copyNoFollow(source, destination)) copied.push(destination);
    }
    return copied;
  });
  queue = snapshot.then(() => undefined).catch(() => { writeFailed = true; });
  return snapshot;
}

export async function deleteDiagnosticJournalFiles(): Promise<void> {
  if (!targetPath) return;
  await flushDiagnosticJournal();
  for (let index = 0; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) {
    const candidate = index === 0 ? targetPath : rotatedPath(targetPath, index);
    await fs.rm(candidate, { force: true });
  }
  await fs.rm(fatalPath(targetPath), { force: true });
  ensureJournalFile(targetPath);
  ensureJournalFile(fatalPath(targetPath));
}
