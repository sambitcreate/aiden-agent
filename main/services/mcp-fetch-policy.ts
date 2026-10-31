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

/** Most same-origin redirects an OAuth metadata GET follows. */
const MAX_METADATA_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A network failure as a `TypeError` (Pi's discovery treats `TypeError` as a
 * network failure and reports it rather than falling back) whose message
 * names the host and the real cause instead of undici's bare "fetch failed".
 */
function networkFailure(url: URL, error: TypeError): TypeError {
  const cause = (error as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code : undefined;
  const detail = cause instanceof Error && cause.message ? cause.message : error.message;
  const reason = /redirect/iu.test(detail)
    ? "it answered with a redirect, which Aiden does not follow for sign-in requests"
    : code ? `${code}${detail && !detail.includes(code) ? ` (${detail})` : ""}` : detail || "network error";
  const failure = new TypeError(`Could not reach ${url.host}: ${reason}.`);
  Object.defineProperty(failure, "cause", { value: error, configurable: true, writable: true });
  return failure;
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

/**
 * A completed rotation is replayed to late callers still holding the old
 * refresh token, until the refresh token it issued is itself presented.
 */
const REFRESH_REPLAY_MS = 30_000;
const refreshFlights = new Map<string, RefreshFlight>();
/** Digest of (token endpoint, issued refresh token) -> key of the completed flight that issued it. */
const refreshIssuers = new Map<string, string>();

function issuedTokenKey(url: URL, refreshToken: string): string {
  return createHash("sha256").update(url.href).update("\0").update(refreshToken).digest("hex");
}

function issuedRefreshToken(snapshot: SharedTokenResponse): string | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(snapshot.body));
    const token = value && typeof value === "object" ? (value as { refresh_token?: unknown }).refresh_token : undefined;
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Presenting a refresh token consumes it: the completed response that issued
 * it must no longer be replayed, or a caller still holding the older token
 * would receive (and the SDK would persist) credentials already rotated away.
 */
function retireIssuerOf(url: URL, presented: string | null): void {
  if (!presented) return;
  const issued = issuedTokenKey(url, presented);
  const issuerKey = refreshIssuers.get(issued);
  if (issuerKey === undefined) return;
  refreshIssuers.delete(issued);
  if (refreshFlights.get(issuerKey)?.settled) refreshFlights.delete(issuerKey);
}

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
  exchange: { url: URL; presented: string | null },
  run: (signal: AbortSignal) => Promise<Response>,
  callerSignal: AbortSignal,
): Promise<Response> {
  callerSignal.throwIfAborted();
  retireIssuerOf(exchange.url, exchange.presented);
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
        retireIssuerOf(exchange.url, exchange.presented);
        const issued = issuedRefreshToken(snapshot);
        // A non-rotating server re-issues the presented token; nothing was consumed.
        const issuedKey = issued && issued !== exchange.presented ? issuedTokenKey(exchange.url, issued) : undefined;
        if (issuedKey && refreshFlights.get(key) === created) refreshIssuers.set(issuedKey, key);
        setTimeout(() => {
          if (refreshFlights.get(key) === created) refreshFlights.delete(key);
          if (issuedKey && refreshIssuers.get(issuedKey) === key) refreshIssuers.delete(issuedKey);
        }, REFRESH_REPLAY_MS).unref?.();
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
    // MCP calls already have client request deadlines; SSE streams may stay
    // idle indefinitely. OAuth metadata/registration/token requests do not.
    const acceptsSse = (requestHeaders.get("accept") ?? "").includes("text/event-stream");
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const contentType = (requestHeaders.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    // Metadata GETs also carry MCP-Protocol-Version. Initialize sends a
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
    // Network failures carry their real cause (still as a TypeError, which
    // transports and discovery read as "network"). Only OAuth metadata GETs
    // follow redirects, and only same-origin ones, without credentials.
    const followsRedirects = !mcpRequest && method === "GET";
    const send = async (target: Parameters<typeof fetch>[0], sendHeaders: Headers): Promise<Response> => {
      try {
        return await fetchImpl(target, { ...init, headers: sendHeaders, signal, redirect: followsRedirects ? "manual" : "error" });
      } catch (error) {
        if (signal.aborted || !(error instanceof TypeError)) throw error;
        throw networkFailure(new URL(target instanceof Request ? target.url : String(target)), error);
      }
    };
    try {
      assertCurrent();
      let response = await send(input, headers);
      let location = url;
      for (let hops = 0; followsRedirects && REDIRECT_STATUSES.has(response.status); hops += 1) {
        const target = response.headers.get("location");
        void response.body?.cancel().catch(() => undefined);
        assertCurrent();
        if (!target) throw new TypeError(`OAuth metadata at ${location.host} answered with a redirect without a destination.`);
        const next = new URL(target, location);
        if (next.origin !== location.origin) {
          // Not followed. To discovery this is a miss at that URL ("not
          // here"), so it tries the next candidate instead of failing.
          response = new Response(null, { status: 404, statusText: `Redirect to another origin (${next.origin}) not followed` });
          break;
        }
        if (hops >= MAX_METADATA_REDIRECTS) throw new TypeError(`OAuth metadata at ${url.host} redirected more than ${MAX_METADATA_REDIRECTS} times.`);
        // Redirect hops carry the request's own headers, never configured
        // service headers or an Authorization header.
        const hopHeaders = new Headers(requestHeaders);
        hopHeaders.delete("authorization");
        hopHeaders.delete("cookie");
        location = next;
        response = await send(next, hopHeaders);
      }
      assertCurrent();
      // OAuth consumes JSON regardless of a server's advertised MIME type.
      // Only successful MCP SSE responses get a per-frame (not total) budget.
      const sse = acceptsSse && response.ok && (response.headers.get("content-type") ?? "")
        .split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
      const declared = response.headers.get("content-length");
      if (!sse && declared !== null &&
          (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
        void response.body?.cancel(OVERSIZED).catch(() => undefined);
        throw new Error(OVERSIZED);
      }
      const challenge = response.headers.get("www-authenticate");
      // A server may take JSON-RPC at another path of its origin, so any
      // MCP request to the server's origin counts.
      if (response.status === 403 && challenge && mcpRequest && url.origin === service.origin &&
          challengeParameter(challenge, "error") === "insufficient_scope") {
        const scope = challengeParameter(challenge, "scope");
        if (scope) recordMcpStepUpScope(options.serviceUrl, scope);
      }
      if (!response.body) {
        cleanup();
        return response;
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
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
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
    const body = String(init?.body ?? "");
    const key = refreshFlightKey(url, body, headers);
    const presented = new URLSearchParams(body).get("refresh_token");
    // The shared request belongs to no single caller: it carries only its own
    // deadline and the cancellation of every waiter, and each caller re-checks
    // its own currency before using the result.
    const response = await coalesceRefresh(key, { url, presented }, (signal) => policyFetch(input, init, { signal, caller: false }), callerSignal);
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
