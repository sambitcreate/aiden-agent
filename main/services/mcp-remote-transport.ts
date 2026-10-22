import {
  McpSessionExpiredError,
  type AuthProvider,
  StreamableHttpTransport,
  type JsonRpcMessage,
  type McpTransportSendOptions,
} from "@earendil-works/pi-mcp";
import { adaptOAuthProvider, type OAuthClientProvider } from "@earendil-works/pi-mcp/oauth";
import { createMcpFetchPolicy, MAX_MCP_RESPONSE_BYTES, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";

/**
 * An OAuth provider that may also hear why a token refresh failed for a
 * reason other than an OAuth error (network failure, timeout, 5xx). Pi's flow
 * swallows those and continues to the authorization redirect; the provider
 * uses the cause to report a transient connection failure instead of asking
 * for sign-in.
 */
export type McpRemoteOAuthProvider = OAuthClientProvider & {
  observeRefreshFailure?: (cause: Error) => void;
  /** Replace an error the OAuth recovery after a 401 ended with (for example a transient refresh failure). */
  mapAuthorizationError?: (error: unknown) => unknown;
};

function adaptRemoteOAuthProvider(provider: McpRemoteOAuthProvider): AuthProvider {
  const adapted = adaptOAuthProvider(provider);
  if (!provider.mapAuthorizationError || !adapted.onUnauthorized) return adapted;
  const onUnauthorized = adapted.onUnauthorized.bind(adapted);
  return {
    token: () => adapted.token(),
    onUnauthorized: async (context) => {
      try {
        await onUnauthorized(context);
      } catch (error) {
        throw provider.mapAuthorizationError!(error);
      }
    },
  };
}

export type McpRemoteFetchOptions = McpFetchPolicyOptions & {
  authProvider?: McpRemoteOAuthProvider;
};

function isRefreshRequest(init: RequestInit | undefined): boolean {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  return (typeof body === "string" || body instanceof URLSearchParams) &&
    new URLSearchParams(body).get("grant_type") === "refresh_token";
}

/** Statuses after which a token endpoint may well answer on the next try. */
function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Aiden's fetch policy for one remote MCP service: service headers stay on
 * the service origin, bodies are bounded, and only same-origin metadata
 * redirects are followed. Used by the transport and by the OAuth code
 * exchange alike.
 */
export function createMcpRemoteFetch(options: McpRemoteFetchOptions): typeof globalThis.fetch {
  const fetch = createMcpFetchPolicy(options);
  const provider = options.authProvider;
  if (!provider?.observeRefreshFailure) return fetch;
  return async (input, init) => {
    if (!isRefreshRequest(init)) return fetch(input, init);
    try {
      const response = await fetch(input, init);
      if (transientStatus(response.status)) provider.observeRefreshFailure?.(new Error(`the token endpoint answered HTTP ${response.status}`));
      return response;
    } catch (error) {
      provider.observeRefreshFailure?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
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
    ...(options.authProvider ? { authProvider: adaptRemoteOAuthProvider(options.authProvider) } : {}),
  }, lifetime, options.onTerminalFailure);
}
