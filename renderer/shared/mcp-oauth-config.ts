/** Explicit OAuth authority override; ordinary discovery remains the default. */
export function parseMcpOAuthMetadataUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value || [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new Error("OAuth metadata URL must be a URL of at most 2,048 characters.");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("OAuth metadata URL is invalid."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new Error("OAuth metadata URL requires HTTPS (or HTTP on loopback), without credentials or a fragment.");
  }
  return url.href;
}

export function mcpOAuthMetadataUrlForServer(server: { transport?: unknown; oauth?: unknown; authServerMetadataUrl?: unknown; presetId?: unknown }): string | undefined {
  if (server.authServerMetadataUrl === undefined) return undefined;
  if (server.transport === "stdio" || server.oauth !== true) throw new Error("OAuth metadata overrides require a remote server with OAuth sign-in enabled.");
  if (server.presetId) throw new Error("OAuth metadata overrides require a custom MCP server.");
  return parseMcpOAuthMetadataUrl(server.authServerMetadataUrl);
}


export function validateMcpServerMetadata(server: { transport?: unknown; oauth?: unknown; authServerMetadataUrl?: unknown; oauthClientName?: unknown; description?: unknown; presetId?: unknown; authProvider?: unknown; url?: unknown; headers?: unknown }): void {
  mcpOAuthMetadataUrlForServer(server);
  if (server.authProvider !== undefined) {
    if (typeof server.authProvider !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(server.authProvider)) throw new Error("Select a valid built-in provider for MCP authentication.");
    if (server.transport !== "http" || server.oauth || server.presetId || server.authServerMetadataUrl !== undefined || server.oauthClientName !== undefined || (server.headers && Object.keys(server.headers).length > 0)) throw new Error("Provider authentication requires a custom HTTP server without OAuth or configured headers.");
    if (typeof server.url !== "string") throw new Error("Provider authentication requires an HTTPS MCP URL.");
    const url = new URL(parseMcpOAuthMetadataUrl(server.url));
    if (url.protocol !== "https:") throw new Error("Provider authentication requires an HTTPS MCP URL.");
  }
  if (server.description !== undefined && (typeof server.description !== "string" || server.description.length > 1024 || server.description.includes("\0"))) throw new Error("MCP description must contain at most 1,024 characters.");
  if (server.oauthClientName !== undefined) {
    if (typeof server.oauthClientName !== "string" || !server.oauthClientName.trim() || server.oauthClientName.length > 128 || [...server.oauthClientName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("OAuth client name must contain 1–128 characters without control characters.");
    if (server.transport === "stdio" || server.oauth !== true || server.presetId) throw new Error("OAuth client name overrides require a custom remote OAuth server.");
  }
}
