// OAuth 2.0 (PKCE, dynamic client registration, Client ID Metadata Documents
// or a pre-registered client) for remote MCP servers, per the MCP
// authorization spec, on Pi's `@earendil-works/pi-mcp/oauth` flow. The
// provider and the attended sign-in live in mcp-oauth-provider-core.ts; this
// module wires them to the encrypted session store, the system browser
// (RFC 8252 loopback redirect) and live status.

import type { OAuthTokens } from "@earendil-works/pi-mcp/oauth";
import { app, shell, logger } from "../platform.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import { McpOAuthOperationGate, type McpOAuthOperation } from "./mcp-oauth-operation.js";
import {
  AIDEN_MCP_CLIENT_METADATA_URL,
  MCP_OAUTH_LOOPBACK_PORT,
  MCP_OAUTH_REDIRECT_URI,
} from "./mcp-oauth-client-metadata.js";
import {
  authorizeMcpServerWithRuntime,
  createBackgroundMcpOAuthProvider,
  readMcpOAuthSignInState,
  type McpOAuthAuthorizationResult,
  type McpOAuthRuntime,
} from "./mcp-oauth-provider-core.js";
import type { McpOAuthSignInState } from "./mcp-oauth-session.js";
import type { McpRemoteOAuthProvider } from "./mcp-remote-transport.js";
import type { McpServer } from "./types.js";
import { withMcpConfigurationPublication } from "./mcp-config-lease.js";
import { mcpLiveStatus } from "./mcp-status-events.js";

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const oauthOperations = new McpOAuthOperationGate();

const runtime: McpOAuthRuntime = {
  store: mcpOAuthStore,
  gate: oauthOperations,
  status: mcpLiveStatus,
  openBrowser: (url) => shell.openExternal(url),
  log: {
    info: (message) => logger.info("mcp-oauth", message),
    warn: (message) => logger.warn("mcp-oauth", message),
    error: (message, error) => logger.error("mcp-oauth", message, error),
  },
  /** The running Aiden release, not a hard-coded build. */
  get clientVersion() {
    return app.getVersion();
  },
  // Fixed loopback redirect so the registered redirect_uri stays stable across
  // sessions (dynamic client registration records it once).
  loopback: { port: MCP_OAUTH_LOOPBACK_PORT, redirectUri: MCP_OAUTH_REDIRECT_URI, timeoutMs: AUTH_TIMEOUT_MS },
  clientMetadataUrl: AIDEN_MCP_CLIENT_METADATA_URL,
  publish: (serverId, operation) => withMcpConfigurationPublication(serverId, operation),
};

/**
 * Provider for background (non-interactive) connections: attaches stored
 * tokens and refreshes them. A server without a usable sign-in fails with
 * "sign-in required" instead of registering or opening a browser.
 */
export function oauthProviderFor(
  server: McpServer,
  isCurrent: () => boolean = () => true,
  observeTokens?: (tokens: OAuthTokens) => void,
): McpRemoteOAuthProvider {
  if (!server.url) throw new Error("This MCP server needs a URL.");
  return createBackgroundMcpOAuthProvider(runtime, server, isCurrent, observeTokens);
}

/** Stored sign-in state of a server (Settings, presets, status). */
export function mcpOAuthSignInStateFor(serverId: string, server: McpServer | undefined): Promise<McpOAuthSignInState> {
  return readMcpOAuthSignInState(mcpOAuthStore, serverId, server);
}

/** Whether tokens are stored for the server's current binding. */
export async function hasOAuthTokens(server: McpServer): Promise<boolean> {
  return (await mcpOAuthSignInStateFor(server.id, server)).authorized;
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

/**
 * Settings → Authorize: open the browser, capture the code on the loopback,
 * exchange it, verify the connection, and store the tokens.
 */
export function authorizeMcpServer(
  server: McpServer,
  isCurrent: () => boolean = () => true,
  ownerSignal?: AbortSignal,
  reservedOperation?: McpOAuthOperation,
): Promise<McpOAuthAuthorizationResult> {
  return authorizeMcpServerWithRuntime(runtime, server, { isCurrent, ownerSignal, reservedOperation });
}
