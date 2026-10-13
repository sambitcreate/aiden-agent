import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpFetchPolicy, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";
import { observeSseReauthentication } from "./mcp-sse-auth-lifecycle.js";
import { withMcpOAuthMetadataObservation } from "./mcp-oauth-metadata.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

const MAX_CANCELLED_REQUEST_IDS = 256;

/** The id of a single JSON-RPC request body (not a notification or response). */
function jsonRpcRequestId(init: RequestInit | undefined): string | number | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "POST" || typeof init?.body !== "string") return undefined;
  try {
    const message: unknown = JSON.parse(init.body);
    if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
    const { id, method } = message as { id?: unknown; method?: unknown };
    return typeof method === "string" && (typeof id === "string" || typeof id === "number") ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Shared by attended sign-in, stored-token connections, and isolated children. */
export function createMcpRemoteTransport(
  options: McpFetchPolicyOptions & {
    transport: "http" | "sse";
    authProvider?: OAuthClientProvider & { observeAuthorizationMetadata?: (url: URL, document: unknown) => void };
    onTerminalFailure?: () => void;
  },
) {
  let lifetime = new AbortController();
  // Request ids this client has cancelled. The SDK re-sends a POST after an
  // auth refresh (401 or 403 insufficient_scope) without consulting the
  // request's own cancellation, so a timed-out or aborted tools/call would
  // otherwise still reach the server and run.
  const cancelled = new Set<string | number>();
  const policyFetch: typeof globalThis.fetch = (input, init) => createMcpFetchPolicy({
    ...options,
    signal: options.signal
      ? AbortSignal.any([lifetime.signal, options.signal])
      : lifetime.signal,
  })(input, init);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const id = cancelled.size > 0 ? jsonRpcRequestId(init) : undefined;
    if (id !== undefined && cancelled.has(id)) {
      throw new DOMException("The MCP request was cancelled before it could be re-sent.", "AbortError");
    }
    return policyFetch(input, init);
  };
  const observer = options.authProvider?.observeAuthorizationMetadata;
  const transportOptions = {
    fetch: observer ? withMcpOAuthMetadataObservation(fetch, observer.bind(options.authProvider)) : fetch,
    authProvider: options.authProvider,
  };
  const transport = options.transport === "sse"
    ? new SSEClientTransport(new URL(options.serviceUrl), transportOptions)
    : new StreamableHTTPClientTransport(new URL(options.serviceUrl), transportOptions);
  const send = transport.send.bind(transport) as (message: JSONRPCMessage, options?: TransportSendOptions) => Promise<void>;
  transport.send = async (message: JSONRPCMessage, sendOptions?: TransportSendOptions) => {
    if ("method" in message && message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        cancelled.add(requestId);
        if (cancelled.size > MAX_CANCELLED_REQUEST_IDS) cancelled.delete(cancelled.values().next().value!);
      }
    }
    return send(message, sendOptions);
  };
  const close = transport.close.bind(transport);
  let terminalClose: ReturnType<typeof setImmediate> | undefined;
  transport.close = async () => {
    if (terminalClose) clearImmediate(terminalClose);
    terminalClose = undefined;
    lifetime.abort(new Error("MCP connection closed."));
    await close();
  };
  const retireTerminalConnection = () => {
    if (terminalClose || lifetime.signal.aborted) return;
    options.onTerminalFailure?.();
    // Release cache ownership now; close after SDK error/reconnect callbacks
    // settle so they cannot install a retry timer after our teardown.
    terminalClose = setImmediate(() => {
      terminalClose = undefined;
      void transport.close().catch(() => undefined);
    });
  };
  transport.onerror = (error) => {
    // In the pinned SDK/EventSource, SSE response failures have an HTTP code
    // and stop reconnecting; EOF/network errors have no code and reconnect.
    // HTTP 404 only proves session loss when a session was established. Other
    // POST errors and optional GET-stream failures can leave the client usable.
    const terminal = transport instanceof SSEClientTransport
      ? error instanceof SseError && typeof error.code === "number"
      : error instanceof StreamableHTTPError && error.code === 404 &&
        transport.sessionId !== undefined;
    if (terminal) retireTerminalConnection();
  };
  if (transport instanceof SSEClientTransport && options.authProvider) {
    observeSseReauthentication(transport, retireTerminalConnection);
  }
  // Client.connect closes HTTP transports when OAuth opens the browser. The
  // SDK deliberately supports finishAuth on that same object afterward so it
  // retains discovered resource metadata. Exchange is a new network phase,
  // still fenced by the original owner signal and generation predicate.
  const finishAuth = transport.finishAuth.bind(transport);
  transport.finishAuth = async (code) => {
    if (lifetime.signal.aborted) lifetime = new AbortController();
    await finishAuth(code);
  };
  return transport;
}
