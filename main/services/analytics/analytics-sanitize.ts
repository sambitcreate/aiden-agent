import { createHash } from "node:crypto";
import { builtinModules } from "node:module";

import { stackWithoutMessage } from "../../../renderer/shared/diagnostics.js";
import { sanitizeDiagnosticText } from "../diagnostics-contract.js";
import { COUNT_BUCKETS, UPTIME_BUCKETS } from "./analytics-events.js";

// Every exception is rebuilt from scratch before it leaves the process: the
// message survives only if it is a recognised engine message (anything else
// could be chat text, which no redactor can spot), each stack frame's file is
// rewritten to an app-relative virtual path (or `<external>`), and nothing
// else from the original error object is kept.

export const MAX_EXCEPTION_MESSAGE_LENGTH = 300;
export const MAX_EXCEPTION_FRAMES = 30;
export const MAX_CAUSE_DEPTH = 3;
// What replaces every message that is not on the list below.
export const WITHHELD_MESSAGE = "[message withheld]";

// Crash capture must stay fast on hostile input, so regexes only ever see a
// bounded slice: an error can carry a message or stack of any size.
const MAX_RAW_MESSAGE_LENGTH = 2_048;
const MAX_RAW_STACK_LENGTH = 16_384;
const MAX_STACK_LINE_LENGTH = 1_024;
// No real bundle has a line or column this large; a longer number is text.
const MAX_FRAME_POSITION = 99_999_999;

const EXTERNAL_FILE = "<external>";
const ANONYMOUS_FILE = "<anonymous>";
// A name can be set from anything, and text shaped like a class can still say
// something private, so only these fixed names leave the device: the language's
// own, Node's and the web platform's. Every other name is reported as `Error`.
const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "AggregateError",
  "AssertionError",
  "ConstraintError",
  "DOMException",
  "DataCloneError",
  "DataError",
  "EncodingError",
  "Error",
  "EvalError",
  "HierarchyRequestError",
  "IndexSizeError",
  "InvalidAccessError",
  "InvalidCharacterError",
  "InvalidModificationError",
  "InvalidNodeTypeError",
  "InvalidStateError",
  "NamespaceError",
  "NetworkError",
  "NoModificationAllowedError",
  "NonError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "NotSupportedError",
  "OperationError",
  "PostHogFetchError",
  "QuotaExceededError",
  "RangeError",
  "ReadOnlyError",
  "ReferenceError",
  "SecurityError",
  "SuppressedError",
  "SyntaxError",
  "SystemError",
  "TimeoutError",
  "TransactionInactiveError",
  "TypeError",
  "URIError",
  "URLMismatchError",
  "UnknownError",
  "VersionError",
  "WrongDocumentError",
  "ZodError",
]);
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+][A-Za-z0-9._@+-]*)*$/u;
// Only code can run from the bundle, so nothing else belongs in a frame.
const CODE_FILE = /\.(?:[cm]?js|[cm]?ts|[jt]sx|html)$/u;
const NODE_MODULES: ReadonlySet<string> = new Set([
  "internal",
  ...builtinModules.map((name) => name.replace(/^node:/u, "").split("/")[0]!),
]);
// One code identifier, so a line of prose cannot pass for a function name.
const SAFE_FUNCTION_NAME = /^(?=.{1,100}$)[A-Za-z0-9_$.<>]+$/u;
// V8's `[as key]` suffix names the property called, which can be a runtime key.
const FUNCTION_ALIAS = / \[as [^\]]*\]$/u;
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/u;
// What a sanitized frame or error may contain, checked again wherever one
// is read back (a pending-crash file, the outgoing guard).
const SAFE_FILENAME = /^(?:app:\/\/\/[A-Za-z0-9_@+][A-Za-z0-9._@+/-]*|node:[a-z_0-9]{1,30}|<external>|<anonymous>)$/u;
// Any address-shaped token, including ones inside otherwise harmless text.
const EMAIL_ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const V8_LOCATIONLESS_FRAME = /^\s*at (?:(.+?) \()?(native|<anonymous>)\)?\s*$/u;

// Messages the JavaScript engine, Node, Chromium or Electron write themselves.
// Every message that comes out of this list is fixed text. Where the runtime
// quotes a name, that name can be a value from data (`map[userName].x`), so it
// is replaced with `[name]`. Each pattern runs on redacted text and must accept
// its own output, because a record read back is checked again. Add only a fixed
// message: an app-thrown message is often built from a reply or a prompt.
const NAME = "[name]";
const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]{0,63}";
const VARIABLE = `(?:\\[name\\]|${IDENTIFIER})`;
const ACCESS_PATH = `(?:\\[name\\]|(?:\\(intermediate value\\)|${IDENTIFIER})(?:\\.${IDENTIFIER}|\\(\\.\\.\\.\\)|\\[\\.\\.\\.\\])*)`;
// Node's system errors, by libuv's own text.
const FILE_SYSTEM_ERRORS: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EADDRINUSE: "address already in use",
  EAGAIN: "resource temporarily unavailable",
  EBADF: "bad file descriptor",
  EBUSY: "resource busy or locked",
  ECANCELED: "operation canceled",
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset by peer",
  EEXIST: "file already exists",
  EINVAL: "invalid argument",
  EIO: "i/o error",
  EISDIR: "illegal operation on a directory",
  ELOOP: "too many symbolic links encountered",
  EMFILE: "too many open files",
  ENFILE: "file table overflow",
  ENOENT: "no such file or directory",
  ENOMEM: "not enough memory",
  ENOSPC: "no space left on device",
  ENOTCONN: "socket is not connected",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  EPERM: "operation not permitted",
  EPIPE: "broken pipe",
  EROFS: "read-only file system",
  ETIMEDOUT: "connection timed out",
  EXDEV: "cross-device link not permitted",
};
const SYSTEM_ERROR = Object.entries(FILE_SYSTEM_ERRORS).map(([code, text]) => `${code}: ${text}`).join("|");
const SYSTEM_CALL = "access|chmod|chown|close|copyfile|cp|fstat|fsync|ftruncate|futime|lchown|link|lstat|mkdir|mkdtemp|open|opendir|read|readdir|readlink|realpath|rename|rm|rmdir|scandir|stat|symlink|unlink|utime|write";
const NETWORK_ERROR = "EACCES|EADDRINUSE|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT";
const KNOWN_ENGINE_MESSAGES: readonly (readonly [RegExp, string?])[] = [
  [/^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)$/u],
  [new RegExp(`^Cannot (read|set) propert(?:y|ies) of (undefined|null) \\((reading|setting) '${VARIABLE}'\\)$`, "u"), `Cannot $1 properties of $2 ($3 '${NAME}')`],
  [new RegExp(`^Cannot destructure property '${VARIABLE}' of '${ACCESS_PATH}' as it is (undefined|null)\\.$`, "u"), `Cannot destructure property '${NAME}' of '${NAME}' as it is $1.`],
  [new RegExp(`^${ACCESS_PATH} is not (a function|a constructor|iterable|async iterable|defined)$`, "u"), `${NAME} is not $1`],
  [/^(?:undefined|object null) is not iterable \(cannot read property Symbol\(Symbol\.(?:async)?[iI]terator\)\)$/u],
  [new RegExp(`^Cannot access '${VARIABLE}' before initialization$`, "u"), `Cannot access '${NAME}' before initialization`],
  [new RegExp(`^Class constructor ${VARIABLE} cannot be invoked without 'new'$`, "u"), `Class constructor ${NAME} cannot be invoked without 'new'`],
  [/^Assignment to constant variable\.$/u],
  [/^Maximum call stack size exceeded$/u],
  [/^Invalid (?:array|string) length$/u],
  [/^Invalid time value$/u],
  [/^Array buffer allocation failed$/u],
  [/^Unexpected end of JSON input$/u],
  [/^(?:Failed to fetch|Load failed|fetch failed|terminated|socket hang up|other side closed)$/u],
  [/^(?:The|This) operation was aborted\.?$/u],
  [/^signal is aborted without reason$/u],
  [/^Object has been destroyed$/u],
  [/^Render frame was disposed before WebFrameMain could be accessed$/u],
  [/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\.)$/u],
  [/^Script error\.$/u],
  [/^Minified React error #\d{1,4}; visit \[REDACTED URL\] for the full message or use the non-minified dev environment for full errors and additional helpful warnings\.$/u],
  // Any path in these has already been replaced by the redactor.
  [new RegExp(`^(?:${SYSTEM_ERROR})(?:, (?:${SYSTEM_CALL})(?: '\\[REDACTED PATH\\]')?(?: -> '\\[REDACTED PATH\\]')?)?$`, "u")],
  [new RegExp(`^(?:connect|read|write|getaddrinfo|listen) (?:${NETWORK_ERROR})$`, "u")],
];

// The fixed strings this module writes itself must survive being read back.
const OWN_MESSAGES: ReadonlySet<string> = new Set([
  "",
  WITHHELD_MESSAGE,
  "[non-string object]",
  "[non-string number]",
  "[non-string boolean]",
  "[non-string bigint]",
  "[non-string symbol]",
  "[non-string function]",
]);

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
  // these become `app:///<relative path>`; everything else is external, so
  // a folder merely named `app.asar` in someone's home is not the bundle.
  readonly appRoots: readonly string[];
}

function errorLike(value: unknown): { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown } | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isSafeErrorName(value: unknown): value is string {
  return typeof value === "string" && KNOWN_ERROR_NAMES.has(value);
}

function safeErrorName(value: unknown): string {
  return isSafeErrorName(value) ? value : "Error";
}

// The diagnostics redactor handles secrets, URLs, paths and ids; email
// addresses are removed here first so they never depend on another pattern
// happening to swallow them. What is left is kept only if it is a message the
// runtime wrote: redaction cannot recognise a sentence of chat text, and in an
// app built around prompts and replies an error can easily quote one. The type
// and stack still identify the failure.
export function redactExceptionMessage(value: string): string {
  const bounded = value.slice(0, MAX_RAW_MESSAGE_LENGTH).normalize("NFKC").replace(EMAIL_ADDRESS, "[REDACTED EMAIL]");
  const redacted = sanitizeDiagnosticText(bounded, MAX_EXCEPTION_MESSAGE_LENGTH);
  if (OWN_MESSAGES.has(redacted)) return redacted;
  for (const [pattern, fixed] of KNOWN_ENGINE_MESSAGES) {
    if (pattern.test(redacted)) return fixed === undefined ? redacted : redacted.replace(pattern, fixed);
  }
  return WITHHELD_MESSAGE;
}

// Thrown non-errors keep only a type label, except strings, which are
// redacted like messages. Object contents are never stringified.
function safeMessage(value: unknown): string {
  if (typeof value === "string") return redactExceptionMessage(value);
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

// Only the module's own name is kept: the rest of a location that merely looks
// like Node's could be anything, and nothing in it helps with Aiden's own code.
function nodeFrameFile(module: string): string {
  const name = module.split("/")[0]!;
  return NODE_MODULES.has(name) ? `node:${name}` : EXTERNAL_FILE;
}

export function rewriteFramePath(location: string, appRoots: readonly string[]): { filename: string; inApp: boolean } {
  if (location === "native" || location === ANONYMOUS_FILE) return { filename: ANONYMOUS_FILE, inApp: false };
  if (location.startsWith("node:")) return { filename: nodeFrameFile(location.slice("node:".length)), inApp: false };
  if (location.startsWith("internal/")) return { filename: nodeFrameFile(location), inApp: false };
  const path = (location.startsWith("file://") ? safeDecode(location.slice("file://".length)) : location).replace(/\\/gu, "/");
  let relative: string | undefined;
  for (const root of appRoots) {
    const normalized = normalizeRoot(root);
    if (normalized.length > 1 && path.startsWith(normalized)) {
      relative = path.slice(normalized.length);
      break;
    }
  }
  relative = relative?.split(/[?#]/u)[0];
  if (!relative || relative.includes("..") || !SAFE_RELATIVE_PATH.test(relative) || !CODE_FILE.test(relative)) {
    return { filename: EXTERNAL_FILE, inApp: false };
  }
  return { filename: `app:///${relative}`, inApp: !relative.split("/").includes("node_modules") };
}

function isSafeFunctionName(value: string): boolean {
  return SAFE_FUNCTION_NAME.test(value) && sanitizeDiagnosticText(value) === value;
}

function safeFunctionName(value: string | undefined): string {
  if (!value) return "?";
  const trimmed = value.replace(/^async /u, "").replace(/^new /u, "").replace(FUNCTION_ALIAS, "").trim();
  return isSafeFunctionName(trimmed) ? trimmed : "?";
}

function stackFrameLines(stack: string, message: unknown): string[] {
  return stackWithoutMessage(stack, message)
    .slice(0, MAX_RAW_STACK_LENGTH)
    .split("\n")
    .filter((line) => line.length <= MAX_STACK_LINE_LENGTH);
}

function validPosition(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FRAME_POSITION;
}

export function parseStackFrames(stack: unknown, appRoots: readonly string[], message?: unknown): SanitizedFrame[] {
  if (typeof stack !== "string") return [];
  const frames: SanitizedFrame[] = [];
  for (const line of stackFrameLines(stack, message)) {
    if (frames.length >= MAX_EXCEPTION_FRAMES) break;
    const match = V8_FRAME.exec(line);
    if (match) {
      // eval frames carry a nested location; only the outer function is useful.
      if (match[2]!.includes("(")) {
        frames.push({ filename: EXTERNAL_FILE, function: "?", inApp: false });
        continue;
      }
      const { filename, inApp } = rewriteFramePath(match[2]!, appRoots);
      const lineno = Number(match[3]);
      const colno = Number(match[4]);
      if (filename === EXTERNAL_FILE || !validPosition(lineno) || !validPosition(colno)) {
        // Code outside the bundle (user scripts, extensions in user folders)
        // keeps neither its function name nor its position.
        frames.push({ filename: EXTERNAL_FILE, function: "?", inApp: false });
        continue;
      }
      // Only code in the bundle can vouch for a name: a line of text can pose
      // as a frame in Node's code, which needs no real path.
      frames.push({
        filename,
        function: filename.startsWith("app:///") ? safeFunctionName(match[1]) : "?",
        lineno,
        colno,
        inApp,
      });
      continue;
    }
    const locationless = V8_LOCATIONLESS_FRAME.exec(line);
    if (locationless) frames.push({ filename: ANONYMOUS_FILE, function: "?", inApp: false });
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
    frames: parseStackFrames(error.stack, appRoots, error.message),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parseSanitizedFrame(raw: unknown): SanitizedFrame | undefined {
  const frame = record(raw);
  if (!frame) return undefined;
  const { filename, function: fn, lineno, colno, inApp } = frame;
  if (typeof filename !== "string" || !SAFE_FILENAME.test(filename) || filename.includes("..")) return undefined;
  const inBundle = filename.startsWith("app:///");
  if (typeof fn !== "string" || (fn !== "?" && !(inBundle && isSafeFunctionName(fn)))) return undefined;
  if (inBundle && !CODE_FILE.test(filename)) return undefined;
  if (filename.startsWith("node:") && nodeFrameFile(filename.slice("node:".length)) !== filename) return undefined;
  if (typeof inApp !== "boolean") return undefined;
  const hasPosition = lineno !== undefined || colno !== undefined;
  if (hasPosition && !(validPosition(lineno as number) && validPosition(colno as number))) return undefined;
  return {
    filename,
    function: fn,
    ...(hasPosition ? { lineno: lineno as number, colno: colno as number } : {}),
    inApp,
  };
}

// Accepts only what sanitizeOne could have produced; the message is
// redacted again so a record that bypassed sanitizing still cannot leak.
export function parseSanitizedError(raw: unknown): SanitizedError | undefined {
  const error = record(raw);
  if (!error) return undefined;
  if (!isSafeErrorName(error.type)) return undefined;
  if (typeof error.value !== "string" || error.value.length > MAX_EXCEPTION_MESSAGE_LENGTH) return undefined;
  if (!Array.isArray(error.frames) || error.frames.length > MAX_EXCEPTION_FRAMES) return undefined;
  const frames: SanitizedFrame[] = [];
  for (const rawFrame of error.frames) {
    const frame = parseSanitizedFrame(rawFrame);
    if (!frame) return undefined;
    frames.push(frame);
  }
  return { type: error.type, value: redactExceptionMessage(error.value), frames };
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
