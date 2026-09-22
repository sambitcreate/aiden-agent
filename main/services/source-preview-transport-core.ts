import { createHash } from "node:crypto";

export const SOURCE_PREVIEW_TRANSPORT_VERSION = 1 as const;
export const SOURCE_PREVIEW_MAX_PATH_RULES = 32;
export const SOURCE_PREVIEW_MAX_QUERY_KEYS = 32;

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u;
const SAFE_QUERY_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_PROTOCOL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LOOPBACK_HOST = "127.0.0.1";
const SENSITIVE_HEADER =
  /(?:^|[-_])(?:authorization|cookie|credentials?|secret|token|api[-_]?key)(?:$|[-_])/iu;
const HTTP_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "pragma",
  "range",
  "user-agent",
]);
const WEBSOCKET_HEADER_ALLOWLIST = new Set([
  "connection",
  "host",
  "origin",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
  "user-agent",
]);
const PROOF_INPUT_KEYS = new Set([
  "version",
  "sessionId",
  "targetOrigin",
  "resolvedAddresses",
  "allowedHttpPathPrefixes",
  "allowedWebSocketPathPrefixes",
  "allowedHttpQueryKeys",
  "allowedWebSocketQueryParameters",
  "allowedWebSocketProtocols",
]);

const issuedProofs = new WeakSet<object>();

export interface SourcePreviewTransportProofV1 {
  readonly version: typeof SOURCE_PREVIEW_TRANSPORT_VERSION;
  readonly proofId: string;
  readonly sessionId: string;
  readonly httpOrigin: string;
  readonly webSocketOrigin: string;
  readonly port: number;
  readonly allowedHttpPathPrefixes: readonly string[];
  readonly allowedWebSocketPathPrefixes: readonly string[];
  readonly allowedHttpQueryKeys: readonly string[];
  readonly webSocketQueryValueHashes: Readonly<Record<string, string>>;
  readonly allowedWebSocketProtocols: readonly string[];
}

export interface SourcePreviewProofInputV1 {
  version: typeof SOURCE_PREVIEW_TRANSPORT_VERSION;
  sessionId: string;
  targetOrigin: string;
  resolvedAddresses: string[];
  allowedHttpPathPrefixes: string[];
  allowedWebSocketPathPrefixes: string[];
  allowedHttpQueryKeys: string[];
  allowedWebSocketQueryParameters: Record<string, string>;
  allowedWebSocketProtocols: string[];
}

export type SourcePreviewTransportDenial =
  | "unproven-authority"
  | "invalid-proof-input"
  | "invalid-url"
  | "non-loopback-target"
  | "origin-drift"
  | "port-drift"
  | "hostname-rebinding"
  | "credentials-forbidden"
  | "method-forbidden"
  | "path-unproven"
  | "query-unproven"
  | "header-forbidden"
  | "redirect-forbidden"
  | "websocket-protocol-forbidden"
  | "websocket-upgrade-invalid";

export type SourcePreviewTransportDecision =
  | { allowed: true; normalizedUrl: string }
  | { allowed: false; reason: SourcePreviewTransportDenial };

function deny(reason: SourcePreviewTransportDenial): SourcePreviewTransportDecision {
  return { allowed: false, reason };
}

function exactLoopbackResolution(addresses: readonly string[]): boolean {
  return Array.isArray(addresses) && addresses.length === 1 && addresses[0] === LOOPBACK_HOST;
}

function parseUrl(value: string): URL | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function safePathPrefix(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%")
  ) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(value);
    return !decoded.split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

function uniqueBounded(values: readonly string[], maximum: number): boolean {
  return values.length <= maximum && new Set(values).size === values.length;
}

function exactPort(url: URL): number | undefined {
  if (!url.port) return undefined;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

export function issueSourcePreviewTransportProof(
  value: unknown,
): SourcePreviewTransportProofV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every((key) => PROOF_INPUT_KEYS.has(key))) return undefined;
  if (
    !Array.isArray(raw.resolvedAddresses) ||
    !raw.resolvedAddresses.every((entry) => typeof entry === "string") ||
    !Array.isArray(raw.allowedHttpPathPrefixes) ||
    !raw.allowedHttpPathPrefixes.every((entry) => typeof entry === "string") ||
    !Array.isArray(raw.allowedWebSocketPathPrefixes) ||
    !raw.allowedWebSocketPathPrefixes.every((entry) => typeof entry === "string") ||
    !Array.isArray(raw.allowedHttpQueryKeys) ||
    !raw.allowedHttpQueryKeys.every((entry) => typeof entry === "string") ||
    !raw.allowedWebSocketQueryParameters ||
    typeof raw.allowedWebSocketQueryParameters !== "object" ||
    Array.isArray(raw.allowedWebSocketQueryParameters) ||
    !Array.isArray(raw.allowedWebSocketProtocols) ||
    !raw.allowedWebSocketProtocols.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  const input = raw as unknown as SourcePreviewProofInputV1;
  const origin = parseUrl(input.targetOrigin);
  if (
    input.version !== SOURCE_PREVIEW_TRANSPORT_VERSION ||
    !SAFE_SESSION_ID.test(input.sessionId) ||
    !origin ||
    origin.protocol !== "http:" ||
    origin.hostname !== LOOPBACK_HOST ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    !exactLoopbackResolution(input.resolvedAddresses)
  ) {
    return undefined;
  }
  const port = exactPort(origin);
  if (!port) return undefined;
  if (
    !uniqueBounded(input.allowedHttpPathPrefixes, SOURCE_PREVIEW_MAX_PATH_RULES) ||
    input.allowedHttpPathPrefixes.length < 1 ||
    !input.allowedHttpPathPrefixes.every(safePathPrefix) ||
    !uniqueBounded(input.allowedWebSocketPathPrefixes, SOURCE_PREVIEW_MAX_PATH_RULES) ||
    input.allowedWebSocketPathPrefixes.length < 1 ||
    !input.allowedWebSocketPathPrefixes.every(safePathPrefix) ||
    !uniqueBounded(input.allowedHttpQueryKeys, SOURCE_PREVIEW_MAX_QUERY_KEYS) ||
    !input.allowedHttpQueryKeys.every(
      (key) => SAFE_QUERY_KEY.test(key) && !SENSITIVE_HEADER.test(key),
    ) ||
    Object.keys(input.allowedWebSocketQueryParameters).length > SOURCE_PREVIEW_MAX_QUERY_KEYS ||
    !Object.entries(input.allowedWebSocketQueryParameters).every(
      ([key, parameter]) =>
        SAFE_QUERY_KEY.test(key) &&
        typeof parameter === "string" &&
        parameter.length <= 1_024 &&
        !/[\r\n\0]/u.test(parameter),
    ) ||
    !uniqueBounded(input.allowedWebSocketProtocols, 16) ||
    !input.allowedWebSocketProtocols.every(
      (protocol) => SAFE_PROTOCOL.test(protocol) && protocol === protocol.toLowerCase(),
    )
  ) {
    return undefined;
  }
  const httpOrigin = `http://${LOOPBACK_HOST}:${port}`;
  const webSocketOrigin = `ws://${LOOPBACK_HOST}:${port}`;
  const webSocketQueryValueHashes = Object.fromEntries(
    Object.entries(input.allowedWebSocketQueryParameters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, parameter]) => [
        key,
        createHash("sha256").update(parameter, "utf8").digest("hex"),
      ]),
  );
  const proofMaterial = JSON.stringify({
    version: SOURCE_PREVIEW_TRANSPORT_VERSION,
    sessionId: input.sessionId,
    httpOrigin,
    webSocketOrigin,
    allowedHttpPathPrefixes: input.allowedHttpPathPrefixes,
    allowedWebSocketPathPrefixes: input.allowedWebSocketPathPrefixes,
    allowedHttpQueryKeys: input.allowedHttpQueryKeys,
    webSocketQueryValueHashes,
    allowedWebSocketProtocols: input.allowedWebSocketProtocols,
  });
  const proof: SourcePreviewTransportProofV1 = Object.freeze({
    version: SOURCE_PREVIEW_TRANSPORT_VERSION,
    proofId: createHash("sha256").update(proofMaterial, "utf8").digest("hex"),
    sessionId: input.sessionId,
    httpOrigin,
    webSocketOrigin,
    port,
    allowedHttpPathPrefixes: Object.freeze([...input.allowedHttpPathPrefixes]),
    allowedWebSocketPathPrefixes: Object.freeze([...input.allowedWebSocketPathPrefixes]),
    allowedHttpQueryKeys: Object.freeze([...input.allowedHttpQueryKeys]),
    webSocketQueryValueHashes: Object.freeze(webSocketQueryValueHashes),
    allowedWebSocketProtocols: Object.freeze([...input.allowedWebSocketProtocols]),
  });
  issuedProofs.add(proof);
  return proof;
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>>,
  allowlist: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !/^[a-z0-9-]{1,80}$/u.test(name) ||
      typeof value !== "string" ||
      value.length > 4_096 ||
      /[\r\n\0]/u.test(value) ||
      SENSITIVE_HEADER.test(name) ||
      !allowlist.has(name)
    ) {
      return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, name)) return undefined;
    normalized[name] = value;
  }
  return normalized;
}

function pathMatches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      prefix === "/" ||
      pathname === prefix ||
      pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

function validateTarget(input: {
  proof: SourcePreviewTransportProofV1;
  targetUrl: string;
  expectedProtocol: "http:" | "ws:";
  resolvedAddresses: readonly string[];
  pathPrefixes: readonly string[];
  queryKeys: readonly string[];
  queryValueHashes?: Readonly<Record<string, string>>;
}): SourcePreviewTransportDecision {
  if (!issuedProofs.has(input.proof)) return deny("unproven-authority");
  const target = parseUrl(input.targetUrl);
  if (!target || target.protocol !== input.expectedProtocol) return deny("invalid-url");
  if (target.username !== "" || target.password !== "") return deny("credentials-forbidden");
  if (target.hostname !== LOOPBACK_HOST) return deny("non-loopback-target");
  if (!exactLoopbackResolution(input.resolvedAddresses)) return deny("hostname-rebinding");
  const port = exactPort(target);
  if (!port || port !== input.proof.port) return deny("port-drift");
  const expectedOrigin =
    input.expectedProtocol === "http:" ? input.proof.httpOrigin : input.proof.webSocketOrigin;
  if (target.origin !== expectedOrigin) return deny("origin-drift");
  if (target.hash !== "") return deny("path-unproven");
  if (/%(?:2f|5c|00)/iu.test(target.pathname) || target.pathname.includes("\\")) {
    return deny("path-unproven");
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(target.pathname);
  } catch {
    return deny("path-unproven");
  }
  if (!pathMatches(decodedPath, input.pathPrefixes)) return deny("path-unproven");
  const allowedQueryKeys = new Set(input.queryKeys);
  if (
    target.searchParams.size > SOURCE_PREVIEW_MAX_QUERY_KEYS ||
    [...target.searchParams].some(
      ([key, value]) =>
        !allowedQueryKeys.has(key) ||
        value.length > 1_024 ||
        /[\r\n\0]/u.test(value) ||
        (input.queryValueHashes !== undefined &&
          (!SHA256.test(input.queryValueHashes[key] ?? "") ||
            createHash("sha256").update(value, "utf8").digest("hex") !==
              input.queryValueHashes[key])),
    )
  ) {
    return deny("query-unproven");
  }
  return { allowed: true, normalizedUrl: target.toString() };
}

export function authorizeSourcePreviewHttpRequest(input: {
  proof: SourcePreviewTransportProofV1;
  targetUrl: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  credentialsMode: "omit" | "same-origin" | "include";
  resolvedAddresses: readonly string[];
}): SourcePreviewTransportDecision {
  if (!input.proof || !issuedProofs.has(input.proof)) return deny("unproven-authority");
  if (input.credentialsMode !== "omit") return deny("credentials-forbidden");
  if (input.method !== "GET" && input.method !== "HEAD") return deny("method-forbidden");
  if (!normalizeHeaders(input.headers, HTTP_HEADER_ALLOWLIST)) return deny("header-forbidden");
  return validateTarget({
    proof: input.proof,
    targetUrl: input.targetUrl,
    expectedProtocol: "http:",
    resolvedAddresses: input.resolvedAddresses,
    pathPrefixes: input.proof.allowedHttpPathPrefixes,
    queryKeys: input.proof.allowedHttpQueryKeys,
  });
}

export function authorizeSourcePreviewHttpRedirect(input: {
  proof: SourcePreviewTransportProofV1;
  fromUrl: string;
  targetUrl: string;
  status: number;
  method: "GET" | "HEAD";
  headers: Readonly<Record<string, string>>;
  credentialsMode: "omit" | "same-origin" | "include";
  fromResolvedAddresses: readonly string[];
  targetResolvedAddresses: readonly string[];
}): SourcePreviewTransportDecision {
  if (![301, 302, 303, 307, 308].includes(input.status)) return deny("redirect-forbidden");
  const from = authorizeSourcePreviewHttpRequest({
    proof: input.proof,
    targetUrl: input.fromUrl,
    method: input.method,
    headers: input.headers,
    credentialsMode: input.credentialsMode,
    resolvedAddresses: input.fromResolvedAddresses,
  });
  if (!from.allowed) return from;
  return authorizeSourcePreviewHttpRequest({
    proof: input.proof,
    targetUrl: input.targetUrl,
    method: input.status === 303 ? "GET" : input.method,
    headers: input.headers,
    credentialsMode: input.credentialsMode,
    resolvedAddresses: input.targetResolvedAddresses,
  });
}

export function authorizeSourcePreviewWebSocketTarget(input: {
  proof: SourcePreviewTransportProofV1;
  targetUrl: string;
  protocols: readonly string[];
  resolvedAddresses: readonly string[];
}): SourcePreviewTransportDecision {
  if (!input.proof || !issuedProofs.has(input.proof)) return deny("unproven-authority");
  if (
    !Array.isArray(input.protocols) ||
    input.protocols.length > 16 ||
    input.protocols.some((protocol) => !input.proof.allowedWebSocketProtocols.includes(protocol))
  ) {
    return deny("websocket-protocol-forbidden");
  }
  return validateTarget({
    proof: input.proof,
    targetUrl: input.targetUrl,
    expectedProtocol: "ws:",
    resolvedAddresses: input.resolvedAddresses,
    pathPrefixes: input.proof.allowedWebSocketPathPrefixes,
    queryKeys: Object.keys(input.proof.webSocketQueryValueHashes),
    queryValueHashes: input.proof.webSocketQueryValueHashes,
  });
}

function commaTokens(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function authorizeSourcePreviewWebSocketUpgrade(input: {
  proof: SourcePreviewTransportProofV1;
  targetUrl: string;
  protocols: readonly string[];
  headers: Readonly<Record<string, string>>;
  resolvedAddresses: readonly string[];
}): SourcePreviewTransportDecision {
  const target = authorizeSourcePreviewWebSocketTarget({
    proof: input.proof,
    targetUrl: input.targetUrl,
    protocols: input.protocols,
    resolvedAddresses: input.resolvedAddresses,
  });
  if (!target.allowed) return target;
  const headers = normalizeHeaders(input.headers, WEBSOCKET_HEADER_ALLOWLIST);
  if (!headers) return deny("header-forbidden");
  const expectedHost = `${LOOPBACK_HOST}:${input.proof.port}`;
  if (
    headers.host !== expectedHost ||
    headers.origin !== input.proof.httpOrigin ||
    headers.upgrade?.toLowerCase() !== "websocket" ||
    !commaTokens(headers.connection).includes("upgrade") ||
    headers["sec-websocket-version"] !== "13" ||
    !headers["sec-websocket-key"]
  ) {
    return deny("websocket-upgrade-invalid");
  }
  const headerProtocols = commaTokens(headers["sec-websocket-protocol"]);
  if (
    headerProtocols.length !== input.protocols.length ||
    headerProtocols.some((protocol, index) => protocol !== input.protocols[index]?.toLowerCase())
  ) {
    return deny("websocket-protocol-forbidden");
  }
  return target;
}
