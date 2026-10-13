import { createHash } from "node:crypto";
import { recordMcpStepUpScope } from "./mcp-oauth-session.js";

export const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MCP_OAUTH_REQUEST_TIMEOUT_MS = 30_000;

const OVERSIZED = "MCP response exceeded the transport limit.";
const TIMED_OUT = "MCP authorization request timed out. Try connecting again.";

function isJsonRpcBody(body: BodyInit | null | undefined): boolean {
  if (typeof body !== "string") return false;
  try {
    const value: unknown = JSON.parse(body);
    const isMessage = (entry: unknown) => entry !== null && typeof entry === "object" &&
      (entry as { jsonrpc?: unknown }).jsonrpc === "2.0";
    return Array.isArray(value) ? value.length > 0 && value.every(isMessage) : isMessage(value);
  } catch {
    return false;
  }
}

/** Pi 1.0 accepts absent optional token values some OAuth servers encode as null or empty strings. */
async function normalizeOAuthTokenResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OAuth token response.");
  const tokens = value as Record<string, unknown>;
  if (typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.token_type !== "string" || !tokens.token_type) throw new Error("OAuth token response is missing required credentials.");
  for (const key of ["scope", "refresh_token", "id_token", "expires_in"]) {
    if (tokens[key] === null || tokens[key] === "") delete tokens[key];
  }
  if (tokens.expires_in !== undefined) {
    if ((typeof tokens.expires_in !== "string" && typeof tokens.expires_in !== "number") || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) < 0) throw new Error("Invalid OAuth token lifetime.");
    tokens.expires_in = Number(tokens.expires_in);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  return new Response(JSON.stringify(tokens), { status: response.status, statusText: response.statusText, headers });
}

/**
 * Dynamic client registration responses and authorization-server metadata
 * from some providers encode absent optional members as `null` or `""`, which
 * the SDK's schemas reject (or, for URL fields, treat as invalid). Drop those
 * optional members; required members stay untouched so they still fail closed.
 */
const OAUTH_REGISTRATION_REQUIRED = new Set(["client_id", "redirect_uris"]);
const OAUTH_METADATA_REQUIRED = new Set(["issuer", "authorization_endpoint", "token_endpoint", "response_types_supported"]);
const OAUTH_METADATA_PATH = /\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(?:\/|$)/u;

async function normalizeOptionalOAuthFields(response: Response, required: ReadonlySet<string>): Promise<Response> {
  if (!response.ok) return response;
  const text = await response.text();
  const rebuild = (body: string) => {
    const headers = new Headers(response.headers);
    headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return rebuild(text); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return rebuild(text);
  const document = value as Record<string, unknown>;
  for (const [key, member] of Object.entries(document)) {
    if (!required.has(key) && (member === null || member === "")) delete document[key];
  }
  return rebuild(JSON.stringify(document));
}

/**
 * SDK 1.30 reads `scope=""` in a challenge as the two-character scope `""`
 * (and `scope=" "` as whitespace), which then wins over scopes_supported.
 * Remove empty scope parameters so discovery falls back as the spec intends.
 */
export function withoutEmptyChallengeScope(header: string): string {
  return header
    .replace(/(^|[\s,])scope=(?:"\s*"|'\s*'|(?=,|\s|$))\s*,?/giu, "$1")
    .replace(/[\s,]+$/u, "")
    .replace(/\s{2,}/gu, " ");
}

function challengeParameter(header: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s,])${name}=(?:"([^"]*)"|([^\\s,]+))`, "iu").exec(header);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** Snapshot of a token response shared by coalesced refresh callers. */
interface SharedTokenResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
}

interface RefreshFlight {
  promise: Promise<SharedTokenResponse>;
  waiters: number;
  controller: AbortController;
  settled: boolean;
}

/** A completed rotation is replayed to late callers still holding the old refresh token. */
const REFRESH_REPLAY_MS = 30_000;
const refreshFlights = new Map<string, RefreshFlight>();

function refreshFlightKey(url: URL, body: string, headers: Headers): string {
  return createHash("sha256")
    .update(url.href).update("\0")
    .update(body).update("\0")
    .update(headers.get("authorization") ?? "")
    .digest("hex");
}

function sharedResponse(snapshot: SharedTokenResponse): Response {
  return new Response(snapshot.body.slice(), { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Process-wide single flight for `grant_type=refresh_token` POSTs. Status
 * checks, chat, child-agent and Bot clients each own a transport but share one
 * stored refresh token; with rotating refresh tokens a second concurrent POST
 * gets `invalid_grant`, after which the SDK erases the tokens the first caller
 * just saved. Identical requests (same endpoint, body and client
 * authentication) share one network request; each caller gets its own
 * Response and stops waiting on its own cancellation. The shared request is
 * cancelled only when every waiter has left.
 */
function coalesceRefresh(
  key: string,
  run: (signal: AbortSignal) => Promise<Response>,
  callerSignal: AbortSignal,
): Promise<Response> {
  callerSignal.throwIfAborted();
  let flight = refreshFlights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const created: RefreshFlight = { waiters: 0, controller, settled: false, promise: undefined as unknown as Promise<SharedTokenResponse> };
    created.promise = (async () => {
      const response = await run(controller.signal);
      const body = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, statusText: response.statusText, headers: [...response.headers], body };
    })();
    created.promise.then(
      (snapshot) => {
        created.settled = true;
        if (snapshot.status < 200 || snapshot.status >= 300) {
          if (refreshFlights.get(key) === created) refreshFlights.delete(key);
          return;
        }
        setTimeout(() => { if (refreshFlights.get(key) === created) refreshFlights.delete(key); }, REFRESH_REPLAY_MS).unref?.();
      },
      () => {
        created.settled = true;
        if (refreshFlights.get(key) === created) refreshFlights.delete(key);
      },
    );
    refreshFlights.set(key, created);
    flight = created;
  }
  const joined = flight;
  joined.waiters += 1;
  return new Promise<Response>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      callerSignal.removeEventListener("abort", onAbort);
      joined.waiters -= 1;
    };
    const onAbort = () => {
      leave();
      if (joined.waiters === 0 && !joined.settled) {
        joined.controller.abort(abortError(callerSignal));
        if (refreshFlights.get(key) === joined) refreshFlights.delete(key);
      }
      reject(abortError(callerSignal));
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    joined.promise.then(
      (snapshot) => { if (left) return; leave(); resolve(sharedResponse(snapshot)); },
      (error: unknown) => { if (left) return; leave(); reject(error); },
    );
  });
}

/** Count SSE frames, not the lifetime of an intentionally long-lived stream. */
function frameCounter(maximumBytes: number) {
  let frameBytes = 0;
  let lineBytes = 0;
  let previousCR = false;
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      frameBytes += 1;
      if (frameBytes > maximumBytes) throw new Error(OVERSIZED);
      if (previousCR && byte === 10) {
        previousCR = false;
        continue;
      }
      previousCR = byte === 13;
      if (byte === 10 || byte === 13) {
        if (lineBytes === 0) frameBytes = 0;
        lineBytes = 0;
      } else {
        lineBytes += 1;
      }
    }
  };
}

export interface McpFetchPolicyOptions {
  serviceUrl: string;
  serviceHeaders?: Record<string, string>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  fetch?: typeof globalThis.fetch;
  maximumBytes?: number;
  oauthTimeoutMs?: number;
}

/**
 * Service credentials are not SDK-wide RequestInit defaults: OAuth discovery
 * may legitimately leave the service origin. SDK request headers win, including
 * its own Authorization header. Redirects cannot carry either set elsewhere.
 */
export function createMcpFetchPolicy(options: McpFetchPolicyOptions): typeof fetch {
  const configuredHeaders = new Headers(options.serviceHeaders);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maximumBytes = options.maximumBytes ?? MAX_MCP_RESPONSE_BYTES;
  const timeoutMs = options.oauthTimeoutMs ?? MCP_OAUTH_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Invalid MCP transport policy.");
  }
  const service = new URL(options.serviceUrl);
  const servicePath = `${service.origin}${service.pathname}`;
  const policyFetch = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    owner: { signal?: AbortSignal; isCurrent?: () => boolean; caller: boolean },
  ): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const requestHeaders = new Headers(init?.headers ?? request?.headers);
    const headers = new Headers(url.origin === service.origin ? configuredHeaders : undefined);
    requestHeaders.forEach((value, name) => headers.set(name, value));
    // MCP calls already have SDK request deadlines; SSE notifications may stay
    // idle indefinitely. OAuth metadata/registration/token requests do not.
    const acceptsSse = (requestHeaders.get("accept") ?? "").includes("text/event-stream");
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const contentType = (requestHeaders.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    // Metadata GETs also carry MCP-Protocol-Version. SSE initialize sends a
    // JSON-RPC body before that header is available, while OAuth registration
    // is JSON without a JSON-RPC envelope and token requests are form POSTs.
    const mcpRequest = acceptsSse || (method === "POST" && contentType === "application/json" &&
      (requestHeaders.has("mcp-protocol-version") || isJsonRpcBody(init?.body)));
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(owner.signal ? [owner.signal] : []),
      ...(owner.caller ? init?.signal ? [init.signal] : request ? [request.signal] : [] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      if (finished) return;
      cleanup();
      void reader?.cancel(signal.reason).catch(() => undefined);
      bodyController?.error(signal.reason);
    };
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (owner.isCurrent && !owner.isCurrent()) {
        throw new Error("MCP connection is no longer current.");
      }
    };
    if (!mcpRequest) timer = setTimeout(() => controller.abort(new Error(TIMED_OUT)), timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      assertCurrent();
      const response = await fetchImpl(input, { ...init, headers, signal, redirect: "error" });
      assertCurrent();
      // OAuth consumes JSON regardless of a server's advertised MIME type.
      // Only successful SDK SSE requests get a per-frame (not total) budget.
      const sse = acceptsSse && response.ok && (response.headers.get("content-type") ?? "")
        .split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
      const declared = response.headers.get("content-length");
      if (!sse && declared !== null &&
          (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
        void response.body?.cancel(OVERSIZED).catch(() => undefined);
        throw new Error(OVERSIZED);
      }
      let responseHeaders = response.headers;
      const challenge = response.headers.get("www-authenticate");
      if ((response.status === 401 || response.status === 403) && challenge) {
        if (response.status === 403 && `${url.origin}${url.pathname}` === servicePath &&
            challengeParameter(challenge, "error") === "insufficient_scope") {
          const scope = challengeParameter(challenge, "scope");
          if (scope) recordMcpStepUpScope(options.serviceUrl, scope);
        }
        const rewritten = withoutEmptyChallengeScope(challenge);
        if (rewritten !== challenge) {
          responseHeaders = new Headers(response.headers);
          responseHeaders.set("www-authenticate", rewritten);
        }
      }
      if (!response.body) {
        cleanup();
        return responseHeaders === response.headers ? response
          : new Response(null, { status: response.status, statusText: response.statusText, headers: responseHeaders });
      }
      reader = response.body.getReader();
      const checkFrame = frameCounter(maximumBytes);
      let observed = 0;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) { bodyController = streamController; },
        async pull(streamController) {
          try {
            assertCurrent();
            const next = await reader!.read();
            if (finished) return;
            assertCurrent();
            if (next.done) {
              cleanup();
              streamController.close();
              return;
            }
            if (sse) checkFrame(next.value);
            else {
              observed += next.value.byteLength;
              if (observed > maximumBytes) throw new Error(OVERSIZED);
            }
            streamController.enqueue(next.value);
          } catch (error) {
            if (finished) return;
            cleanup();
            void reader!.cancel(error).catch(() => undefined);
            streamController.error(error);
          }
        },
        cancel(reason) {
          cleanup();
          return reader!.cancel(reason);
        },
      });
      const boundedResponse = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
      const grant = formGrant(method, contentType, init?.body);
      if (grant === "authorization_code" || grant === "refresh_token") return await normalizeOAuthTokenResponse(boundedResponse);
      if (!mcpRequest && method === "GET" && OAUTH_METADATA_PATH.test(url.pathname)) {
        return await normalizeOptionalOAuthFields(boundedResponse, OAUTH_METADATA_REQUIRED);
      }
      if (!mcpRequest && method === "POST" && contentType === "application/json") {
        return await normalizeOptionalOAuthFields(boundedResponse, OAUTH_REGISTRATION_REQUIRED);
      }
      return boundedResponse;
    } catch (error) {
      cleanup();
      throw error;
    }
  };
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const contentType = (headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (formGrant(method, contentType, init?.body) !== "refresh_token") {
      return policyFetch(input, init, { signal: options.signal, isCurrent: options.isCurrent, caller: true });
    }
    const callerSignal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      ...(init?.signal ? [init.signal] : request ? [request.signal] : []),
    ]);
    if (options.isCurrent && !options.isCurrent()) throw new Error("MCP connection is no longer current.");
    const url = new URL(request?.url ?? String(input));
    const key = refreshFlightKey(url, String(init?.body ?? ""), headers);
    // The shared request belongs to no single caller: it carries only its own
    // deadline and the cancellation of every waiter, and each caller re-checks
    // its own currency before using the result.
    const response = await coalesceRefresh(key, (signal) => policyFetch(input, init, { signal, caller: false }), callerSignal);
    if (options.isCurrent && !options.isCurrent()) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("MCP connection is no longer current.");
    }
    return response;
  };
}

function formGrant(method: string, contentType: string, body: BodyInit | null | undefined): string | null {
  if (method !== "POST" || contentType !== "application/x-www-form-urlencoded") return null;
  return new URLSearchParams(typeof body === "string" || body instanceof URLSearchParams ? body : "").get("grant_type");
}
