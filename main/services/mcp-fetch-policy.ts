export const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MCP_OAUTH_REQUEST_TIMEOUT_MS = 30_000;

const OVERSIZED = "MCP response exceeded the transport limit.";
const TIMED_OUT = "MCP authorization request timed out. Try connecting again.";

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
  const service = new URL(options.serviceUrl);
  const configuredHeaders = new Headers(options.serviceHeaders);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maximumBytes = options.maximumBytes ?? MAX_MCP_RESPONSE_BYTES;
  const timeoutMs = options.oauthTimeoutMs ?? MCP_OAUTH_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Invalid MCP transport policy.");
  }
  return async (input, init) => {
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
    // Metadata GETs also carry MCP-Protocol-Version. Registration is JSON but
    // has no protocol header; token requests are form POSTs, even on /mcp.
    const mcpRequest = acceptsSse || (method === "POST" && contentType === "application/json" &&
      requestHeaders.has("mcp-protocol-version"));
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      ...(init?.signal ? [init.signal] : request ? [request.signal] : []),
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
      if (options.isCurrent && !options.isCurrent()) {
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
}
