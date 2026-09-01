// OAuth 2.0 (PKCE + dynamic client registration) for remote MCP servers, per the
// MCP authorization spec. Uses the official SDK's `OAuthClientProvider` contract
// and a loopback redirect (RFC 8252 native-app flow): we open the provider's
// consent page in the user's browser and capture the authorization code on a
// short-lived localhost server.

import * as http from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { shell, logger } from "../platform.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import {
  hasMcpOAuthSessionData,
  McpOAuthSessionTransaction,
  mcpAuthorizationBinding,
  publicMcpClientInformation,
  sessionMatchesMcpBinding,
  sessionForFreshMcpAuthorization,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import {
  McpOAuthOperationGate,
  type McpOAuthGeneration,
} from "./mcp-oauth-operation.js";
import type { McpOAuthOperation } from "./mcp-oauth-operation.js";
import { assertMcpPresetServer } from "./mcp-presets.js";
import { closeAgainAfterSettled } from "./generation-bound-connection-cache.js";
import type { McpServer } from "./types.js";
import { withMcpConfigurationPublication } from "./mcp-config-lease.js";

// Fixed loopback redirect so the registered redirect_uri stays stable across
// sessions (dynamic client registration records it once).
const OAUTH_PORT = 41390;
const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/callback`;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const oauthOperations = new McpOAuthOperationGate();

const CALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Aiden Agent</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#1c1c1e;color:#fff;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}
h1{font-size:17px;font-weight:600;margin:0 0 6px}p{font-size:13px;color:#98989d;margin:0}</style></head>
<body><div><h1>Connected</h1><p>You can return to Aiden Agent and close this tab.</p></div></body></html>`;

/**
 * SDK OAuthClientProvider backed by the encrypted session store. One instance
 * per MCP server id; `redirectToAuthorization` opens the system browser.
 */
class McpOAuthProvider implements OAuthClientProvider {
  /**
   * @param interactive When false (background connections during chat), the flow
   * must never open a browser — an expired/absent session fails loudly instead so
   * the user can re-authorize from Settings on their own terms.
   */
  constructor(
    private readonly serverId: string,
    private readonly binding: string,
    private readonly generation: McpOAuthGeneration,
    private readonly requestIsCurrent: () => boolean = () => true,
    private readonly transaction?: McpOAuthSessionTransaction,
    private readonly observeTokens?: (tokens: OAuthTokens) => void,
  ) {}

  private async boundSession() {
    this.assertCanMutate();
    const session = this.transaction
      ? this.transaction.read()
      : await mcpOAuthStore.get(this.serverId, this.mutationIsCurrent);
    this.assertCanMutate();
    return sessionMatchesMcpBinding(session, this.binding)
      ? session
      : { authorizationBinding: this.binding };
  }

  private assertCanMutate(): void {
    if (!this.requestIsCurrent()) {
      throw new Error("The renderer document is no longer active.");
    }
    oauthOperations.assertMutationAllowed(this.serverId, this.generation);
  }

  private mutationIsCurrent = (): boolean => {
    return (
      this.requestIsCurrent() &&
      oauthOperations.canMutate(this.serverId, this.generation)
    );
  };

  private async saveSession(session: McpOAuthSession): Promise<void> {
    this.assertCanMutate();
    if (this.transaction) {
      this.transaction.replace(session);
      this.assertCanMutate();
      return;
    }
    await mcpOAuthStore.set(this.serverId, session, this.mutationIsCurrent);
  }

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Aiden Agent",
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const information = (await this.boundSession()).clientInformation;
    return information ? publicMcpClientInformation(information) : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    await this.saveSession({
      ...session,
      authorizationBinding: this.binding,
      clientInformation: publicMcpClientInformation(info),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = (await this.boundSession()).tokens;
    if (tokens) this.observeTokens?.(tokens);
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.assertCanMutate();
    // Register the exact material before either persistence or transport reuse.
    // Subagent callers use this hook to retain only a host-owned redactor.
    this.observeTokens?.(tokens);
    const session = await this.boundSession();
    this.assertCanMutate();
    await this.saveSession({
      ...session,
      authorizationBinding: this.binding,
      tokens,
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    await this.saveSession({
      ...session,
      authorizationBinding: this.binding,
      codeVerifier,
    });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.boundSession()).codeVerifier;
    if (!verifier)
      throw new Error("Missing PKCE code verifier — restart the sign-in.");
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!("signal" in this.generation)) {
      throw new Error(
        "This MCP server needs sign-in. Open Settings → Plugins and click Authorize.",
      );
    }
    this.assertCanMutate();
    await shell.openExternal(authorizationUrl.toString());
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    this.assertCanMutate();
    if (scope === "all") {
      if (this.transaction) {
        await this.saveSession({ authorizationBinding: this.binding });
      } else {
        await mcpOAuthStore.clear(this.serverId, this.mutationIsCurrent);
      }
      return;
    }
    const session = await this.boundSession();
    this.assertCanMutate();
    if (scope === "tokens") delete session.tokens;
    if (scope === "verifier") delete session.codeVerifier;
    if (scope === "client") delete session.clientInformation;
    await this.saveSession(session);
  }
}

/** Build a remote transport wired with an OAuth provider for the given server. */
export function makeOAuthTransport(
  server: McpServer,
  provider: OAuthClientProvider,
): StreamableHTTPClientTransport | SSEClientTransport {
  assertMcpPresetServer(server);
  if (!server.url) throw new Error("This MCP server needs a URL.");
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.transport === "sse") {
    return new SSEClientTransport(url, { authProvider: provider, requestInit });
  }
  return new StreamableHTTPClientTransport(url, {
    authProvider: provider,
    requestInit,
  });
}

/** Provider for background (non-interactive) connections — attaches stored tokens. */
export function oauthProviderFor(
  server: McpServer,
  isCurrent: () => boolean = () => true,
  observeTokens?: (tokens: OAuthTokens) => void,
): OAuthClientProvider {
  if (!server.url) throw new Error("This MCP server needs a URL.");
  return new McpOAuthProvider(
    server.id,
    mcpAuthorizationBinding(server.url),
    oauthOperations.snapshot(server.id),
    isCurrent,
    undefined,
    observeTokens,
  );
}

export async function hasOAuthTokens(
  serverId: string,
  url?: string,
): Promise<boolean> {
  const session = await mcpOAuthStore.get(serverId);
  if (url && !sessionMatchesMcpBinding(session, mcpAuthorizationBinding(url)))
    return false;
  return Boolean(session.tokens);
}

export async function clearOAuth(
  serverId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await withMcpConfigurationPublication(serverId, () =>
    mcpOAuthStore.clear(serverId, isCurrent),
  );
}

export function invalidateMcpOAuthOperation(serverId: string): void {
  oauthOperations.invalidate(serverId);
}

/** Main-only non-secret revision; stable across token refresh, changes on reauthorization. */
export function mcpOAuthCredentialGeneration(serverId: string): number {
  return oauthOperations.snapshot(serverId).generation;
}

export function suspendMcpOAuthOperations(serverId: string): () => void {
  return oauthOperations.suspend(serverId);
}

export function reserveMcpAuthorization(serverId: string): McpOAuthOperation {
  return oauthOperations.begin(serverId);
}

export function endReservedMcpAuthorization(
  operation: McpOAuthOperation,
): void {
  oauthOperations.end(operation);
}

interface Loopback {
  waitForCode: () => Promise<string>;
  close: () => void;
}

function startLoopbackServer(): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", OAUTH_REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_HTML);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error)
        rejectCode(
          new Error(
            `Authorization denied: ${url.searchParams.get("error_description") || error}`,
          ),
        );
      else if (code) resolveCode(code);
      else rejectCode(new Error("No authorization code was returned."));
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `Port ${OAUTH_PORT} is busy — close whatever is using it and try again.`,
            )
          : err,
      );
    });

    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      const timer = setTimeout(
        () => rejectCode(new Error("Sign-in timed out.")),
        AUTH_TIMEOUT_MS,
      );
      resolve({
        waitForCode: () => codePromise.finally(() => clearTimeout(timer)),
        close: () => server.close(),
      });
    });
  });
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("MCP authorization was superseded by a config change.");
}

function raceMcpOAuthCancellation<T>(
  operation: Promise<T>,
  signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<T> {
  const activeSignals = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  const alreadyCancelled = activeSignals.find((signal) => signal.aborted);
  if (alreadyCancelled)
    return Promise.reject(cancellationError(alreadyCancelled));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const listeners = new Map<AbortSignal, () => void>();
    const settle = (result: () => void): void => {
      if (settled) return;
      settled = true;
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      result();
    };
    for (const signal of activeSignals) {
      const listener = () => settle(() => reject(cancellationError(signal)));
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

async function connectWithMcpOAuthCancellation(
  client: Client,
  connection: Promise<void>,
  signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<void> {
  try {
    await raceMcpOAuthCancellation(connection, signals);
  } catch (error) {
    await client.close().catch(() => {});
    if (signals.some((signal) => signal?.aborted)) {
      // Some SDK transports do not become closeable until connect settles.
      // Keep the raw promise and close once more at that boundary.
      closeAgainAfterSettled(connection, () => client.close());
    }
    throw error;
  }
}

/**
 * Run the interactive OAuth flow for a remote MCP server: open the browser,
 * capture the code on the loopback, exchange it, and verify the connection.
 * Tokens land in the encrypted store for future connections.
 */
export async function authorizeMcpServer(
  server: McpServer,
  isCurrent: () => boolean = () => true,
  ownerSignal?: AbortSignal,
  reservedOperation?: McpOAuthOperation,
): Promise<void> {
  assertMcpPresetServer(server);
  if (server.transport === "stdio")
    throw new Error("OAuth applies only to remote (HTTP/SSE) MCP servers.");
  if (!server.url) throw new Error("Add the server URL before authorizing.");

  const binding = mcpAuthorizationBinding(server.url);
  if (!isCurrent())
    throw new Error("The renderer document is no longer active.");
  const operation = reservedOperation ?? oauthOperations.begin(server.id);
  if (!oauthOperations.isCurrent(operation)) {
    oauthOperations.end(operation);
    throw new Error("MCP authorization was superseded by a config change.");
  }
  const previousSession = await mcpOAuthStore.get(
    server.id,
    () => isCurrent() && oauthOperations.isCurrent(operation),
  );
  const transaction = new McpOAuthSessionTransaction(
    sessionForFreshMcpAuthorization(previousSession, binding),
  );
  const provider = new McpOAuthProvider(
    server.id,
    binding,
    operation,
    isCurrent,
    transaction,
  );
  let loopback: Loopback | null = null;
  let commitAttempted = false;
  try {
    loopback = await startLoopbackServer();
    // Re-authorization is transactional: preserve the durable old session
    // while the SDK mutates a private replacement buffer. A renderer reload,
    // failed provider, or process crash before final verification cannot erase
    // credentials that were still valid when the user started.
    const transport = makeOAuthTransport(server, provider);
    const client = new Client(
      { name: "aiden-agent", version: "0.27.0" },
      { capabilities: {} },
    );
    try {
      const connection = client.connect(transport);
      await connectWithMcpOAuthCancellation(client, connection, [
        operation.signal,
        ownerSignal,
      ]);
      await client.close().catch(() => {});
      commitAttempted = true;
      await withMcpConfigurationPublication(server.id, () =>
        mcpOAuthStore.set(server.id, transaction.read(), () => {
          return isCurrent() && oauthOperations.isCurrent(operation);
        }),
      );
      return;
    } catch (error) {
      await client.close().catch(() => {});
      if (!(error instanceof UnauthorizedError)) throw error;
      // Expected: connect() triggered redirectToAuthorization (browser opened).
    }

    const code = await raceMcpOAuthCancellation(loopback.waitForCode(), [
      operation.signal,
      ownerSignal,
    ]);
    await raceMcpOAuthCancellation(transport.finishAuth(code), [
      operation.signal,
      ownerSignal,
    ]);

    // Verify the freshly minted tokens actually authorize a connection.
    const verifyTransport = makeOAuthTransport(server, provider);
    const verifyClient = new Client(
      { name: "aiden-agent", version: "0.27.0" },
      { capabilities: {} },
    );
    try {
      const connection = verifyClient.connect(verifyTransport);
      await connectWithMcpOAuthCancellation(verifyClient, connection, [
        operation.signal,
        ownerSignal,
      ]);
    } finally {
      await verifyClient.close().catch(() => {});
    }
    commitAttempted = true;
    await withMcpConfigurationPublication(server.id, () =>
      mcpOAuthStore.set(server.id, transaction.read(), () => {
        return isCurrent() && oauthOperations.isCurrent(operation);
      }),
    );
  } catch (error) {
    if (commitAttempted && oauthOperations.isCurrent(operation)) {
      try {
        if (hasMcpOAuthSessionData(previousSession)) {
          await withMcpConfigurationPublication(server.id, () =>
            mcpOAuthStore.set(server.id, previousSession, () =>
              oauthOperations.isCurrent(operation),
            ),
          );
        } else {
          await withMcpConfigurationPublication(server.id, () =>
            mcpOAuthStore.clear(server.id, () =>
              oauthOperations.isCurrent(operation),
            ),
          );
        }
      } catch (restoreError) {
        logger.error(
          "mcp-oauth",
          `Failed to restore the previous OAuth session for "${server.name}".`,
          restoreError,
        );
      }
    }
    logger.warn(
      "mcp-oauth",
      `Authorization failed for "${server.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    loopback?.close();
    oauthOperations.end(operation);
  }
}
