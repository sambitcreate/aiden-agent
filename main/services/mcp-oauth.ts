import { mcpOAuthMetadataUrlForServer } from "../../renderer/shared/mcp-oauth-config.js";
import { loadMcpOAuthMetadataOverride } from "./mcp-oauth-metadata.js";
// OAuth 2.0 (PKCE + dynamic client registration) for remote MCP servers, per the
// MCP authorization spec. Uses the official SDK's `OAuthClientProvider` contract
// and a loopback redirect (RFC 8252 native-app flow): we open the provider's
// consent page in the user's browser and capture the authorization code on a
// short-lived localhost server.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { app, shell, logger } from "../platform.js";
import { McpOAuthCredentialStorageError, mcpOAuthStore } from "./mcp-oauth-store.js";
import {
  clearMcpStepUpScope,
  hasMcpOAuthSessionData,
  mcpInteractiveAuthorizationScope,
  McpOAuthSessionTransaction,
  McpOAuthAuthorizationFlow,
  mcpAuthorizationBinding,
  sessionWithMcpClientInformation,
  sessionMatchesMcpBinding,
  sessionForMcpAuthorizationAttempt,
  sessionAfterTokenInvalidation,
  sessionWithRefreshedMcpTokens,
  sessionWithSavedMcpTokens,
  usableMcpClientInformation,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import {
  McpOAuthOperationGate,
  type McpOAuthGeneration,
} from "./mcp-oauth-operation.js";
import type { McpOAuthOperation } from "./mcp-oauth-operation.js";
import {
  MCP_OAUTH_LOOPBACK_PORT,
  MCP_OAUTH_REDIRECT_URI,
  explainMcpOAuthFailure,
  mcpOAuthClientMetadata,
} from "./mcp-oauth-client-metadata.js";
import { assertMcpPresetServer, mcpOAuthClientNameForServer } from "./mcp-presets.js";
import { closeAgainAfterSettled } from "./generation-bound-connection-cache.js";
import type { McpServer } from "./types.js";
import { withMcpConfigurationPublication } from "./mcp-config-lease.js";
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";
import { startMcpOAuthLoopback, type McpOAuthLoopback } from "./mcp-oauth-loopback.js";
import { mcpLiveStatus } from "./mcp-status-events.js";

/** MCP `clientInfo` for sign-in connections: the running Aiden release, not a hard-coded build. */
function oauthClientInfo(): { name: string; version: string } {
  return { name: "aiden-agent", version: app.getVersion() };
}

// Fixed loopback redirect so the registered redirect_uri stays stable across
// sessions (dynamic client registration records it once).
const OAUTH_PORT = MCP_OAUTH_LOOPBACK_PORT;
const OAUTH_REDIRECT_URI = MCP_OAUTH_REDIRECT_URI;
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
    private readonly oauthClientName: string = mcpOAuthClientMetadata().client_name,
    private readonly authorization = new McpOAuthAuthorizationFlow(),
    private readonly metadataServer?: McpServer,
    private readonly metadataSignal?: AbortSignal,
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
    return mcpOAuthClientMetadata(this.oauthClientName) as OAuthClientMetadata;
  }

  state(): string {
    this.assertCanMutate();
    return this.authorization.state;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.assertCanMutate();
    this.authorization.saveDiscovery(state);
  }

  observeAuthorizationMetadata(url: URL, document: unknown): void {
    this.assertCanMutate();
    this.authorization.observeAuthorizationMetadata(url, document);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    this.assertCanMutate();
    const metadataUrl = this.metadataServer && mcpOAuthMetadataUrlForServer(this.metadataServer);
    if (metadataUrl && !this.authorization.discoveryState()) {
      const state = await loadMcpOAuthMetadataOverride(metadataUrl, {
        serviceUrl: this.metadataServer!.url!, serviceHeaders: this.metadataServer!.headers,
        signal: this.metadataSignal, isCurrent: this.mutationIsCurrent,
      });
      this.assertCanMutate();
      this.authorization.saveDiscovery(state);
    }
    return this.authorization.discoveryState();
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return usableMcpClientInformation((await this.boundSession()).clientInformation);
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    await this.saveSession(sessionWithMcpClientInformation(session, this.binding, info));
  }

  /** The tokens this provider last handed to (or received from) the SDK. */
  private lastTokens?: Pick<OAuthTokens, "access_token" | "refresh_token">;
  /** Whether this connection found a stored sign-in at all (sticky across invalidation). */
  private hadStoredTokens = false;
  /**
   * The SDK reads the PKCE verifier only to exchange an authorization code and
   * reads tokens() only before a refresh, so this tells the two saves apart.
   */
  private exchangingCode = false;

  async tokens(): Promise<OAuthTokens | undefined> {
    this.exchangingCode = false;
    const tokens = (await this.boundSession()).tokens;
    if (tokens) {
      this.hadStoredTokens = true;
      this.observeTokens?.(tokens);
    }
    this.lastTokens = tokens && { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.assertCanMutate();
    // A refresh (or sign-in) that minted tokens proves the session works again.
    if (!this.transaction) mcpLiveStatus.clearAuthFailure(this.serverId);
    // Register the exact material before either persistence or transport reuse.
    // Subagent callers use this hook to retain only a host-owned redactor.
    this.observeTokens?.(tokens);
    const exchangedCode = this.exchangingCode;
    this.exchangingCode = false;
    const session = await this.boundSession();
    this.assertCanMutate();
    // An authorization-code exchange always wins. A refresh response that
    // arrives after another client already rotated past the tokens it presented
    // must not roll the stored pair back to credentials the server consumed.
    const next = exchangedCode
      ? sessionWithSavedMcpTokens(session, this.binding, tokens, this.authorization.requestedScope)
      : sessionWithRefreshedMcpTokens(session, this.binding, this.lastTokens, tokens, this.authorization.requestedScope);
    if (!next) {
      logger.info("mcp-oauth", `Kept newer stored tokens for "${this.serverId}" over a late refresh response.`);
      return;
    }
    await this.saveSession(next);
    this.lastTokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
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
    this.exchangingCode = true;
    const verifier = (await this.boundSession()).codeVerifier;
    if (!verifier)
      throw new Error("Missing PKCE code verifier — restart the sign-in.");
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!("signal" in this.generation)) {
      // Stored tokens that could not be used or refreshed: Settings must stop
      // showing them as signed in. A server never signed in is not "expired".
      if (this.mutationIsCurrent()) {
        mcpLiveStatus.backgroundSignInRequired(this.serverId, { hadStoredSignIn: this.hadStoredTokens });
      }
      throw new Error(
        "This MCP server needs sign-in. Open Settings → Plugins and click Authorize.",
      );
    }
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    const boundUrl = this.authorization.authorizationUrl(
      authorizationUrl,
      mcpInteractiveAuthorizationScope(this.metadataServer?.url, session.tokens?.scope || session.grantedScope),
    );
    await shell.openExternal(boundUrl.toString());
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    this.assertCanMutate();
    if (!("signal" in this.generation) && (scope === "all" || scope === "tokens")) {
      // The SDK drops tokens after `invalid_grant` or a rejected refresh.
      mcpLiveStatus.authFailure(this.serverId, "invalid-grant");
    }
    if (scope === "all" || scope === "discovery") this.authorization.clearDiscovery();
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
    if (scope === "tokens") {
      // Compare-and-delete: newer tokens saved by a concurrent client survive.
      const next = sessionAfterTokenInvalidation(session, this.lastTokens);
      if (!next) return;
      await this.saveSession(next);
      return;
    }
    if (scope === "verifier") delete session.codeVerifier;
    if (scope === "client") delete session.clientInformation;
    await this.saveSession(session);
  }
}

/** Build a remote transport wired with an OAuth provider for the given server. */
export function makeOAuthTransport(
  server: McpServer,
  provider: OAuthClientProvider,
  signal?: AbortSignal,
): StreamableHTTPClientTransport | SSEClientTransport {
  assertMcpPresetServer(server);
  if (!server.url) throw new Error("This MCP server needs a URL.");
  if (server.transport === "stdio") throw new Error("OAuth requires a remote MCP server.");
  return createMcpRemoteTransport({
    transport: server.transport,
    serviceUrl: server.url,
    serviceHeaders: server.headers,
    signal,
    authProvider: provider,
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
    mcpAuthorizationBinding(server.url, mcpOAuthMetadataUrlForServer(server), server.oauthClientName),
    oauthOperations.snapshot(server.id),
    isCurrent,
    undefined,
    observeTokens,
    mcpOAuthClientNameForServer(server),
    undefined,
    structuredClone(server),
  );
}

export async function hasOAuthTokens(
  serverId: string,
  url?: string,
  authServerMetadataUrl?: string,
  oauthClientName?: string,
): Promise<boolean> {
  let session: McpOAuthSession;
  try {
    session = await mcpOAuthStore.get(serverId);
  } catch (error) {
    // Status only: an unreadable sign-in is not usable. Connecting reports why.
    if (error instanceof McpOAuthCredentialStorageError) return false;
    throw error;
  }
  if (url && !sessionMatchesMcpBinding(session, mcpAuthorizationBinding(url, authServerMetadataUrl, oauthClientName)))
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

/**
 * Stop a sign-in that is waiting in the browser. The running flow rejects with
 * `McpOAuthCancelledError` and frees the loopback port; false when none ran.
 */
export function cancelMcpAuthorization(serverId: string): boolean {
  return oauthOperations.cancel(serverId);
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

  const binding = mcpAuthorizationBinding(server.url, mcpOAuthMetadataUrlForServer(server), server.oauthClientName);
  if (!isCurrent())
    throw new Error("The renderer document is no longer active.");
  const operation = reservedOperation ?? oauthOperations.begin(server.id);
  if (!oauthOperations.isCurrent(operation)) {
    oauthOperations.end(operation);
    throw operation.signal.aborted
      ? cancellationError(operation.signal)
      : new Error("MCP authorization was superseded by a config change.");
  }
  const previousSession = await mcpOAuthStore.get(
    server.id,
    () => isCurrent() && oauthOperations.isCurrent(operation),
  ).catch((error: unknown) => {
    // Signing in again is how the user recovers from an unreadable sign-in.
    if (error instanceof McpOAuthCredentialStorageError) return {};
    throw error;
  });
  const transaction = new McpOAuthSessionTransaction(
    sessionForMcpAuthorizationAttempt(previousSession, binding),
  );
  const authorization = new McpOAuthAuthorizationFlow();
  const provider = new McpOAuthProvider(
    server.id,
    binding,
    operation,
    isCurrent,
    transaction,
    undefined,
    mcpOAuthClientNameForServer(server),
    authorization,
    structuredClone(server),
    ownerSignal ? AbortSignal.any([operation.signal, ownerSignal]) : operation.signal,
  );
  let loopback: McpOAuthLoopback | null = null;
  let commitAttempted = false;
  try {
    loopback = await startMcpOAuthLoopback({
      port: OAUTH_PORT,
      redirectUri: OAUTH_REDIRECT_URI,
      label: server.name || "MCP server",
      timeoutMs: AUTH_TIMEOUT_MS,
      callbackHtml: CALLBACK_HTML,
      authorization,
      signal: ownerSignal ? AbortSignal.any([operation.signal, ownerSignal]) : operation.signal,
    });
    // Re-authorization is transactional: preserve the durable old session
    // while the SDK mutates a private replacement buffer. A renderer reload,
    // failed provider, or process crash before final verification cannot erase
    // credentials that were still valid when the user started.
    const transportSignal = AbortSignal.any([
      operation.signal,
      ...(ownerSignal ? [ownerSignal] : []),
    ]);
    const transport = makeOAuthTransport(server, provider, transportSignal);
    const client = new Client(
      oauthClientInfo(),
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
      clearMcpStepUpScope(server.url);
      mcpLiveStatus.clearAuthFailure(server.id);
      return;
    } catch (error) {
      await client.close().catch(() => {});
      if (!(error instanceof UnauthorizedError)) throw error;
      // Expected: connect() triggered redirectToAuthorization (browser opened).
    }

    try {
      const code = await raceMcpOAuthCancellation(loopback.waitForCode(), [
        operation.signal,
        ownerSignal,
      ]);
      await raceMcpOAuthCancellation(transport.finishAuth(code), [
        operation.signal,
        ownerSignal,
      ]);
    } finally {
      await transport.close().catch(() => {});
    }

    // Verify the freshly minted tokens actually authorize a connection.
    const verifyTransport = makeOAuthTransport(server, provider, transportSignal);
    const verifyClient = new Client(
      oauthClientInfo(),
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
    clearMcpStepUpScope(server.url);
    mcpLiveStatus.clearAuthFailure(server.id);
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
    throw explainMcpOAuthFailure(error);
  } finally {
    loopback?.close();
    oauthOperations.end(operation);
  }
}
