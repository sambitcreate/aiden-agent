// Electron-free MCP OAuth client metadata. Hosted servers that allowlist
// Dynamic Client Registration by exact `client_name` (notably Figma) must
// receive the catalog name documented for that connector.

import { OAuthIssuerMismatchError, OAuthRegistrationError } from "@earendil-works/pi-mcp/oauth";

export const DEFAULT_MCP_OAUTH_CLIENT_NAME = "Aiden Agent";
export const MCP_OAUTH_LOOPBACK_PORT = 41390;
export const MCP_OAUTH_REDIRECT_URI = `http://127.0.0.1:${MCP_OAUTH_LOOPBACK_PORT}/callback`;

export interface McpOAuthClientMetadata {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  application_type: "native";
}

export function mcpOAuthClientMetadata(clientName?: string): McpOAuthClientMetadata {
  const name = clientName?.trim() || DEFAULT_MCP_OAUTH_CLIENT_NAME;
  return {
    client_name: name,
    redirect_uris: [MCP_OAUTH_REDIRECT_URI],
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

/**
 * Readable Settings lines for OAuth failures users can act on. The original
 * error stays as a non-enumerable `cause` for logs.
 * - A host that allowlists registering clients (Figma) answers dynamic client
 *   registration with a 403.
 * - Authorization-server metadata whose issuer does not match the server it
 *   was discovered from (RFC 8414) is refused; a custom server can name the
 *   right metadata document instead.
 */
export function explainMcpOAuthFailure(error: unknown): Error & { cause?: unknown } {
  if (error instanceof OAuthRegistrationError && error.status === 403) {
    return explained(
      "This MCP server rejected OAuth client registration (HTTP 403). Some hosts only allow listed MCP clients to register. Check Settings → Plugins for this connector's documented setup, then try Authorize again.",
      error,
    );
  }
  if (error instanceof OAuthIssuerMismatchError) {
    return explained(
      "This MCP server's authorization server reported a different issuer than expected, so sign-in was stopped. For a custom server, set its Authorization metadata URL in Settings → Plugins to the provider's own metadata document, then try Authorize again.",
      error,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
