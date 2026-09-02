// Electron-free MCP OAuth client metadata. Hosted servers that allowlist
// Dynamic Client Registration by exact `client_name` (notably Figma) must
// receive the catalog name documented for that connector.

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

/**
 * The MCP SDK surfaces Figma's plaintext DCR 403 as a JSON parse failure.
 * Keep the original error as `cause` for logs while giving Settings a readable line.
 */
export function explainMcpOAuthFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /HTTP 403/i.test(message) &&
    /Invalid OAuth error response/i.test(message) &&
    /Forbidden/i.test(message)
  ) {
    return new Error(
      "This MCP server rejected OAuth client registration (HTTP 403). Some hosts only allow listed MCP clients to register. Check Settings → Plugins for this connector's documented setup, then try Authorize again.",
      { cause: error instanceof Error ? error : undefined },
    );
  }
  return error instanceof Error ? error : new Error(message);
}
