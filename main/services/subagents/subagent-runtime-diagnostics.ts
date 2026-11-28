import { randomUUID } from "node:crypto";
import { redactMultilineCredentialBlocks, sanitizeSubagentText } from "../../../renderer/shared/subagent-safe-text.js";
import { redactDevLogSecrets } from "../dev-log.js";
import {
  appendSubagentRuntimeFailureLine,
  deleteSubagentRuntimeDiagnostics,
  flushSubagentRuntimeDiagnostics,
  initSubagentRuntimeDiagnostics,
  MAX_SUBAGENT_RUNTIME_LOG_AGE_MS,
  MAX_SUBAGENT_RUNTIME_LOG_BYTES,
  MAX_SUBAGENT_STARTUP_STDERR_BYTES,
  PROVIDER_FAILURE_CATEGORIES,
  pruneSubagentRuntimeDiagnosticRetention,
  snapshotSubagentRuntimeDiagnostics,
  SUBAGENT_RUNTIME_DIAGNOSTIC_CODES,
  SUBAGENT_RUNTIME_DIAGNOSTIC_STAGES,
  SUBAGENT_RUNTIME_FAILURES,
  SUBAGENT_RUNTIME_LOG_FILENAME,
  subagentRuntimeDiagnosticSinkFailed,
  type SubagentProcessDiagnostic,
  type SubagentRuntimeDiagnosticCode,
  type SubagentRuntimeDiagnosticStage,
  type SubagentRuntimeFailureRecord,
} from "./subagent-runtime-journal.js";

export {
  deleteSubagentRuntimeDiagnostics,
  flushSubagentRuntimeDiagnostics,
  initSubagentRuntimeDiagnostics,
  MAX_SUBAGENT_RUNTIME_LOG_AGE_MS,
  MAX_SUBAGENT_RUNTIME_LOG_BYTES,
  MAX_SUBAGENT_STARTUP_STDERR_BYTES,
  PROVIDER_FAILURE_CATEGORIES,
  pruneSubagentRuntimeDiagnosticRetention,
  snapshotSubagentRuntimeDiagnostics,
  SUBAGENT_RUNTIME_DIAGNOSTIC_CODES,
  SUBAGENT_RUNTIME_DIAGNOSTIC_STAGES,
  SUBAGENT_RUNTIME_FAILURES,
  SUBAGENT_RUNTIME_LOG_FILENAME,
  subagentRuntimeDiagnosticSinkFailed,
  type SubagentProcessDiagnostic,
  type SubagentRuntimeDiagnosticCode,
  type SubagentRuntimeDiagnosticStage,
  type SubagentRuntimeFailureRecord,
};

const MAX_FIELD_CHARS = 240;
const MAX_DETAIL_CHARS = 1_024;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu; // eslint-disable-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu; // eslint-disable-line no-control-regex

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
    // The richer sanitizer must see C0 characters to detect credentials split
    // across controls. Replacing them first would preserve the secret's bytes.
    // Multiline values (YAML block scalars, private-key blocks) are redacted
    // whole before any per-line pass can split their opening line from the body.
    const controlSafe = redactMultilineCredentialBlocks(value.replace(ANSI_ESCAPE_PATTERN, ""));
    // Inspect control-bearing lines first so a sensitive line cannot erase
    // unrelated loader evidence. Then retain the full multiline assignment pass.
    const inspected = controlSafe.split("\n").map((line) =>
      line.replace(CONTROL_CHARACTER_PATTERN, " ") !== line ? sanitizeSubagentText(line) : line,
    ).join("\n");
    const normalized = redactDevLogSecrets(sanitizeSubagentText(inspected).replace(CONTROL_CHARACTER_PATTERN, " "));
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
    // Provider text can echo prompts or opaque credentials. Typed category,
    // stage and code are sufficient. Other sanitized lifecycle evidence remains.
    ...(diagnostic.detail && diagnostic.stage !== "provider" && diagnostic.stage !== "provider_hook"
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
  appendSubagentRuntimeFailureLine(() => boundedRecord(record));
}
