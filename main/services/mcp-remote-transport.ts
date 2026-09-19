import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpFetchPolicy, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";
import { observeSseReauthentication } from "./mcp-sse-auth-lifecycle.js";

/** Shared by attended sign-in, stored-token connections, and isolated children. */
export function createMcpRemoteTransport(
  options: McpFetchPolicyOptions & {
    transport: "http" | "sse";
    authProvider?: OAuthClientProvider;
    onTerminalFailure?: () => void;
  },
) {
  let lifetime = new AbortController();
  const fetch: typeof globalThis.fetch = (input, init) => createMcpFetchPolicy({
    ...options,
    signal: options.signal
      ? AbortSignal.any([lifetime.signal, options.signal])
      : lifetime.signal,
  })(input, init);
  const transportOptions = { fetch, authProvider: options.authProvider };
  const transport = options.transport === "sse"
    ? new SSEClientTransport(new URL(options.serviceUrl), transportOptions)
    : new StreamableHTTPClientTransport(new URL(options.serviceUrl), transportOptions);
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
