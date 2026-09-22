// Compatibility facade for the historical development logger. New code should
// emit typed events through diagnostic-journal.ts. Existing callers remain safe
// while their arbitrary messages are migrated in reviewed service batches.

import {
  diagnosticJournalPath,
  flushDiagnosticJournal,
  initDiagnosticJournal,
  writeLegacyDiagnostic,
} from "./diagnostic-journal.js";
import { sanitizeDiagnosticText } from "./diagnostics-contract.js";

export function initDevLog(targetPath: string): void {
  initDiagnosticJournal({ targetPath, profile: "development" });
}

export function devLogPath(): string | null {
  return diagnosticJournalPath();
}

export function redactDevLogSecrets(value: string): string {
  return sanitizeDiagnosticText(value, Math.max(4_096, value.length));
}

export function writeDevLog(level: "debug" | "info" | "warn" | "error", scope: string, values: unknown[]): void {
  writeLegacyDiagnostic(level, scope, values);
}

/**
 * Append immediately for fatal errors, process signals, and exit handlers.
 * Async work is not guaranteed to run once Node or Electron begins exiting.
 */
export function writeDevLogSync(
  level: "debug" | "info" | "warn" | "error",
  scope: string,
  values: unknown[],
): void {
  writeLegacyDiagnostic(level, scope, values, true);
}

export async function flushDevLog(): Promise<void> {
  await flushDiagnosticJournal();
}
