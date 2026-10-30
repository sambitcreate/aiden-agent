import { createHash } from "node:crypto";

import { sanitizeDiagnosticText } from "../diagnostics-contract.js";
import { COUNT_BUCKETS, UPTIME_BUCKETS } from "./analytics-events.js";

// Every exception is rebuilt from scratch before it leaves the process: the
// message goes through the diagnostics redactor, each stack frame's file is
// rewritten to an app-relative virtual path (or `<external>`), and nothing
// else from the original error object is kept.

export const MAX_EXCEPTION_MESSAGE_LENGTH = 300;
export const MAX_EXCEPTION_FRAMES = 30;
export const MAX_CAUSE_DEPTH = 3;

const EXTERNAL_FILE = "<external>";
const ANONYMOUS_FILE = "<anonymous>";
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+][A-Za-z0-9._@+-]*)*$/u;
const SAFE_NODE_MODULE = /^node:[a-z_/]{1,80}$/u;
const SAFE_FUNCTION_NAME = /^[A-Za-z0-9_$.<>[\] ]{1,100}$/u;
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/u;
const V8_LOCATIONLESS_FRAME = /^\s*at (?:(.+?) \()?(native|<anonymous>)\)?\s*$/u;

export interface SanitizedFrame {
  readonly filename: string;
  readonly function: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly inApp: boolean;
}

export interface SanitizedError {
  readonly type: string;
  readonly value: string;
  readonly frames: readonly SanitizedFrame[];
}

export interface SanitizedException {
  // The thrown error first, then its `cause` chain.
  readonly errors: readonly SanitizedError[];
  readonly fingerprint: string;
}

export interface SanitizeOptions {
  // Absolute paths or URL prefixes of the app bundle (for example the app
  // path, its `app.asar`, or the renderer's origin). Frames under one of
  // these become `app:///<relative path>`; everything else is external.
  readonly appRoots: readonly string[];
}

function errorLike(value: unknown): { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown } | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function safeErrorName(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_NAME.test(value) ? value : "Error";
}

// Thrown non-errors keep only a type label, except strings, which are
// redacted like messages. Object contents are never stringified.
function safeMessage(value: unknown): string {
  if (typeof value === "string") return sanitizeDiagnosticText(value, MAX_EXCEPTION_MESSAGE_LENGTH);
  if (value === undefined || value === null) return "";
  return `[non-string ${typeof value}]`;
}

function normalizeRoot(root: string): string {
  const withoutScheme = root.startsWith("file://") ? safeDecode(root.slice("file://".length)) : root;
  const slashed = withoutScheme.replace(/\\/gu, "/");
  return slashed.endsWith("/") ? slashed : `${slashed}/`;
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function rewriteFramePath(location: string, appRoots: readonly string[]): { filename: string; inApp: boolean } {
  if (location === "native" || location === ANONYMOUS_FILE) return { filename: ANONYMOUS_FILE, inApp: false };
  if (location.startsWith("node:")) {
    return SAFE_NODE_MODULE.test(location) ? { filename: location, inApp: false } : { filename: EXTERNAL_FILE, inApp: false };
  }
  if (location.startsWith("internal/")) {
    const nodePath = `node:${location.replace(/\.js$/u, "")}`;
    return SAFE_NODE_MODULE.test(nodePath) ? { filename: nodePath, inApp: false } : { filename: EXTERNAL_FILE, inApp: false };
  }
  const path = (location.startsWith("file://") ? safeDecode(location.slice("file://".length)) : location).replace(/\\/gu, "/");
  let relative: string | undefined;
  for (const root of appRoots) {
    const normalized = normalizeRoot(root);
    if (normalized.length > 1 && path.startsWith(normalized)) {
      relative = path.slice(normalized.length);
      break;
    }
  }
  if (relative === undefined) {
    // Packaged builds load from inside app.asar wherever the app is installed.
    const asar = path.lastIndexOf("/app.asar/");
    if (asar >= 0) relative = path.slice(asar + "/app.asar/".length);
  }
  relative = relative?.split(/[?#]/u)[0];
  if (!relative || relative.includes("..") || !SAFE_RELATIVE_PATH.test(relative)) {
    return { filename: EXTERNAL_FILE, inApp: false };
  }
  return { filename: `app:///${relative}`, inApp: !relative.split("/").includes("node_modules") };
}

function safeFunctionName(value: string | undefined): string {
  if (!value) return "?";
  const trimmed = value.replace(/^async /u, "").replace(/^new /u, "").trim();
  return SAFE_FUNCTION_NAME.test(trimmed) ? trimmed : "?";
}

export function parseStackFrames(stack: unknown, appRoots: readonly string[]): SanitizedFrame[] {
  if (typeof stack !== "string") return [];
  const frames: SanitizedFrame[] = [];
  for (const line of stack.split("\n")) {
    if (frames.length >= MAX_EXCEPTION_FRAMES) break;
    const match = V8_FRAME.exec(line);
    if (match) {
      // eval frames carry a nested location; only the outer function is useful.
      if (match[2]!.includes("(")) {
        frames.push({ filename: EXTERNAL_FILE, function: "?", inApp: false });
        continue;
      }
      const { filename, inApp } = rewriteFramePath(match[2]!, appRoots);
      if (filename === EXTERNAL_FILE) {
        // Code outside the bundle (user scripts, extensions in user folders)
        // keeps neither its function name nor its position.
        frames.push({ filename, function: "?", inApp: false });
        continue;
      }
      frames.push({
        filename,
        function: safeFunctionName(match[1]),
        lineno: Number(match[3]),
        colno: Number(match[4]),
        inApp,
      });
      continue;
    }
    const locationless = V8_LOCATIONLESS_FRAME.exec(line);
    if (locationless) frames.push({ filename: ANONYMOUS_FILE, function: safeFunctionName(locationless[1]), inApp: false });
  }
  return frames;
}

function sanitizeOne(value: unknown, appRoots: readonly string[]): SanitizedError {
  const error = errorLike(value);
  // Errors from another realm or serialized over IPC are plain objects, so
  // anything with a string message or stack counts as an error.
  if (!error || (typeof error.message !== "string" && typeof error.stack !== "string")) {
    return { type: typeof value === "string" ? "Error" : "NonError", value: safeMessage(value), frames: [] };
  }
  return {
    type: safeErrorName(error.name),
    value: safeMessage(error.message),
    frames: parseStackFrames(error.stack, appRoots),
  };
}

export function exceptionFingerprint(primary: SanitizedError): string {
  const top = primary.frames.slice(0, 3).map((frame) => `${frame.filename}:${frame.function}`);
  return createHash("sha256").update([primary.type, ...top].join("\n")).digest("hex").slice(0, 32);
}

export function sanitizeException(error: unknown, options: SanitizeOptions): SanitizedException {
  const errors: SanitizedError[] = [sanitizeOne(error, options.appRoots)];
  const seen = new Set<unknown>([error]);
  let cause = errorLike(error)?.cause;
  while (cause !== undefined && cause !== null && errors.length <= MAX_CAUSE_DEPTH && !seen.has(cause)) {
    seen.add(cause);
    errors.push(sanitizeOne(cause, options.appRoots));
    cause = errorLike(cause)?.cause;
  }
  return { errors, fingerprint: exceptionFingerprint(errors[0]!) };
}

// Ids that are not in a known, bundled list (custom providers, user models,
// user-made presets) are reported only as "custom".
export function normalizeKnownId(value: unknown, known: ReadonlySet<string>): string {
  return typeof value === "string" && known.has(value) ? value : "custom";
}

export function countBucket(count: number): (typeof COUNT_BUCKETS)[number] {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 2) return "1";
  if (count <= 3) return "2-3";
  if (count <= 10) return "4-10";
  return "11+";
}

export function uptimeBucket(seconds: number): (typeof UPTIME_BUCKETS)[number] {
  if (!Number.isFinite(seconds) || seconds < 60) return "<1m";
  if (seconds < 600) return "1-10m";
  if (seconds < 3600) return "10-60m";
  return "1h+";
}
