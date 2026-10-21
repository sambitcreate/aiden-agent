// Electron-free MCP OAuth client metadata. Every registration uses the
// client name "Aiden Agent" unless a catalog preset names another one
// (`mcpOAuthClientNameForServer` is the single source).

import { OAuthError, OAuthIssuerMismatchError, OAuthRegistrationError } from "@earendil-works/pi-mcp/oauth";
import { mcpOAuthDisplayText } from "./mcp-oauth-session.js";
import { MCP_OAUTH_LOOPBACK_PORT, MCP_OAUTH_REDIRECT_URI } from "../../renderer/shared/mcp-oauth-config.js";

export { MCP_OAUTH_LOOPBACK_PORT, MCP_OAUTH_REDIRECT_URI };

export const DEFAULT_MCP_OAUTH_CLIENT_NAME = "Aiden Agent";

/**
 * HTTPS URL of Aiden's OAuth Client ID Metadata Document (CIMD). When it is
 * set and an authorization server advertises
 * `client_id_metadata_document_supported`, Aiden identifies with this URL as
 * its `client_id` instead of registering a client. It stays unset until the
 * document (`docs/mcp/aiden-agent-client-metadata.json`) is hosted at a
 * stable Aiden-owned URL; until then every server gets dynamic registration.
 */
export const AIDEN_MCP_CLIENT_METADATA_URL: string | undefined = undefined;

export interface McpOAuthClientMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type: "native";
}

export function mcpOAuthClientMetadata(clientName?: string, redirectUri: string = MCP_OAUTH_REDIRECT_URI): McpOAuthClientMetadata {
  const name = clientName?.trim() || DEFAULT_MCP_OAUTH_CLIENT_NAME;
  return {
    client_name: name,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };
}

/** Format an API-key preset header so Bearer tokens can be pasted with or without the prefix. */
export function mcpApiKeyHeaderValue(key: string, prefix?: string): string {
  const trimmed = key.trim();
  if (!prefix) return trimmed;
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return trimmed;
  return `${prefix}${trimmed}`;
}

function explained(message: string, error: unknown): Error & { cause?: unknown } {
  const result = new Error(message);
  if (error instanceof Error) {
    Object.defineProperty(result, "cause", { value: error, configurable: true, writable: true });
  }
  return result;
}

/** `: description.` from a JSON OAuth error body, or `.` for anything else. */
function oauthDescription(body: string): string {
  try {
    const value = JSON.parse(body) as { error_description?: unknown; error?: unknown };
    const text = mcpOAuthDisplayText(typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : undefined);
    return text ? `: ${text}` : ".";
  } catch {
    return ".";
  }
}

/**
 * Readable Settings lines for OAuth failures users can act on. The original
 * error stays as a non-enumerable `cause` for logs.
 * - A host that allowlists registering clients (Figma) answers dynamic client
 *   registration with a 403.
 * - Authorization-server metadata whose issuer does not match the server it
 *   was discovered from (RFC 8414) is refused; a custom server can name the
 *   right metadata document instead.
 * - Other registration and token-endpoint errors keep only their status, OAuth
 *   error code and a bounded one-line description, never the response body.
 */
export function explainMcpOAuthFailure(error: unknown): Error & { cause?: unknown } {
  if (error instanceof OAuthRegistrationError && error.status === 403) {
    return explained(
      "This MCP server rejected OAuth client registration (HTTP 403). Some hosts only allow listed MCP clients to register. Check Settings → Plugins for this connector's documented setup, then try Authorize again.",
      error,
    );
  }
  if (error instanceof OAuthRegistrationError) {
    // The response body is the server's to choose (an HTML error page, a stack trace): show only a bounded description.
    return explained(`This MCP server rejected OAuth client registration (HTTP ${error.status})${oauthDescription(error.body)}`, error);
  }
  if (error instanceof OAuthError) {
    // Pi reports a token response without an OAuth error document as "HTTP <status>: <body>".
    const status = error.code === "server_error" ? /\bHTTP (\d{3})\b/u.exec(error.message)?.[1] : undefined;
    if (status) return explained(`The authorization server answered HTTP ${status}.`, error);
    const description = mcpOAuthDisplayText(error.message);
    return explained(description && description !== error.code ? `The authorization server returned “${error.code}”: ${description}` : `The authorization server returned “${error.code}”.`, error);
  }
  if (error instanceof OAuthIssuerMismatchError) {
    return explained(
      "This MCP server's authorization server reported a different issuer than expected, so sign-in was stopped. For a custom server, set its Authorization metadata URL in Settings → Plugins to the provider's own metadata document, then try Authorize again.",
      error,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
