import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PROVIDER_FAILURE_CATEGORIES, type ProviderFailureCategoryV1 } from "../../../renderer/shared/provider-failure.js";
import { sanitizeSubagentText } from "../../../renderer/shared/subagent-safe-text.js";
import { redactDevLogSecrets } from "../dev-log.js";

export const MAX_SUBAGENT_RUNTIME_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_SUBAGENT_RUNTIME_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FIELD_CHARS = 240;
const MAX_DETAIL_CHARS = 1_024;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu; // eslint-disable-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu; // eslint-disable-line no-control-regex
export const MAX_SUBAGENT_STARTUP_STDERR_BYTES = 16 * 1024;
export const SUBAGENT_RUNTIME_LOG_FILENAME = "subagent-runtime.log";

let diagnosticLogPath: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let sinkFailed = false;
let activeSegmentStartedAtMs = 0;
let retentionTimer: NodeJS.Timeout | undefined;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

function ensurePrivateDiagnosticDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("Invalid diagnostic directory.");
  const directoryDescriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const validatedDirectory = fstatSync(directoryDescriptor);
    if (!validatedDirectory.isDirectory()) throw new Error("Invalid diagnostic directory.");
    fchmodSync(directoryDescriptor, 0o700);
  } finally {
    closeSync(directoryDescriptor);
  }
}

export const SUBAGENT_RUNTIME_DIAGNOSTIC_STAGES = [
  "launch", "bootstrap", "protocol", "provider_hook", "provider", "runtime", "cleanup",
] as const;
export type SubagentRuntimeDiagnosticStage = (typeof SUBAGENT_RUNTIME_DIAGNOSTIC_STAGES)[number];

export const SUBAGENT_RUNTIME_DIAGNOSTIC_CODES = [
  "launch_failed", "pre_ready_exit", "worker_fatal", "invalid_message", "ipc_budget_exceeded",
  "readiness_ack_failed", "terminal_ack_failed", "provider_hook_failed", "provider_failure",
  "stream_reconstruction_failed", "worker_exit", "cleanup_failed", "unknown",
] as const;
export type SubagentRuntimeDiagnosticCode = (typeof SUBAGENT_RUNTIME_DIAGNOSTIC_CODES)[number];

export const SUBAGENT_RUNTIME_FAILURES = ["inference-startup", "inference", "policy", "provider"] as const;

export interface SubagentProcessDiagnostic {
  stage: SubagentRuntimeDiagnosticStage;
  code: SubagentRuntimeDiagnosticCode;
  durationMs?: number;
  exitCode?: number | null;
  providerCategory?: ProviderFailureCategoryV1;
  detail?: string;
}

export interface SubagentRuntimeFailureRecord {
  diagnosticId: string;
  runId?: string;
  generationId?: string;
  childId?: string;
  providerId: string;
  modelId: string;
  failure: (typeof SUBAGENT_RUNTIME_FAILURES)[number];
  attempts: number;
  diagnostics: readonly SubagentProcessDiagnostic[];
}

export function createSubagentDiagnosticId(): string {
  return `SA-${randomUUID()}`;
}

/**
 * Keep bootstrap evidence useful without retaining prompts, credentials, URLs,
 * or machine-specific paths. This text is main-only and never enters IPC or a
 * run snapshot.
 */
export function sanitizeSubagentDiagnosticText(value: string): string {
  try {
    // Preserve line boundaries through the richer subagent grammar so one
    // assigned credential cannot consume unrelated diagnostic lines.
    const controlSafe = value
      .replace(ANSI_ESCAPE_PATTERN, "")
      .replace(CONTROL_CHARACTER_PATTERN, " ");
    const normalized = redactDevLogSecrets(sanitizeSubagentText(controlSafe));
    return normalized
      .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, "[REDACTED URL]")
      .replace(/\bfile:\/\/\/[^\s"'<>]+/giu, "[REDACTED PATH]")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 2_048);
  } catch {
    return "[REDACTED DIAGNOSTIC]";
  }
}

/** Retain only a bounded tail because module-loader causes are normally last. */
export class BoundedSubagentDiagnosticCapture {
  private value = Buffer.alloc(0);
  private enabled = true;

  constructor(private readonly maxBytes = MAX_SUBAGENT_STARTUP_STDERR_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Invalid subagent diagnostic capture budget.");
    }
  }

  append(chunk: string | Buffer): void {
    if (!this.enabled) return;
    const next = Buffer.concat([this.value, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this.value = next.length > this.maxBytes ? next.subarray(next.length - this.maxBytes) : next;
  }

  stop(): void {
    this.enabled = false;
  }

  text(): string | undefined {
    const text = sanitizeSubagentDiagnosticText(this.value.toString("utf8"));
    return text || undefined;
  }
}

export function initSubagentRuntimeDiagnostics(targetPath: string): void {
  if (retentionTimer) clearInterval(retentionTimer);
  diagnosticLogPath = targetPath;
  sinkFailed = false;
  activeSegmentStartedAtMs = Date.now();
  try {
    const directory = path.dirname(targetPath);
    ensurePrivateDiagnosticDirectory(directory);
    try {
      const metadata = lstatSync(targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("Invalid subagent journal.");
      if (metadata.size > MAX_SUBAGENT_RUNTIME_LOG_BYTES) {
        rmSync(targetPath, { force: true });
      } else if (metadata.size > 0) {
        const previous = targetPath.replace(/\.log$/u, ".prev.log");
        rmSync(previous, { force: true });
        renameSync(targetPath, previous);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const previous = previousLogPath(targetPath);
    try {
      const metadata = lstatSync(previous);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > MAX_SUBAGENT_RUNTIME_LOG_BYTES ||
        metadata.mtimeMs < Date.now() - MAX_SUBAGENT_RUNTIME_LOG_AGE_MS
      ) rmSync(previous, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const descriptor = openSync(targetPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid subagent journal.");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    sinkFailed = true;
    diagnosticLogPath = null;
    // Diagnostics must never replace the original runtime failure.
  }
  retentionTimer = setInterval(() => {
    void pruneSubagentRuntimeDiagnosticRetention().catch(() => undefined);
  }, RETENTION_SWEEP_INTERVAL_MS);
  retentionTimer.unref?.();
}

function previousLogPath(target: string): string {
  return target.endsWith(".log") ? `${target.slice(0, -4)}.prev.log` : `${target}.prev`;
}

async function rotateBeforeAppend(target: string, incomingBytes: number): Promise<void> {
  let existingBytes = 0;
  try {
    const metadata = await fs.lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("Invalid subagent journal.");
    existingBytes = metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ageExpired = Date.now() - activeSegmentStartedAtMs >= MAX_SUBAGENT_RUNTIME_LOG_AGE_MS;
  if (
    existingBytes + incomingBytes <= MAX_SUBAGENT_RUNTIME_LOG_BYTES &&
    !ageExpired
  ) return;

  const previous = previousLogPath(target);
  if (ageExpired) {
    await fs.rm(target, { force: true });
  } else {
    await fs.rm(previous, { force: true });
  }
  if (!ageExpired && existingBytes > 0) {
    await fs.rename(target, previous);
  }
  activeSegmentStartedAtMs = Date.now();
}

export function subagentRuntimeDiagnosticLogPath(): string | null {
  return diagnosticLogPath;
}

function boundedRecord(record: SubagentRuntimeFailureRecord): string {
  const diagnostics = record.diagnostics.slice(-4).map((diagnostic) => ({
    stage: diagnostic.stage,
    code: diagnostic.code,
    ...(diagnostic.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, Math.round(diagnostic.durationMs)) }),
    ...(diagnostic.exitCode === undefined ? {} : { exitCode: diagnostic.exitCode }),
    ...(diagnostic.providerCategory === undefined
      ? {}
      : { providerCategory: diagnostic.providerCategory }),
    ...(diagnostic.detail
      ? { detail: sanitizeSubagentDiagnosticText(diagnostic.detail).slice(0, MAX_DETAIL_CHARS) }
      : {}),
  }));
  const line = JSON.stringify({
    at: new Date().toISOString(),
    diagnosticId: record.diagnosticId,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.generationId ? { generationId: record.generationId } : {}),
    ...(record.childId ? { childId: record.childId } : {}),
    providerId: sanitizeSubagentDiagnosticText(record.providerId).slice(0, MAX_FIELD_CHARS),
    modelId: sanitizeSubagentDiagnosticText(record.modelId).slice(0, MAX_FIELD_CHARS),
    failure: record.failure,
    attempts: Math.max(1, Math.floor(record.attempts)),
    diagnostics,
  });
  return `${line}\n`;
}

export function writeSubagentRuntimeFailure(record: SubagentRuntimeFailureRecord): void {
  if (!diagnosticLogPath) return;
  const target = diagnosticLogPath;
  const line = boundedRecord(record);
  queue = queue
    .then(async () => {
      ensurePrivateDiagnosticDirectory(path.dirname(target));
      await rotateBeforeAppend(target, Buffer.byteLength(line));
      const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid subagent journal.");
        await handle.writeFile(line, "utf8");
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    })
    .catch(() => { sinkFailed = true; });
}

export async function flushSubagentRuntimeDiagnostics(timeoutMs?: number): Promise<boolean> {
  const pending = queue.then(() => true);
  if (timeoutMs === undefined) return pending;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return false;
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const result = await Promise.race([pending, expired]);
  if (timeout) clearTimeout(timeout);
  return result;
}

export function subagentRuntimeDiagnosticSinkFailed(): boolean {
  return sinkFailed;
}

export function pruneSubagentRuntimeDiagnosticRetention(at = new Date()): Promise<void> {
  if (!diagnosticLogPath) return Promise.resolve();
  const target = diagnosticLogPath;
  const sweep = queue.then(async () => {
    try {
      const directoryMetadata = await fs.lstat(path.dirname(target));
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error("Invalid subagent diagnostic directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = at.getTime() - MAX_SUBAGENT_RUNTIME_LOG_AGE_MS;
    for (const candidate of [target, previousLogPath(target)]) {
      try {
        const metadata = await fs.lstat(candidate);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.nlink !== 1 ||
          metadata.size > MAX_SUBAGENT_RUNTIME_LOG_BYTES ||
          (metadata.size > 0 && metadata.mtimeMs < cutoff)
        ) await fs.rm(candidate, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const descriptor = await fs.open(
      target,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = await descriptor.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid subagent journal.");
      await descriptor.chmod(0o600);
    } finally {
      await descriptor.close();
    }
  });
  queue = sweep.catch(() => { sinkFailed = true; });
  return sweep;
}

async function copySubagentFile(source: string, destination: string): Promise<boolean> {
  try {
    const sourceHandle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const metadata = await sourceHandle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("Invalid subagent diagnostic source.");
      const destinationHandle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        await destinationHandle.writeFile(await sourceHandle.readFile());
        await destinationHandle.chmod(0o600);
      } finally {
        await destinationHandle.close();
      }
    } finally {
      await sourceHandle.close();
    }
    return true;
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

export async function snapshotSubagentRuntimeDiagnostics(destinationDirectory: string, at = new Date()): Promise<string[]> {
  if (!diagnosticLogPath) return [];
  await pruneSubagentRuntimeDiagnosticRetention(at);
  const target = diagnosticLogPath;
  const snapshot = queue.then(async () => {
    await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    const copied: string[] = [];
    for (const source of [target, previousLogPath(target)]) {
      const destination = path.join(destinationDirectory, path.basename(source));
      if (await copySubagentFile(source, destination)) copied.push(destination);
    }
    return copied;
  });
  queue = snapshot.then(() => undefined).catch(() => { sinkFailed = true; });
  return snapshot;
}

export async function deleteSubagentRuntimeDiagnostics(): Promise<void> {
  if (!diagnosticLogPath) return;
  const target = diagnosticLogPath;
  const deletion = queue.then(async () => {
    await fs.rm(target, { force: true });
    await fs.rm(previousLogPath(target), { force: true });
  });
  queue = deletion.catch(() => { sinkFailed = true; });
  await deletion;
}

export { PROVIDER_FAILURE_CATEGORIES };
