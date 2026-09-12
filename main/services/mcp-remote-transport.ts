import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpFetchPolicy, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";

/** Shared by attended sign-in, stored-token connections, and isolated children. */
export function createMcpRemoteTransport(
  options: McpFetchPolicyOptions & {
    transport: "http" | "sse";
    authProvider?: OAuthClientProvider;
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
  transport.close = async () => {
    lifetime.abort(new Error("MCP connection closed."));
    await close();
  };
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
