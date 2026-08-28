import { createHash, randomUUID } from "node:crypto";
import { normalizeDiagnosticErrorType } from "../../renderer/shared/diagnostics.js";

export const DIAGNOSTIC_EVENT_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EVENT_BYTES = 4_096;
export const MAX_DIAGNOSTIC_FIELD_LENGTH = 240;
export const MAX_DIAGNOSTIC_FIELDS = 16;

export const DIAGNOSTIC_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

export const DIAGNOSTIC_AREAS = [
  "app",
  "assistant",
  "attachments",
  "bots",
  "chat",
  "computer-use",
  "config",
  "credentials",
  "diagnostics",
  "dictation",
  "electron",
  "generation",
  "git",
  "ipc",
  "mcp",
  "models",
  "persistence",
  "providers",
  "remote",
  "renderer",
  "schedules",
  "shortcuts",
  "skills",
  "subagents",
  "telegram",
  "terminal",
  "updater",
  "usage",
  "voice",
  "workspaces",
] as const;
export type DiagnosticArea = (typeof DIAGNOSTIC_AREAS)[number];

export const DIAGNOSTIC_BASE_EVENT_NAMES = [
  "unknown",
  "session-started",
  "legacy-log",
  "bootstrap-import-failed",
  "main-window-created",
  "renderer-process-gone",
  "renderer-crash-loop",
  "diagnostic-mode-enabled",
  "renderer-recovery",
  "renderer-unresponsive",
  "renderer-responsive",
  "renderer-load-failed",
  "renderer-preload-failed",
  "renderer-ready",
  "renderer-global-error",
  "renderer-unhandled-rejection",
  "renderer-react-uncaught",
  "renderer-react-caught",
  "renderer-react-recoverable",
  "renderer-route-error",
  "renderer-invalidation-listener-failed",
  "child-process-gone",
  "electron-ready",
  "remote-request-failed",
  "remote-request-slow",
  "process-monitor-installed",
  "uncaught-exception",
  "node-warning",
  "process-exit",
  "process-signal",
  "provider-failed",
  "store-write-failed",
  "skills-discovery-failed",
  "oversize",
  "rotation-fixture",
  "retention-check",
  "backpressure-fixture",
  "write-failure",
] as const;
export type DiagnosticBaseEventName = (typeof DIAGNOSTIC_BASE_EVENT_NAMES)[number];
export type DiagnosticEventName =
  | DiagnosticBaseEventName
  | `${DiagnosticArea}-failed`
  | `${DiagnosticArea}-degraded`;

export const DIAGNOSTIC_OUTCOMES = [
  "cancelled",
  "completed",
  "degraded",
  "failed",
  "recovered",
  "rejected",
  "started",
  "timed-out",
  "unavailable",
] as const;
export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];

export const DIAGNOSTIC_CODES = [
  "cancelled",
  "cleanup-failed",
  "contract-rejected",
  "corrupt-data",
  "directory-sync-failed",
  "disk-full",
  "internal-error",
  "invalid-state",
  "io-failed",
  "launch-failed",
  "network-failed",
  "not-found",
  "permission-denied",
  "provider-failed",
  "rate-limited",
  "renderer-crashed",
  "crash-loop",
  "storage-failed",
  "timed-out",
  "unknown",
  "unresponsive",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type DiagnosticSafeFieldValue = boolean | number | string | null;
export type DiagnosticSafeFields = Readonly<Record<string, DiagnosticSafeFieldValue>>;

export interface DiagnosticEventInput {
  level: DiagnosticLevel;
  area: DiagnosticArea;
  event: DiagnosticEventName;
  operationId?: string;
  durationMs?: number;
  outcome?: DiagnosticOutcome;
  code?: DiagnosticCode;
  fields?: DiagnosticSafeFields;
}

export interface DiagnosticEventV1 extends DiagnosticEventInput {
  version: typeof DIAGNOSTIC_EVENT_VERSION;
  at: string;
  sessionId: string;
}

export interface DiagnosticErrorProjection {
  code: DiagnosticCode;
  errorType: string;
  fingerprint?: string;
}

const CREDENTIAL_ASSIGNMENT =
  /((?<![A-Za-z0-9_-])(?:access[._ -]?token|api[._ -]?key|authorization|aws[._ -]?(?:access[._ -]?key[._ -]?id|secret[._ -]?access[._ -]?key|session[._ -]?token)|client[._ -]?secret|connection[._ -]?string|cookie|credential(?:s)?|database[._ -]?url|db[._ -]?url|encryption[._ -]?key|github[._ -]?token|id[._ -]?token|passwd|password|private[._ -]?token|pwd|refresh[._ -]?token|secret(?:[._ -]?(?:key|token))?|session[._ -]?id|set[._ -]?cookie|signing[._ -]?key|token)\s*(?:["']?\s*:\s*|=\s*))(?:(?:Basic|Bearer)\s+[^\s,;]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu;
const AUTHORIZATION_VALUE = /(?<![A-Za-z0-9])(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const KNOWN_TOKEN =
  /(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|glpat-[0-9A-Za-z_-]{10,}|hf_[0-9A-Za-z]{10,}|npm_[0-9A-Za-z]{10,}|pypi-[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{8,}|xox[baprs]-[0-9A-Za-z-]{8,}|ya29\.[0-9A-Za-z_-]{10,})(?![A-Za-z0-9])/gu;
const CREDENTIAL_URL = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu;
const URL_VALUE = /\b(?:https?|wss?|file):\/\/[^\s"'`<>]+/giu;
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n"'`<>;,]+/gu;
const UNC_PATH = /(?<![A-Za-z0-9])\\\\[^\r\n"'`<>;,]+/gu;
const POSIX_PATH =
  /(^|[\s("'`=:])\/(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|mnt|opt|private|root|sbin|srv|tmp|usr|var)(?:\/[^\r\n)"'`<>;,]*)?/gmu;
const GENERIC_POSIX_PATH =
  /(^|[\s("'`=:])\/(?!\/)(?:[^/\s"'`<>;,]+\/)+[^\s)"'`<>;,]*/gmu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu; // eslint-disable-line no-control-regex
const LONG_IDENTIFIER = /\b[0-9a-f]{32,}\b/giu;
const UUID_VALUE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const SAFE_REFERENCE = /^RD-[A-Za-z0-9-]{8,80}$/u;
const SAFE_FINGERPRINT = /^[0-9a-f]{16}$/u;

const NUMBER_FIELDS = new Set([
  "attempt",
  "attempts",
  "backoffMs",
  "crashCount",
  "exitCode",
  "heapUsedBytes",
  "loadErrorCode",
  "pid",
  "ppid",
  "rssBytes",
  "sequence",
  "suppressed",
  "uptimeSeconds",
]);
const BOOLEAN_FIELDS = new Set(["isMainFrame", "retryable", "snapshotFailed", "truncated"]);
const EXPORT_OMITTED_FIELDS = new Set(["legacyScope", "message"]);
const ENUM_STRING_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  arch: new Set(["arm64", "ia32", "universal", "unknown", "x64"]),
  origin: new Set(["uncaughtException", "unhandledRejection", "unknown"]),
  platform: new Set(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "unknown", "win32"]),
  processType: new Set(["Browser", "GPU", "Pepper Plugin", "Renderer", "Utility", "Zygote", "unknown"]),
  reason: new Set([
    "abnormal-exit",
    "busy",
    "clean-exit",
    "crashed",
    "integrity-failure",
    "killed",
    "launch-failed",
    "not-ready",
    "oom",
    "unknown",
    "unavailable",
  ]),
  remoteCode: new Set([
    "authentication_failed",
    "cancelled",
    "contract_invalid",
    "credential_revoked",
    "forbidden",
    "internal_error",
    "not_found",
    "rate_limited",
    "request_failed",
    "timeout",
    "unavailable",
    "unknown",
  ]),
  latencyBucket: new Set(["2s-plus", "5s-plus", "10s-plus"]),
  profile: new Set(["development", "production"]),
  rendererContext: new Set(["root", "router", "subtree", "window"]),
  routeCategory: new Set([
    "bots",
    "chats",
    "files",
    "git",
    "health",
    "pairing",
    "schedules",
    "speech",
    "usage",
    "workspaces",
    "unknown",
  ]),
  runtimeProfile: new Set(["development", "production"]),
  signal: new Set(["SIGHUP", "SIGINT", "SIGTERM"]),
  statusClass: new Set(["2xx", "4xx", "5xx"]),
  storeClass: new Set(["cache", "chat", "config", "health", "journal", "settings", "subagent", "unknown", "usage"]),
};

function normalizedStringField(key: string, value: string): string | undefined {
  const sanitized = sanitizeDiagnosticText(value);
  if (!sanitized) return undefined;
  const enumerated = ENUM_STRING_FIELDS[key];
  if (enumerated) return enumerated.has(sanitized) ? sanitized : undefined;
  if (key === "errorType") return normalizeDiagnosticErrorType(sanitized);
  if (key === "fingerprint") return SAFE_FINGERPRINT.test(sanitized) ? sanitized : undefined;
  if (key === "referenceId") return SAFE_REFERENCE.test(sanitized) ? sanitized : undefined;
  if (["appVersion", "chromeVersion", "electronVersion", "nodeVersion"].includes(key)) {
    return SAFE_VERSION.test(sanitized) ? sanitized : undefined;
  }
  if (key === "legacyScope") return SAFE_NAME.test(sanitized) ? sanitized : undefined;
  if (key === "message") return sanitized;
  return undefined;
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
}

export function sanitizeDiagnosticText(value: string, maxLength = MAX_DIAGNOSTIC_FIELD_LENGTH): string {
  return value
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(CREDENTIAL_ASSIGNMENT, "$1[REDACTED]")
    .replace(AUTHORIZATION_VALUE, "[REDACTED AUTHORIZATION]")
    .replace(KNOWN_TOKEN, "[REDACTED TOKEN]")
    .replace(CREDENTIAL_URL, "$1[REDACTED]@")
    .replace(URL_VALUE, "[REDACTED URL]")
    .replace(WINDOWS_PATH, "[REDACTED PATH]")
    .replace(UNC_PATH, "[REDACTED PATH]")
    .replace(POSIX_PATH, "$1[REDACTED PATH]")
    .replace(GENERIC_POSIX_PATH, "$1[REDACTED PATH]")
    .replace(UUID_VALUE, "[REDACTED ID]")
    .replace(LONG_IDENTIFIER, "[REDACTED ID]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, Math.max(0, maxLength));
}

function safeOperationId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^op-[0-9a-f]{16}$/u.test(value) ? value : undefined;
}

const DIAGNOSTIC_EVENT_NAME_SET: ReadonlySet<string> = new Set([
  ...DIAGNOSTIC_BASE_EVENT_NAMES,
  ...DIAGNOSTIC_AREAS.flatMap((area) => [`${area}-failed`, `${area}-degraded`]),
]);

function safeEventName(value: string): DiagnosticEventName {
  const candidate = value.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return SAFE_NAME.test(candidate) && DIAGNOSTIC_EVENT_NAME_SET.has(candidate)
    ? (candidate as DiagnosticEventName)
    : "unknown";
}

export function normalizeDiagnosticFields(fields: DiagnosticSafeFields | undefined): DiagnosticSafeFields | undefined {
  if (!fields) return undefined;
  const normalized: Record<string, DiagnosticSafeFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (Object.keys(normalized).length >= MAX_DIAGNOSTIC_FIELDS) break;
    if (typeof value === "string") {
      const safe = normalizedStringField(key, value);
      if (safe !== undefined) normalized[key] = safe;
    } else if (typeof value === "number" && NUMBER_FIELDS.has(key)) {
      normalized[key] = boundedNumber(value);
    } else if (typeof value === "boolean" && BOOLEAN_FIELDS.has(key)) {
      normalized[key] = value;
    } else if (value === null && (key === "errorType" || key === "fingerprint" || key === "remoteCode")) {
      normalized[key] = null;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function exportableDiagnosticFields(
  fields: DiagnosticSafeFields | undefined,
): DiagnosticSafeFields | undefined {
  const normalized = normalizeDiagnosticFields(fields);
  if (!normalized) return undefined;
  const projected = Object.fromEntries(
    Object.entries(normalized).filter(([key]) => !EXPORT_OMITTED_FIELDS.has(key)),
  );
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function isDiagnosticEventName(value: unknown): value is DiagnosticEventName {
  return typeof value === "string" && DIAGNOSTIC_EVENT_NAME_SET.has(value);
}

export function createDiagnosticSessionId(): string {
  return `session-${randomUUID()}`;
}

export function createDiagnosticOperationId(): string {
  return `op-${randomUUID().replace(/-/gu, "").slice(0, 16)}`;
}

export function createDiagnosticEvent(
  input: DiagnosticEventInput,
  sessionId: string,
  now: () => Date = () => new Date(),
): DiagnosticEventV1 {
  const operationId = safeOperationId(input.operationId);
  const fields = normalizeDiagnosticFields(input.fields);
  const event: DiagnosticEventV1 = {
    version: DIAGNOSTIC_EVENT_VERSION,
    at: now().toISOString(),
    sessionId,
    level: DIAGNOSTIC_LEVELS.includes(input.level) ? input.level : "error",
    area: DIAGNOSTIC_AREAS.includes(input.area) ? input.area : "diagnostics",
    event: safeEventName(input.event),
    ...(operationId ? { operationId } : {}),
    ...(input.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, Math.round(boundedNumber(input.durationMs))) }),
    ...(input.outcome && DIAGNOSTIC_OUTCOMES.includes(input.outcome) ? { outcome: input.outcome } : {}),
    ...(input.code && DIAGNOSTIC_CODES.includes(input.code) ? { code: input.code } : {}),
    ...(fields ? { fields } : {}),
  };
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DIAGNOSTIC_EVENT_BYTES) {
    return {
      version: DIAGNOSTIC_EVENT_VERSION,
      at: event.at,
      sessionId,
      level: event.level,
      area: event.area,
      event: event.event,
      outcome: event.outcome,
      code: event.code,
      fields: { truncated: true },
    };
  }
  return event;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate.toUpperCase() : undefined;
}

function diagnosticCodeFor(error: unknown): DiagnosticCode {
  const code = errorCode(error);
  if (code === "ENOENT") return "not-found";
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timed-out";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENETUNREACH") {
    return "network-failed";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return "unknown";
}

export function projectDiagnosticError(error: unknown): DiagnosticErrorProjection {
  const errorType = normalizeDiagnosticErrorType(error instanceof Error ? error.name : undefined);
  const safeFrames =
    error instanceof Error
      ? (error.stack ?? "")
          .split("\n")
          .slice(1, 6)
          .flatMap((line) => {
            const match = /^\s*at\s+([A-Za-z_$][A-Za-z0-9_.$<>-]{0,79})/u.exec(line);
            return match?.[1] ? [match[1]] : [];
          })
      : [];
  const safeSource = [errorType, errorCode(error) ?? "unknown", ...safeFrames].join(":");
  return {
    code: diagnosticCodeFor(error),
    errorType,
    ...(safeSource
      ? { fingerprint: createHash("sha256").update(safeSource).digest("hex").slice(0, 16) }
      : {}),
  };
}

export function diagnosticEventLine(event: DiagnosticEventV1): string {
  return `${JSON.stringify(event)}\n`;
}
