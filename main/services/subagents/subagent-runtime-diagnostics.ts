import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderFailureCategoryV1 } from "../../../renderer/shared/provider-failure.js";
import { sanitizeSubagentText } from "../../../renderer/shared/subagent-safe-text.js";
import { redactDevLogSecrets } from "../dev-log.js";

export const MAX_SUBAGENT_RUNTIME_LOG_BYTES = 2 * 1024 * 1024;
const MAX_FIELD_CHARS = 240;
const MAX_DETAIL_CHARS = 1_024;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu; // eslint-disable-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu; // eslint-disable-line no-control-regex
export const MAX_SUBAGENT_STARTUP_STDERR_BYTES = 16 * 1024;
export const SUBAGENT_RUNTIME_LOG_FILENAME = "subagent-runtime.log";

let diagnosticLogPath: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

export type SubagentRuntimeDiagnosticStage =
  | "launch"
  | "bootstrap"
  | "protocol"
  | "provider_hook"
  | "provider"
  | "runtime"
  | "cleanup";

export type SubagentRuntimeDiagnosticCode =
  | "launch_failed"
  | "pre_ready_exit"
  | "worker_fatal"
  | "invalid_message"
  | "ipc_budget_exceeded"
  | "readiness_ack_failed"
  | "terminal_ack_failed"
  | "provider_hook_failed"
  | "provider_failure"
  | "stream_reconstruction_failed"
  | "worker_exit"
  | "cleanup_failed"
  | "unknown";

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
  failure: "inference-startup" | "inference" | "policy" | "provider";
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
    const normalized = redactDevLogSecrets(value)
      .replace(ANSI_ESCAPE_PATTERN, "")
      .replace(CONTROL_CHARACTER_PATTERN, " ");
    return sanitizeSubagentText(normalized)
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
  diagnosticLogPath = targetPath;
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    try {
      if (statSync(targetPath).size > MAX_SUBAGENT_RUNTIME_LOG_BYTES) {
        const previous = targetPath.replace(/\.log$/u, ".prev.log");
        renameSync(targetPath, previous);
        chmodSync(previous, 0o600);
      }
    } catch {
      // A missing log or best-effort rotation failure is safe to ignore.
    }
    appendFileSync(targetPath, "", { encoding: "utf8", mode: 0o600 });
    chmodSync(targetPath, 0o600);
  } catch {
    // Diagnostics must never replace the original runtime failure.
  }
}

function previousLogPath(target: string): string {
  return target.endsWith(".log") ? `${target.slice(0, -4)}.prev.log` : `${target}.prev`;
}

async function rotateBeforeAppend(target: string, incomingBytes: number): Promise<void> {
  let existingBytes = 0;
  try {
    existingBytes = (await fs.stat(target)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existingBytes + incomingBytes <= MAX_SUBAGENT_RUNTIME_LOG_BYTES) return;

  const previous = previousLogPath(target);
  await fs.rm(previous, { force: true });
  if (existingBytes > 0) {
    await fs.rename(target, previous);
    await fs.chmod(previous, 0o600);
  }
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
      await rotateBeforeAppend(target, Buffer.byteLength(line));
      await fs.appendFile(target, line, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(target, 0o600);
    })
    .catch(() => {});
}

export async function flushSubagentRuntimeDiagnostics(): Promise<void> {
  await queue;
}
