// MCP failures as diagnostic events: a small stable classification of the
// error (Pi's MCP/OAuth errors, Aiden's own MCP errors and their causes), the
// server's host for remote servers, and per-(server, failure) coalescing so a
// failing server writes one line per window instead of several per second.
//
// Only fixed vocabularies and grammar-checked values leave this module: never
// URLs, paths, query strings, headers, tokens, client secrets, response bodies,
// or a stdio server's command, arguments or env.

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { types as utilTypes } from "node:util";
import {
  McpAuthRequiredError,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
} from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  OAuthRegistrationError,
} from "@earendil-works/pi-mcp/oauth";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
import {
  MCP_OAUTH_ERROR_CODES,
  projectDiagnosticError,
  type DiagnosticCode,
  type McpFailureCode,
  type McpServerHostKind,
  type DiagnosticEventInput,
  type DiagnosticOutcome,
  type DiagnosticSafeFieldValue,
} from "./diagnostics-contract.js";
import { McpFieldSecretMissingError } from "./mcp-field-secrets-core.js";
import { McpOAuthCancelledError } from "./mcp-oauth-operation.js";
import {
  McpOAuthRefreshUnavailableError,
  McpOAuthSignInRequiredError,
  McpOAuthVerificationRejectedError,
} from "./mcp-oauth-provider-core.js";
import { McpOAuthCredentialStorageError } from "./mcp-oauth-session-cache.js";
import { McpOAuthCallbackError } from "./mcp-oauth-session.js";
import { McpStdioApprovalRequiredError } from "./mcp-stdio-approvals.js";
import { MCP_PRESETS } from "./mcp-presets.js";
import { diagnosticRefSalt } from "./diagnostic-ref-salt.js";
import type { McpServer } from "./types.js";

/** The error classes `errorType` may name (see DIAGNOSTIC_ERROR_TYPES). */
const ERROR_CLASSES: ReadonlyArray<readonly [abstract new (...args: never[]) => Error, string]> = [
  // Subclasses before their parents.
  [McpAuthRequiredError, "McpAuthRequiredError"],
  [McpSessionExpiredError, "McpSessionExpiredError"],
  [McpHttpError, "McpHttpError"],
  [McpError, "McpError"],
  [McpConnectionClosedError, "McpConnectionClosedError"],
  [McpTimeoutError, "McpTimeoutError"],
  [OAuthError, "OAuthError"],
  [OAuthIssuerMismatchError, "OAuthIssuerMismatchError"],
  [OAuthInsecureEndpointError, "OAuthInsecureEndpointError"],
  [OAuthRegistrationError, "OAuthRegistrationError"],
  [McpOAuthAuthorizationRequiredError, "McpOAuthAuthorizationRequiredError"],
  [McpOAuthSignInRequiredError, "McpOAuthSignInRequiredError"],
  [McpOAuthRefreshUnavailableError, "McpOAuthRefreshUnavailableError"],
  [McpOAuthVerificationRejectedError, "McpOAuthVerificationRejectedError"],
  [McpOAuthCancelledError, "McpOAuthCancelledError"],
  [McpOAuthCallbackError, "McpOAuthCallbackError"],
  [McpOAuthCredentialStorageError, "McpOAuthCredentialStorageError"],
  [McpFieldSecretMissingError, "McpFieldSecretMissingError"],
  [McpStdioApprovalRequiredError, "McpStdioApprovalRequiredError"],
];

export interface McpFailureClassification {
  failure: McpFailureCode;
  /** The journal's generic code for the same failure. */
  code: DiagnosticCode;
  /** Error class of the outermost error (a fixed name, "UnknownError" otherwise). */
  errorClass: string;
  httpStatus?: number;
  /** Registered OAuth `error` code, or "other". */
  oauthError?: string;
  /** Node/undici error code from the error or its causes (ECONNREFUSED, ENOTFOUND, …). */
  errno?: string;
}

const NETWORK_ERRNOS = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "EAI_FAIL", "EHOSTDOWN", "EHOSTUNREACH",
  "ENETDOWN", "ENETRESET", "ENETUNREACH", "ENOTFOUND", "EPIPE", "UND_ERR_CLOSED", "UND_ERR_SOCKET",
]);
const TIMEOUT_ERRNOS = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
const SPAWN_ERRNOS = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "E2BIG"]);
const TLS_ERRNO = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$|ERR_OSSL_)/u;
const ERRNO_GRAMMAR = /^[A-Z][A-Z0-9_]{1,47}$/u;
const OVERSIZED_MESSAGE = /\bexceed(?:s|ed) (?:the transport limit|\d+ bytes)/u;
const OAUTH_ERROR_SET: ReadonlySet<string> = new Set(MCP_OAUTH_ERROR_CODES);

export { MCP_FAILURE_CODES, type McpFailureCode } from "./diagnostics-contract.js";

/** Own data property only: never runs getters or proxy traps of an untrusted error. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isInstance(value: unknown, type: abstract new (...args: never[]) => Error): boolean {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return false;
  try {
    return value instanceof type;
  } catch {
    return false;
  }
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current && typeof current === "object" && chain.length < 6 && !chain.includes(current)) {
    chain.push(current);
    current = own(current, "cause");
  }
  return chain;
}

function errnoOf(error: unknown): string | undefined {
  const code = own(error, "code");
  return typeof code === "string" && ERRNO_GRAMMAR.test(code) ? code : undefined;
}

function statusOf(error: unknown): number | undefined {
  for (const key of ["status", "statusCode"]) {
    const value = own(error, key);
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

function oauthErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return OAUTH_ERROR_SET.has(value) ? value : "other";
}

/** The `error` member of a registration response body, when it is JSON. */
function registrationOAuthError(error: unknown): string | undefined {
  const body = own(error, "body");
  if (typeof body !== "string" || body.length > 8_192) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? oauthErrorCode((parsed as { error?: unknown }).error) : undefined;
  } catch {
    return undefined;
  }
}

function statusFailure(status: number): McpFailureCode {
  // Pi also raises McpHttpError for a 2xx it cannot use (202 without a
  // response, an unsupported content type): a protocol failure, not HTTP.
  if (status < 400) return "protocol";
  if (status === 401) return "auth-required";
  if (status === 403) return "auth-rejected";
  if (status === 408 || status === 504) return "timeout";
  return status >= 500 ? "http-5xx" : "http-4xx";
}

function nameOf(error: unknown): unknown {
  const ownName = own(error, "name");
  if (ownName !== undefined) return ownName;
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return undefined;
  try {
    // DOMException's name is a prototype accessor (AbortSignal.abort/timeout
    // reasons); call the platform getter, never one the object supplies.
    if (error instanceof DOMException) {
      return Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(error);
    }
    let prototype: unknown = Object.getPrototypeOf(error);
    for (let depth = 0; prototype && depth < 6; depth += 1) {
      const name = own(prototype, "name");
      if (typeof name === "string") return name;
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** One level of the cause chain, or undefined when it says nothing specific. */
function classifyLevel(error: unknown, transport: McpServer["transport"] | undefined): McpFailureCode | undefined {
  if (isInstance(error, McpOAuthCancelledError)) return "cancelled";
  const name = nameOf(error);
  if (name === "AbortError") return "cancelled";
  if (isInstance(error, McpOAuthSignInRequiredError) || isInstance(error, McpOAuthAuthorizationRequiredError)) return "auth-required";
  if (isInstance(error, McpOAuthVerificationRejectedError)) return "auth-rejected";
  if (isInstance(error, McpOAuthRefreshUnavailableError)) return "auth-refresh-unavailable";
  if (isInstance(error, OAuthRegistrationError)) return "oauth-registration-rejected";
  if (isInstance(error, OAuthIssuerMismatchError)) return "oauth-issuer-mismatch";
  if (isInstance(error, OAuthInsecureEndpointError)) return "oauth-insecure-endpoint";
  if (isInstance(error, OAuthError) || isInstance(error, McpOAuthCallbackError)) return "oauth-error";
  if (isInstance(error, McpSessionExpiredError)) return "session-expired";
  if (isInstance(error, McpHttpError)) {
    const status = statusOf(error);
    return status === undefined ? "protocol" : statusFailure(status);
  }
  if (isInstance(error, McpTimeoutError) || name === "TimeoutError") return "timeout";
  if (isInstance(error, McpStdioApprovalRequiredError)) return "stdio-approval";
  if (isInstance(error, McpOAuthCredentialStorageError) || isInstance(error, McpFieldSecretMissingError)) return "credentials-unavailable";
  if (isInstance(error, McpError) || name === "SyntaxError") return "protocol";
  if (isInstance(error, McpConnectionClosedError)) return transport === "stdio" ? "stdio-exit" : "connection-closed";
  const message = own(error, "message");
  if (typeof message === "string" && OVERSIZED_MESSAGE.test(message)) return "oversized";
  const errno = errnoOf(error);
  if (errno) {
    if (TLS_ERRNO.test(errno)) return "tls";
    if (TIMEOUT_ERRNOS.has(errno)) return "timeout";
    if (NETWORK_ERRNOS.has(errno)) return "network";
    const syscall = own(error, "syscall");
    if (SPAWN_ERRNOS.has(errno) && (transport === "stdio" || (typeof syscall === "string" && syscall.startsWith("spawn")))) {
      return "stdio-spawn";
    }
  }
  const status = statusOf(error);
  if (status !== undefined && status >= 400) return statusFailure(status);
  return undefined;
}

const GENERIC_CODES: Readonly<Record<McpFailureCode, DiagnosticCode | undefined>> = {
  "auth-required": "authentication-failed",
  "auth-rejected": "authentication-failed",
  "auth-refresh-unavailable": "service-unavailable",
  "oauth-error": "authentication-failed",
  "oauth-registration-rejected": "authentication-failed",
  "oauth-issuer-mismatch": "authentication-failed",
  "oauth-insecure-endpoint": "contract-rejected",
  "session-expired": "invalid-state",
  "http-4xx": "invalid-request",
  "http-5xx": "service-unavailable",
  timeout: "timed-out",
  network: "network-failed",
  tls: "network-failed",
  protocol: "contract-rejected",
  "connection-closed": "network-failed",
  "stdio-exit": "service-unavailable",
  "stdio-spawn": "launch-failed",
  "stdio-approval": "permission-denied",
  "credentials-unavailable": "storage-failed",
  oversized: "contract-rejected",
  cancelled: "cancelled",
  unknown: undefined,
};

function errorClassOf(error: unknown): string {
  for (const [type, name] of ERROR_CLASSES) if (isInstance(error, type)) return name;
  // Fixed built-in names only; anything else becomes "UnknownError" downstream.
  return projectDiagnosticError(error).errorType;
}

/**
 * Classify an MCP failure. The outermost level that says something specific
 * wins (a refresh that was unavailable because of ECONNREFUSED stays
 * `auth-refresh-unavailable`, with `errno` from its cause).
 */
export function classifyMcpFailure(error: unknown, transport?: McpServer["transport"]): McpFailureClassification {
  const chain = causeChain(error);
  let failure: McpFailureCode = "unknown";
  for (const level of chain) {
    const classified = classifyLevel(level, transport);
    if (classified) { failure = classified; break; }
  }
  let httpStatus: number | undefined;
  let oauthError: string | undefined;
  let errno: string | undefined;
  for (const level of chain) {
    httpStatus ??= statusOf(level);
    errno ??= errnoOf(level);
    if (oauthError === undefined) {
      if (isInstance(level, OAuthError) || isInstance(level, McpOAuthCallbackError)) oauthError = oauthErrorCode(own(level, "code"));
      else if (isInstance(level, OAuthRegistrationError)) oauthError = registrationOAuthError(level);
    }
  }
  // Aiden's own lowercase codes (e.g. `mcp-oauth-cancelled`) fail the grammar.
  const code = GENERIC_CODES[failure] ?? projectDiagnosticError(error).code;
  return {
    failure,
    code,
    errorClass: errorClassOf(error),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(oauthError ? { oauthError } : {}),
    ...(errno ? { errno } : {}),
  };
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

let presetHosts: ReadonlySet<string> | undefined;

/** Hosts of the bundled connector presets' own endpoints: public vendor services. */
function bundledPresetHosts(): ReadonlySet<string> {
  presetHosts ??= new Set(MCP_PRESETS.flatMap((preset) => {
    const host = hostnameOf(preset.url);
    // Local presets (Figma desktop on 127.0.0.1) are recorded by category like any local host.
    return host && mcpDiagnosticHostKind(host) === "custom" ? [host] : [];
  }));
  return presetHosts;
}

function ipv4Private(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
}

/** Where a remote server lives, without naming a host that could identify a person or tenant. */
export function mcpDiagnosticHostKind(host: string): McpServerHostKind {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare.endsWith(".localhost")) return "loopback";
  const family = isIP(bare);
  if (family === 4) {
    if (bare.startsWith("127.")) return "loopback";
    return ipv4Private(bare) ? "private-ip" : "public-ip";
  }
  if (family === 6) {
    if (bare === "::1") return "loopback";
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(bare);
    if (mapped) return mcpDiagnosticHostKind(mapped[1]!);
    return /^(?:f[cd]|fe[89ab])/u.test(bare) ? "private-ip" : "public-ip";
  }
  return "custom";
}

/**
 * The remote server's hostname, only when it is a bundled connector's own
 * public endpoint (never a tenant subdomain, private name or IP literal), and
 * otherwise a host category.
 */
export function mcpDiagnosticServerHost(
  server: Pick<McpServer, "transport" | "url">,
): { serverHost: string } | { serverHostKind: McpServerHostKind } | undefined {
  if (server.transport === "stdio") return undefined;
  const host = hostnameOf(server.url);
  if (!host) return undefined;
  return bundledPresetHosts().has(host) ? { serverHost: host } : { serverHostKind: mcpDiagnosticHostKind(host) };
}

/**
 * A stable reference for one configured server, so its degraded and
 * recovered lines can be matched without naming it. Salted per install
 * (see diagnostic-ref-salt.ts).
 */
export function mcpDiagnosticServerRef(serverId: string): string {
  return createHash("sha256").update(diagnosticRefSalt()).update("\0mcp-server\0").update(serverId).digest("hex").slice(0, 16);
}

export type McpDiagnosticPhase =
  | "mcp-tool-discovery"
  | "mcp-recent-failure"
  | "mcp-prewarm"
  | "mcp-bot-inventory"
  | "mcp-sign-in";

export type McpDiagnosticServer = Pick<McpServer, "id" | "transport" | "url">;

export interface McpFailureReport {
  phase: McpDiagnosticPhase;
  /** Overrides the outcome derived from the classification. */
  outcome?: DiagnosticOutcome;
  extra?: Readonly<Record<string, DiagnosticSafeFieldValue>>;
}

/** The diagnostic event for one MCP failure. Pure: nothing is written. */
export function mcpFailureEvent(
  event: "mcp-degraded" | "mcp-failed",
  server: McpDiagnosticServer | undefined,
  error: unknown,
  report: McpFailureReport,
  serverRef: (serverId: string) => string = mcpDiagnosticServerRef,
): DiagnosticEventInput {
  const classified = classifyMcpFailure(error, server?.transport);
  const projected = projectDiagnosticError(error);
  // An unapproved local command is a distinct, expected state, not a failure to connect.
  const failurePhase = classified.failure === "stdio-approval" && report.phase !== "mcp-sign-in" ? "mcp-stdio-approval" : report.phase;
  return {
    level: "warn",
    area: "mcp",
    event,
    outcome: report.outcome ?? (classified.failure === "cancelled" ? "cancelled"
      : classified.failure === "timeout" ? "timed-out"
        : event === "mcp-failed" ? "failed" : "degraded"),
    code: classified.code,
    fields: {
      // Caller extras first: they can never replace the classification.
      ...report.extra,
      ...serverFields(server, serverRef),
      mcpFailure: classified.failure,
      errorType: classified.errorClass,
      ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
      ...(classified.oauthError ? { oauthError: classified.oauthError } : {}),
      ...(classified.errno ? { errno: classified.errno } : {}),
      ...(projected.causeCode ? { causeCode: projected.causeCode } : {}),
      ...(projected.fingerprint ? { fingerprint: projected.fingerprint } : {}),
      failurePhase,
    },
  };
}

function serverFields(
  server: McpDiagnosticServer | undefined,
  serverRef: (serverId: string) => string,
): Record<string, DiagnosticSafeFieldValue> {
  if (!server) return {};
  return { transport: server.transport, serverRef: serverRef(server.id), ...mcpDiagnosticServerHost(server) };
}

export interface McpDiagnosticsReporterOptions {
  write: (event: DiagnosticEventInput) => void;
  /** Coalescing window for identical (server, failure) degraded events. */
  windowMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  serverRef?: (serverId: string) => string;
}

interface CoalescingWindow {
  serverId: string;
  timer: unknown;
  /** Repeats seen since the window's last written line. */
  suppressed: number;
  last: DiagnosticEventInput;
}

export const MCP_DIAGNOSTIC_WINDOW_MS = 60_000;

/**
 * Writes MCP degraded/recovered events. The first failure of a (server,
 * failure) pair is written at once; repeats inside the window are counted and
 * written as one line carrying `suppressed` when the window closes, when the
 * server recovers, or on shutdown. Windows for different failures of one
 * server coexist, so a server alternating between two failures writes two
 * lines per window, not one per attempt. A window that saw no repeats closes
 * silently. Recovery is written once per degraded episode.
 */
export class McpDiagnosticsReporter {
  private readonly windows = new Map<string, CoalescingWindow>();
  /** Servers with a degraded line since their last recovery. */
  private readonly degradedServers = new Set<string>();
  private readonly windowMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly serverRef: (serverId: string) => string;
  private closed = false;

  constructor(private readonly options: McpDiagnosticsReporterOptions) {
    this.windowMs = options.windowMs ?? MCP_DIAGNOSTIC_WINDOW_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.serverRef = options.serverRef ?? mcpDiagnosticServerRef;
  }

  /** A background failure: coalesced per (server, failure). */
  degraded(server: McpDiagnosticServer | undefined, error: unknown, report: McpFailureReport): void {
    const event = mcpFailureEvent("mcp-degraded", server, error, report, this.serverRef);
    // After shutdown nothing arms a timer: every line is written as it comes.
    if (!server || this.closed) {
      this.options.write(event);
      return;
    }
    const key = `${server.id}\0${String(event.fields?.mcpFailure)}`;
    const open = this.windows.get(key);
    if (open) {
      open.suppressed += 1;
      open.last = event;
      return;
    }
    this.degradedServers.add(server.id);
    this.options.write(event);
    this.windows.set(key, { serverId: server.id, suppressed: 0, last: event, timer: this.setTimer(() => this.windowElapsed(key), this.windowMs) });
  }

  /** An attended sign-in failure: written at once, never coalesced. */
  signInFailed(server: McpDiagnosticServer, error: unknown): void {
    this.options.write(mcpFailureEvent("mcp-failed", server, error, { phase: "mcp-sign-in" }, this.serverRef));
  }

  /** The server works again; written once if it was degraded. */
  recovered(server: McpDiagnosticServer): void {
    this.flushServer(server.id);
    if (!this.degradedServers.delete(server.id)) return;
    this.options.write({
      level: "info",
      area: "mcp",
      event: "mcp-recovered",
      outcome: "recovered",
      fields: serverFields(server, this.serverRef),
    });
  }

  /** Write pending repeat counts and stop every timer; later lines are written uncoalesced. */
  shutdown(): void {
    this.closed = true;
    for (const key of [...this.windows.keys()]) this.close(key);
    this.degradedServers.clear();
  }

  private windowElapsed(key: string): void {
    const window = this.windows.get(key);
    if (!window) return;
    if (window.suppressed === 0) {
      this.windows.delete(key);
      return;
    }
    // Still failing: write the summary and keep coalescing for another window.
    this.writeSummary(window);
    window.suppressed = 0;
    window.timer = this.setTimer(() => this.windowElapsed(key), this.windowMs);
  }

  private flushServer(serverId: string): void {
    for (const [key, window] of [...this.windows]) if (window.serverId === serverId) this.close(key);
  }

  private close(key: string): void {
    const window = this.windows.get(key);
    if (!window) return;
    this.windows.delete(key);
    this.clearTimer(window.timer);
    if (window.suppressed > 0) this.writeSummary(window);
  }

  private writeSummary(window: CoalescingWindow): void {
    this.options.write({ ...window.last, fields: { ...window.last.fields, suppressed: window.suppressed } });
  }
}

export const mcpDiagnostics = new McpDiagnosticsReporter({
  write: (event) => {
    writeDiagnosticEvent(event);
  },
});
