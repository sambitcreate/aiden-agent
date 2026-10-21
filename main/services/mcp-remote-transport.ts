import {
  McpSessionExpiredError,
  StreamableHttpTransport,
  type JsonRpcMessage,
  type McpTransportSendOptions,
} from "@earendil-works/pi-mcp";
import { adaptOAuthProvider, type OAuthClientProvider } from "@earendil-works/pi-mcp/oauth";
import { createMcpFetchPolicy, MAX_MCP_RESPONSE_BYTES, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";
import { withMcpOAuthMetadataObservation } from "./mcp-oauth-metadata.js";

/** An OAuth provider that may also watch the authorization-server metadata documents it is served. */
export type McpRemoteOAuthProvider = OAuthClientProvider & {
  observeAuthorizationMetadata?: (url: URL, document: unknown) => void;
};

export type McpRemoteFetchOptions = McpFetchPolicyOptions & {
  authProvider?: McpRemoteOAuthProvider;
};

/**
 * Aiden's fetch policy for one remote MCP service: service headers stay on
 * the service origin, bodies are bounded, redirects are refused, and OAuth
 * metadata documents are observed before they are parsed. Used by the
 * transport and by the OAuth code exchange alike.
 */
export function createMcpRemoteFetch(options: McpRemoteFetchOptions): typeof globalThis.fetch {
  const fetch: typeof globalThis.fetch = (input, init) => createMcpFetchPolicy(options)(input, init);
  const observer = options.authProvider?.observeAuthorizationMetadata;
  return observer ? withMcpOAuthMetadataObservation(fetch, observer.bind(options.authProvider)) : fetch;
}

/**
 * Streamable HTTP transport that retires its cached connection when the
 * server proves the session is gone, and stops every in-flight request
 * (including SSE streams) when it closes.
 */
class AidenStreamableHttpTransport extends StreamableHttpTransport {
  private terminalClose: ReturnType<typeof setImmediate> | undefined;

  constructor(
    options: ConstructorParameters<typeof StreamableHttpTransport>[0],
    private readonly lifetime: AbortController,
    private readonly onTerminalFailure?: () => void,
  ) {
    super(options);
    // Only an established session's 404 proves session loss (Pi reports it
    // as McpSessionExpiredError). Other POST errors and optional GET-stream
    // failures leave the client usable.
    this.onError((error) => {
      if (error instanceof McpSessionExpiredError) this.retire();
    });
  }

  override async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
    try {
      await super.send(message, options);
    } catch (error) {
      if (error instanceof McpSessionExpiredError) this.retire();
      throw error;
    }
  }

  override async close(): Promise<void> {
    if (this.terminalClose) clearImmediate(this.terminalClose);
    this.terminalClose = undefined;
    // Abort first: closing never waits on the network (no session DELETE).
    this.lifetime.abort(new Error("MCP connection closed."));
    await super.close();
  }

  private retire(): void {
    if (this.terminalClose || this.lifetime.signal.aborted) return;
    this.onTerminalFailure?.();
    // Release cache ownership now; close after the failing request settles.
    this.terminalClose = setImmediate(() => {
      this.terminalClose = undefined;
      void this.close().catch(() => undefined);
    });
  }
}

/**
 * Shared by attended sign-in, stored-token connections, and isolated
 * children. With an OAuth provider, a 401 refreshes the stored tokens once
 * (concurrent 401s on this transport share one refresh; the fetch policy
 * coalesces identical refreshes process-wide) and a request whose sender gave
 * up meanwhile is never re-sent.
 */
export function createMcpRemoteTransport(
  options: McpRemoteFetchOptions & { onTerminalFailure?: () => void },
): StreamableHttpTransport {
  const lifetime = new AbortController();
  const fetch = createMcpRemoteFetch({
    ...options,
    signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
  });
  return new AidenStreamableHttpTransport({
    url: options.serviceUrl,
    fetch,
    maxMessageBytes: MAX_MCP_RESPONSE_BYTES,
    ...(options.authProvider ? { authProvider: adaptOAuthProvider(options.authProvider) } : {}),
  }, lifetime, options.onTerminalFailure);
}
