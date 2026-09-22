import { isIP } from "node:net";
import { AIDEN_REMOTE_BASE_PATH } from "./aiden-remote-protocol.js";

export interface AidenTailscaleHandler { Proxy: string }
export interface AidenTailscaleStatus { TCP?: Record<string, { HTTPS?: boolean }>; Web?: Record<string, { Handlers?: Record<string, AidenTailscaleHandler>; Funnel?: boolean }> }

// The public Serve prefix is the canonical API base. Tailscale strips this
// prefix before proxying to the loopback listener, while the client retains
// the one OpenAPI-approved `/api/aiden/v1` endpoint spelling.
export const AIDEN_TAILSCALE_PATH = AIDEN_REMOTE_BASE_PATH;
export interface AidenTailscaleOwnership { path: typeof AIDEN_TAILSCALE_PATH; target: string }
export type AidenTailscaleRouteClassification =
  | { kind: "available" }
  | { kind: "owned"; target: string }
  | { kind: "other_aiden"; target: string }
  | { kind: "unrelated_conflict" }
  | { kind: "funnel_conflict" };

const CANONICAL_LOOPBACK_HTTP_TARGET = new RegExp(
  `^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):([1-9]\\d{0,4})${AIDEN_REMOTE_BASE_PATH}$`,
);
const LEGACY_LOOPBACK_HTTP_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/;

interface ParsedTailscaleAuthority {
  port: number;
  canonicalPort: boolean;
}

function hasUnsafeAuthorityCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x20 || codePoint === 0x7f || "[]/?#@\\%".includes(character)) return true;
  }
  return false;
}

/**
 * Tailscale serializes Web keys from net.JoinHostPort as an SNI host and a
 * decimal port. Do not use URL parsing here: it accepts/canonicalizes aliases
 * that are not the exact keys Tailscale reports.
 */
function parseTailscaleAuthority(authority: string): ParsedTailscaleAuthority | undefined {
  let host: string;
  let rawPort: string;
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (
      closingBracket <= 1 ||
      authority[closingBracket + 1] !== ":" ||
      authority.indexOf("[", 1) !== -1 ||
      authority.indexOf("]", closingBracket + 1) !== -1
    ) {
      return undefined;
    }
    host = authority.slice(1, closingBracket);
    rawPort = authority.slice(closingBracket + 2);
    if (isIP(host) !== 6) return undefined;
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon <= 0 || authority.indexOf(":") !== colon) return undefined;
    host = authority.slice(0, colon);
    rawPort = authority.slice(colon + 1);
  }
  if (!host || hasUnsafeAuthorityCharacter(host) || !/^\d{1,5}$/u.test(rawPort)) return undefined;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { port, canonicalPort: rawPort === String(port) };
}

function httpsEndpoint(status: AidenTailscaleStatus): { handlers: Record<string, AidenTailscaleHandler>; funnel: boolean } {
  const entries: Array<[string, { Handlers?: Record<string, AidenTailscaleHandler>; Funnel?: boolean }]> = [];
  for (const [authority, listener] of Object.entries(status.Web ?? {})) {
    const parsed = parseTailscaleAuthority(authority);
    if (!parsed || !parsed.canonicalPort) throw new Error("tailscale_route_conflict");
    if (parsed.port === 443) entries.push([authority, listener]);
  }
  if (entries.length > 1) throw new Error("tailscale_route_conflict");
  return {
    handlers: entries[0]?.[1].Handlers ?? {},
    funnel: entries[0]?.[1].Funnel === true,
  };
}

export function aidenTailscaleCanonicalRouteSnapshot(status: AidenTailscaleStatus): {
  target?: string;
  funnel: boolean;
  preservedStatus: AidenTailscaleStatus;
} {
  const endpoint = httpsEndpoint(status);
  const preservedStatus = structuredClone(status);
  for (const [authority, listener] of Object.entries(preservedStatus.Web ?? {})) {
    const parsed = parseTailscaleAuthority(authority);
    if (!parsed || !parsed.canonicalPort || parsed.port !== 443) continue;
    if (listener.Handlers) {
      delete listener.Handlers[AIDEN_TAILSCALE_PATH];
      if (Object.keys(listener.Handlers).length === 0) delete listener.Handlers;
    }
    if (Object.keys(listener).length === 0) delete preservedStatus.Web?.[authority];
  }
  if (preservedStatus.Web && Object.keys(preservedStatus.Web).length === 0) delete preservedStatus.Web;
  return {
    ...(endpoint.handlers[AIDEN_TAILSCALE_PATH]?.Proxy
      ? { target: endpoint.handlers[AIDEN_TAILSCALE_PATH]!.Proxy }
      : {}),
    funnel: endpoint.funnel,
    preservedStatus,
  };
}

function assertHttpsCapability(status: AidenTailscaleStatus, nodeHttpsAvailable: boolean): void {
  const configuredListener = status.TCP?.["443"];
  if (configuredListener !== undefined && configuredListener?.HTTPS !== true) {
    throw new Error("tailscale_https_unavailable");
  }
  if (configuredListener?.HTTPS !== true && !nodeHttpsAvailable) {
    throw new Error("tailscale_https_unavailable");
  }
}

function assertServerOwnedLoopbackTarget(target: string, allowLegacyOrigin = false): void {
  // Tailscale strips the mounted public prefix before reverse proxying. The
  // target restores exactly that canonical API base so the shared LAN and
  // loopback router receive identical paths. Validate the wire form before
  // WHATWG URL normalization; arbitrary local paths remain forbidden.
  const canonicalTarget = CANONICAL_LOOPBACK_HTTP_TARGET.exec(target);
  const legacyTarget = allowLegacyOrigin ? LEGACY_LOOPBACK_HTTP_ORIGIN.exec(target) : null;
  const rawTarget = canonicalTarget ?? legacyTarget;
  const rawPort = Number(rawTarget?.[1]);
  if (!rawTarget || !Number.isInteger(rawPort) || rawPort > 65_535) {
    throw new Error("tailscale_target_invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(target);
  } catch {
    throw new Error("tailscale_target_invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== (canonicalTarget ? AIDEN_REMOTE_BASE_PATH : "/") ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.port ||
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  ) {
    throw new Error("tailscale_target_invalid");
  }
}

function isAidenLoopbackTarget(target: string, allowLegacyOrigin = true): boolean {
  try {
    assertServerOwnedLoopbackTarget(target, allowLegacyOrigin);
    return true;
  } catch {
    return false;
  }
}

export function aidenTailscaleHealthEndpoint(target: string): string {
  assertServerOwnedLoopbackTarget(target, true);
  if (CANONICAL_LOOPBACK_HTTP_TARGET.test(target)) return `${target}/health`;
  return `${target.replace(/\/$/u, "")}${AIDEN_REMOTE_BASE_PATH}/health`;
}

export function classifyAidenTailscaleRoute(
  status: AidenTailscaleStatus,
  target: string,
  ownership?: AidenTailscaleOwnership,
): AidenTailscaleRouteClassification {
  assertServerOwnedLoopbackTarget(target);
  const canonicalListeners = Object.entries(status.Web ?? {}).filter(([authority]) => {
    const parsed = parseTailscaleAuthority(authority);
    return parsed?.canonicalPort === true && parsed.port === 443;
  });
  let endpoint: ReturnType<typeof httpsEndpoint>;
  try {
    endpoint = httpsEndpoint(status);
  } catch {
    if (canonicalListeners.some(([, listener]) => listener.Funnel === true)) {
      return { kind: "funnel_conflict" };
    }
    return { kind: "unrelated_conflict" };
  }
  const handler = endpoint.handlers[AIDEN_TAILSCALE_PATH];
  if (endpoint.funnel) return { kind: "funnel_conflict" };
  if (handler && status.TCP?.["443"]?.HTTPS !== true) {
    return { kind: "unrelated_conflict" };
  }
  if (
    handler?.Proxy === target
    && ownership?.path === AIDEN_TAILSCALE_PATH
    && ownership.target === target
  ) {
    return { kind: "owned", target };
  }
  if (!handler) return { kind: "available" };
  if (isAidenLoopbackTarget(handler.Proxy)) {
    return { kind: "other_aiden", target: handler.Proxy };
  }
  return { kind: "unrelated_conflict" };
}

export function aidenTailscaleCanonicalLoopbackPort(
  status: AidenTailscaleStatus,
): number | undefined {
  return aidenTailscaleCanonicalLoopbackTargets(status)[0]?.port;
}

export function aidenTailscaleCanonicalHandlerTarget(
  status: AidenTailscaleStatus,
): string | undefined {
  return httpsEndpoint(status).handlers[AIDEN_TAILSCALE_PATH]?.Proxy;
}

export function aidenTailscaleCanonicalLoopbackTargets(
  status: AidenTailscaleStatus,
): Array<{ target: string; port: number }> {
  const targets: Array<{ target: string; port: number }> = [];
  for (const listener of Object.values(status.Web ?? {})) {
    const target = listener.Handlers?.[AIDEN_TAILSCALE_PATH]?.Proxy;
    if (!target) continue;
    const match = CANONICAL_LOOPBACK_HTTP_TARGET.exec(target)
      ?? LEGACY_LOOPBACK_HTTP_ORIGIN.exec(target);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port > 65_535) continue;
    if (!targets.some((value) => value.target === target)) targets.push({ target, port });
  }
  return targets;
}

export function planAidenTailscaleConnect(
  status: AidenTailscaleStatus,
  target: string,
  ownership?: AidenTailscaleOwnership,
  nodeHttpsAvailable = false,
): { action: "set" | "noop"; args?: string[]; ownership: AidenTailscaleOwnership } {
  assertHttpsCapability(status, nodeHttpsAvailable);
  assertServerOwnedLoopbackTarget(target);
  const classification = classifyAidenTailscaleRoute(status, target, ownership);
  const nextOwnership = { path: AIDEN_TAILSCALE_PATH, target } as const;
  if (classification.kind === "available") return { action: "set", args: ["serve", "--https=443", `--set-path=${AIDEN_TAILSCALE_PATH}`, target], ownership: nextOwnership };
  if (classification.kind === "owned") return { action: "noop", ownership: nextOwnership };
  if (classification.kind === "funnel_conflict") throw new Error("tailscale_funnel_conflict");
  throw new Error("tailscale_route_conflict");
}

export function planAidenTailscaleDisconnect(status: AidenTailscaleStatus, target: string, ownership?: AidenTailscaleOwnership): { action: "clear" | "noop"; args?: string[] } {
  // Origin-only targets were persisted by pre-acceptance builds. They may be
  // recognized only for exact owned cleanup, never for a new connection.
  assertServerOwnedLoopbackTarget(target, true);
  const endpoint = httpsEndpoint(status);
  if (endpoint.funnel) throw new Error("tailscale_funnel_conflict");
  const handler = endpoint.handlers[AIDEN_TAILSCALE_PATH];
  if (!handler) return { action: "noop" };
  if (handler.Proxy !== target || ownership?.path !== AIDEN_TAILSCALE_PATH || ownership.target !== target) throw new Error("tailscale_route_conflict");
  return { action: "clear", args: ["serve", "--https=443", `--set-path=${AIDEN_TAILSCALE_PATH}`, "off"] };
}
