import {
  McpSessionExpiredError,
  type AuthProvider,
  StreamableHttpTransport,
  type JsonRpcMessage,
  type McpTransportSendOptions,
} from "@earendil-works/pi-mcp";
import { mcpToolSendGuard } from "./mcp-client.js";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  parseWwwAuthenticate,
  type OAuthClientProvider,
} from "@earendil-works/pi-mcp/oauth";
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
  /**
   * When the tokens the last `tokens()` call returned should be refreshed
   * before they are sent (ms since the epoch), or undefined to send them
   * until the server rejects them.
   */
  tokenRefreshDueAt?: () => number | undefined;
  /**
   * Hold the refresh lock of the stored grant (shared with other clients and,
   * in the CLI, other processes) from re-reading its tokens to saving new ones.
   */
  withRefreshLock?: <T>(operation: () => Promise<T>) => Promise<T>;
};

/** A refresh that needs the user (sign-in) rather than a later retry. */
function needsSignIn(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "mcp-oauth-sign-in-required";
}

type RefreshOptions = Partial<Pick<Parameters<typeof authorizeMcp>[1], "serverUrl" | "fetch" | "resourceMetadataUrl" | "scope">>;

function adaptRemoteOAuthProvider(
  provider: McpRemoteOAuthProvider,
  service: { serverUrl: URL; fetch: typeof globalThis.fetch },
): AuthProvider {
  const adapted = adaptOAuthProvider(provider);
  const mapError = (error: unknown) => provider.mapAuthorizationError ? provider.mapAuthorizationError(error) : error;
  if (!provider.withRefreshLock) {
    if (!provider.mapAuthorizationError || !adapted.onUnauthorized) return adapted;
    const onUnauthorized = adapted.onUnauthorized.bind(adapted);
    return {
      token: () => adapted.token(),
      onUnauthorized: async (context) => {
        try {
          await onUnauthorized(context);
        } catch (error) {
          throw mapError(error);
        }
      },
    };
  }
  let refreshing: Promise<void> | undefined;
  /** The token an early refresh failed for transiently; it is sent until a 401. */
  let earlyRefreshFailedFor: string | undefined;
  /**
   * Replace `staleToken`, the access token that expired or was rejected.
   * Requests on this transport share one refresh; other clients of the same
   * grant wait on the lock, then find the tokens its holder saved and use them.
   */
  const refresh = (staleToken: string | undefined, options: RefreshOptions = {}) => {
    refreshing ??= provider.withRefreshLock!(async (): Promise<void> => {
      const current = (await provider.tokens())?.access_token;
      if (current !== undefined && current !== staleToken) return;
      const result = await authorizeMcp(provider, {
        ...options,
        serverUrl: options.serverUrl ?? service.serverUrl,
        fetch: options.fetch ?? service.fetch,
      });
      if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
    }).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  return {
    token: async () => {
      await refreshing?.catch(() => undefined);
      const current = (await provider.tokens())?.access_token;
      const dueAt = provider.tokenRefreshDueAt?.();
      if (current === undefined || dueAt === undefined || dueAt > Date.now() || current === earlyRefreshFailedFor) return current;
      try {
        await refresh(current);
      } catch (error) {
        // The grant is gone (invalid_grant, a dead client): fail rather than
        // send a token the stored session no longer holds.
        if (needsSignIn(error)) throw error;
        // A transient failure: the token is still valid for a moment, so send
        // it and let a 401 decide what happens next, without retrying the
        // refresh on every request meanwhile.
        earlyRefreshFailedFor = current;
        return current;
      }
      return (await provider.tokens())?.access_token;
    },
    onUnauthorized: async (context) => {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      try {
        // A step-up for more scope keeps the tokens; Pi's recovery handles it.
        if (challenge.error === "insufficient_scope") return await adapted.onUnauthorized!(context);
        await refresh(context.token, {
          serverUrl: context.serverUrl,
          resourceMetadataUrl: challenge.resourceMetadataUrl,
          scope: challenge.scope,
          fetch: context.fetch,
        });
      } catch (error) {
        throw mapError(error);
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
    private readonly toolSends: Map<string | number, () => void>,
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
    const id = "method" in message && message.method === "tools/call" && "id" in message ? message.id : undefined;
    const guard = mcpToolSendGuard.getStore();
    if (id !== undefined && guard) this.toolSends.set(id, () => {
      options?.signal?.throwIfAborted();
      guard();
    });
    try {
      await super.send(message, options);
    } catch (error) {
      if (error instanceof McpSessionExpiredError) this.retire();
      throw error;
    } finally {
      if (id !== undefined) this.toolSends.delete(id);
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
 * up meanwhile is never re-sent. A provider with a refresh lock also refreshes
 * a token about to expire before sending it, and a client that waited on the
 * lock uses the tokens the holder saved instead of refreshing again.
 */
export function createMcpRemoteTransport(
  options: McpRemoteFetchOptions & { onTerminalFailure?: () => void; wrapFetch?: (send: typeof globalThis.fetch) => typeof globalThis.fetch },
): StreamableHttpTransport {
  const lifetime = new AbortController();
  const toolSends = new Map<string | number, () => void>();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const serviceUrl = new URL(options.serviceUrl).href;
  const send: typeof globalThis.fetch = (input, init) => {
    // Only the matching service RPC carries tool authority. The same client
    // can concurrently send OAuth, SSE, cancellation and other tool requests.
    if (toolSends.size && init?.method === "POST" && typeof init.body === "string" &&
        String(input) === serviceUrl && new Headers(init.headers).get("content-type") === "application/json") {
      const rpc = JSON.parse(init.body);
      if (rpc?.method === "tools/call") toolSends.get(rpc.id)?.();
    }
    return fetchImpl(input, init);
  };
  const fetch = createMcpRemoteFetch({
    ...options,
    fetch: options.wrapFetch ? options.wrapFetch(send) : send,
    signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
  });
  return new AidenStreamableHttpTransport({
    url: options.serviceUrl,
    fetch,
    maxMessageBytes: MAX_MCP_RESPONSE_BYTES,
    ...(options.authProvider
      ? { authProvider: adaptRemoteOAuthProvider(options.authProvider, { serverUrl: new URL(options.serviceUrl), fetch }) }
      : {}),
  }, lifetime, toolSends, options.onTerminalFailure);
}
