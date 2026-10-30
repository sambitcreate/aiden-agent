import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXCEPTION_PROPERTIES, isValidPropValue } from "./analytics-events.js";
import {
  MAX_CAUSE_DEPTH,
  parseSanitizedError,
  type SanitizedError,
  type SanitizedException,
} from "./analytics-sanitize.js";
import type { ExceptionContext } from "./analytics-core.js";

// A fatal main-process exception cannot be sent before the process dies, so
// the already-sanitized exception is written to userData synchronously and
// sent on the next launch. A run marker, removed on a clean quit, tells the
// next launch that the previous run ended without one.

export const PENDING_CRASH_FILE = "analytics-pending-crash.json";
export const RUN_MARKER_FILE = "analytics-run.marker";
const PENDING_CRASH_VERSION = 1;
const MAX_PENDING_CRASH_BYTES = 64 * 1024;

export interface PendingCrash {
  readonly id: string;
  readonly capturedAt: string;
  readonly exception: SanitizedException;
  readonly context: ExceptionContext;
}

const FINGERPRINT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseContext(raw: unknown): ExceptionContext | undefined {
  const context = record(raw);
  if (!context) return undefined;
  const checks: [keyof typeof EXCEPTION_PROPERTIES, unknown][] = [
    ["source", context.source],
    ["level", context.level],
    ["process_type", context.processType],
    ["origin", context.origin],
  ];
  for (const [key, value] of checks) {
    const spec = EXCEPTION_PROPERTIES[key];
    if (value === undefined && "optional" in spec) continue;
    if (!isValidPropValue(spec, value)) return undefined;
  }
  // Process uptime is fractional seconds, so any finite nonnegative number is valid.
  if (context.uptimeSeconds !== undefined && !(typeof context.uptimeSeconds === "number" && Number.isFinite(context.uptimeSeconds) && context.uptimeSeconds >= 0)) {
    return undefined;
  }
  if (context.appVersion !== undefined && !isValidPropValue({ kind: "version" }, context.appVersion)) return undefined;
  return {
    source: context.source as ExceptionContext["source"],
    level: context.level as ExceptionContext["level"],
    ...(context.processType === undefined ? {} : { processType: context.processType as ExceptionContext["processType"] }),
    ...(context.origin === undefined ? {} : { origin: context.origin as ExceptionContext["origin"] }),
    ...(context.uptimeSeconds === undefined ? {} : { uptimeSeconds: context.uptimeSeconds as number }),
    ...(context.appVersion === undefined ? {} : { appVersion: context.appVersion as string }),
  };
}

export function serializePendingCrash(
  exception: SanitizedException,
  context: ExceptionContext,
  options: { readonly now: Date; readonly id?: string },
): string {
  return JSON.stringify({
    version: PENDING_CRASH_VERSION,
    id: options.id ?? randomUUID(),
    capturedAt: options.now.toISOString(),
    exception,
    context,
  });
}

// The file is re-validated as strictly as a fresh sanitize, so a tampered or
// damaged record is discarded instead of sent.
export function parsePendingCrash(text: string): PendingCrash | undefined {
  if (text.length > MAX_PENDING_CRASH_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = record(raw);
  if (!value || value.version !== PENDING_CRASH_VERSION) return undefined;
  if (typeof value.id !== "string" || !UUID.test(value.id)) return undefined;
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) return undefined;
  const exception = record(value.exception);
  if (!exception || typeof exception.fingerprint !== "string" || !FINGERPRINT.test(exception.fingerprint)) return undefined;
  if (!Array.isArray(exception.errors) || exception.errors.length === 0 || exception.errors.length > MAX_CAUSE_DEPTH + 1) {
    return undefined;
  }
  const errors: SanitizedError[] = [];
  for (const rawError of exception.errors) {
    const error = parseSanitizedError(rawError);
    if (!error) return undefined;
    errors.push(error);
  }
  const context = parseContext(value.context);
  if (!context) return undefined;
  return {
    id: value.id,
    capturedAt: value.capturedAt,
    exception: { errors, fingerprint: exception.fingerprint },
    context,
  };
}

// Runs inside an uncaughtException handler, so it is synchronous and
// swallows its own failures.
export function writePendingCrashSync(
  directory: string,
  exception: SanitizedException,
  context: ExceptionContext,
  now: Date,
): boolean {
  const target = join(directory, PENDING_CRASH_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, serializePendingCrash(exception, context, { now }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    return true;
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }
}

// Reads and removes the record in one step, so a crash that keeps recurring
// while sending cannot report the same record twice.
export function takePendingCrash(directory: string): PendingCrash | undefined {
  const target = join(directory, PENDING_CRASH_FILE);
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
  deletePendingCrash(directory);
  return parsePendingCrash(text);
}

// Called when analytics is turned off, so nothing captured earlier is sent
// after the person opts back in.
export function deletePendingCrash(directory: string): void {
  try {
    rmSync(join(directory, PENDING_CRASH_FILE), { force: true });
  } catch {
    // Best effort; a stale file is re-validated before anything is sent.
  }
}

export function beginRun(directory: string): { readonly previousRunUnclean: boolean } {
  const marker = join(directory, RUN_MARKER_FILE);
  let previousRunUnclean = false;
  try {
    readFileSync(marker);
    previousRunUnclean = true;
  } catch {
    previousRunUnclean = false;
  }
  try {
    writeFileSync(marker, "", { mode: 0o600 });
  } catch {
    // Without a marker the next launch simply reports a clean start.
  }
  return { previousRunUnclean };
}

export function endRun(directory: string): void {
  try {
    rmSync(join(directory, RUN_MARKER_FILE), { force: true });
  } catch {
    // A leftover marker reports one spurious unclean exit at worst.
  }
}
