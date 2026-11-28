import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PROVIDER_FAILURE_CATEGORIES, type ProviderFailureCategoryV1 } from "../../../renderer/shared/provider-failure.js";

export const MAX_SUBAGENT_RUNTIME_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_SUBAGENT_RUNTIME_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_SUBAGENT_STARTUP_STDERR_BYTES = 16 * 1024;
export const SUBAGENT_RUNTIME_LOG_FILENAME = "subagent-runtime.log";

let diagnosticLogPath: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
let sinkFailed = false;
let activeSegmentStartedAtMs = 0;
let retentionTimer: NodeJS.Timeout | undefined;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export function ensurePrivateDiagnosticDirectory(directory: string): void {
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

function previousLogPath(target: string): string {
  return target.endsWith(".log") ? `${target.slice(0, -4)}.prev.log` : `${target}.prev`;
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

export function appendSubagentRuntimeFailureLine(buildLine: () => string): void {
  if (!diagnosticLogPath) return;
  const target = diagnosticLogPath;
  const line = buildLine();
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
