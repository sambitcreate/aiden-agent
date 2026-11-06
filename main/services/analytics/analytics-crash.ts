import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXCEPTION_PROPERTIES, isValidPropValue, type AnalyticsEventProps } from "./analytics-events.js";
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
  // The install id the person had allowed sending under. A record that does
  // not match the current id was captured before an opt-out and is discarded.
  readonly installId?: string;
  // The run that wrote it. Only that run's exit is explained by this record.
  readonly runId?: string;
  readonly exception: SanitizedException;
  readonly context: ExceptionContext;
}

export interface PendingCrashIdentity {
  readonly id?: string;
  readonly installId?: string;
  readonly runId?: string;
}

export interface RunStart {
  readonly runId?: string;
  readonly previousRunUnclean: boolean;
  readonly previousRunId?: string;
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
  options: PendingCrashIdentity & { readonly now: Date },
): string {
  return JSON.stringify({
    version: PENDING_CRASH_VERSION,
    id: options.id ?? randomUUID(),
    capturedAt: options.now.toISOString(),
    ...(options.installId === undefined ? {} : { installId: options.installId }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
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
  if (value.installId !== undefined && (typeof value.installId !== "string" || !UUID.test(value.installId))) return undefined;
  if (value.runId !== undefined && (typeof value.runId !== "string" || !UUID.test(value.runId))) return undefined;
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
    ...(value.installId === undefined ? {} : { installId: value.installId }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
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
  identity: PendingCrashIdentity = {},
): boolean {
  const target = join(directory, PENDING_CRASH_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, serializePendingCrash(exception, context, { ...identity, now }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A leftover temporary file is never read.
    }
    return false;
  }
}

// Reads without removing, so a crash that could not be sent (offline at launch)
// waits for the next one. Damaged records are removed here: they can never be sent.
export function readPendingCrash(directory: string): PendingCrash | undefined {
  let text: string;
  try {
    text = readFileSync(join(directory, PENDING_CRASH_FILE), "utf8");
  } catch {
    return undefined;
  }
  const pending = parsePendingCrash(text);
  if (!pending) deletePendingCrash(directory);
  return pending;
}

// The server acknowledged this record. A newer crash may have replaced it in
// the meantime, and that one still has to be sent.
export function acknowledgePendingCrash(directory: string, id: string): void {
  if (readPendingCrash(directory)?.id === id) deletePendingCrash(directory);
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

// What one diagnostics journal event means for crash reporting. Journal events
// are the single tap point: everything else in the journal is ignored, which
// is what keeps handled failures out.
export type CrashSignal =
  | { readonly kind: "fatal"; readonly error: unknown; readonly origin: "uncaught_exception" | "unhandled_rejection" }
  // The process survives this one, so nothing is written to disk for the next launch.
  | { readonly kind: "main_rejection"; readonly error: unknown }
  | { readonly kind: "renderer_error"; readonly error: unknown; readonly origin: "window_error" | "unhandled_rejection" }
  | { readonly kind: "process_gone"; readonly props: AnalyticsEventProps<"app_crashed"> }
  // The process is ending through JavaScript, so the next launch is not a crash.
  | { readonly kind: "orderly_exit" };

export interface CrashDiagnosticEvent {
  readonly event: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface CrashDiagnosticDetail {
  // Kept out of the journal; see DiagnosticEventDetail.
  readonly rawError?: unknown;
  readonly duringShutdown?: boolean;
}

type CrashReason = NonNullable<AnalyticsEventProps<"app_crashed">["reason"]>;

const PROCESS_GONE_REASONS: Readonly<Record<string, CrashReason>> = {
  "abnormal-exit": "abnormal_exit",
  killed: "killed",
  crashed: "crashed",
  oom: "oom",
  "launch-failed": "launch_failed",
  "integrity-failure": "integrity_failure",
  "memory-eviction": "memory_eviction",
};

function processGone(
  kind: AnalyticsEventProps<"app_crashed">["kind"],
  fields: CrashDiagnosticEvent["fields"],
): CrashSignal | undefined {
  const reason = fields?.reason;
  // A process that exited with code zero did not crash.
  if (reason === "clean-exit") return undefined;
  const exitCode = fields?.exitCode;
  return {
    kind: "process_gone",
    props: {
      kind,
      ...(typeof reason === "string" ? { reason: PROCESS_GONE_REASONS[reason] ?? "other" } : {}),
      ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
    },
  };
}

const RENDERER_ERROR_ORIGINS: Readonly<Record<string, "window_error" | "unhandled_rejection">> = {
  "renderer-global-error": "window_error",
  "renderer-react-uncaught": "window_error",
  "renderer-unhandled-rejection": "unhandled_rejection",
};

export function crashSignalFor(event: CrashDiagnosticEvent, detail?: CrashDiagnosticDetail): CrashSignal | undefined {
  switch (event.event) {
    // Startup failed where Node raises no monitor event, such as a throw in an
    // ES module's top-level code.
    case "bootstrap-import-failed":
      return { kind: "fatal", error: detail?.rawError, origin: "uncaught_exception" };
    case "uncaught-exception":
      return {
        kind: "fatal",
        error: detail?.rawError,
        origin: event.fields?.origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
      };
    case "unhandled-rejection":
      return { kind: "main_rejection", error: detail?.rawError };
    case "renderer-global-error":
    case "renderer-react-uncaught":
    case "renderer-unhandled-rejection":
      // Present only while sending is allowed: a report without it is the
      // content-free form, which has nothing to send.
      return detail?.rawError === undefined
        ? undefined
        : { kind: "renderer_error", error: detail.rawError, origin: RENDERER_ERROR_ORIGINS[event.event]! };
    case "renderer-process-gone":
      return detail?.duringShutdown ? undefined : processGone("renderer", event.fields);
    case "browser-tab-process-gone":
      return detail?.duringShutdown ? undefined : processGone("browser_tab", event.fields);
    case "renderer-crash-loop":
      return { kind: "process_gone", props: { kind: "renderer_loop" } };
    case "child-process-gone": {
      // Aiden stops its own utility processes (subagent workers, local speech)
      // on purpose, so a killed helper is not a crash.
      if (detail?.duringShutdown || event.fields?.reason === "killed") return undefined;
      const type = event.fields?.processType;
      return processGone(type === "GPU" ? "gpu" : type === "Utility" ? "utility" : "other", event.fields);
    }
    case "process-exit":
    case "process-signal":
      return { kind: "orderly_exit" };
    default:
      return undefined;
  }
}

export function beginRun(directory: string, runId: string = randomUUID()): RunStart {
  const marker = join(directory, RUN_MARKER_FILE);
  let previousRunUnclean = false;
  let previousRunId: string | undefined;
  try {
    const previous = readFileSync(marker, "utf8");
    previousRunUnclean = true;
    if (UUID.test(previous)) previousRunId = previous;
  } catch {
    previousRunUnclean = false;
  }
  try {
    writeFileSync(marker, runId, { mode: 0o600 });
  } catch {
    // Without a marker the next launch simply reports a clean start.
  }
  return { runId, previousRunUnclean, ...(previousRunId === undefined ? {} : { previousRunId }) };
}

export function endRun(directory: string): void {
  try {
    rmSync(join(directory, RUN_MARKER_FILE), { force: true });
  } catch {
    // A leftover marker reports one spurious unclean exit at worst.
  }
}
