import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { parseMcpOAuthMetadataUrl } from "../../renderer/shared/mcp-oauth-config.js";
import { createMcpFetchPolicy, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";

/** SDK 1.30 has no override option; its public discovery-state hook accepts trusted metadata. */
export async function loadMcpOAuthMetadataOverride(metadataUrl: string, options: McpFetchPolicyOptions): Promise<OAuthDiscoveryState> {
  const url = parseMcpOAuthMetadataUrl(metadataUrl);
  const fetch = createMcpFetchPolicy({ ...options, maximumBytes: 64 * 1024 });
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OAuth metadata request failed (HTTP ${response.status}).`);
  }
  const parsed = OAuthMetadataSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("OAuth metadata document is invalid.");
  const metadata = parsed.data;
  // Configured documents may describe a different issuer, but cannot redirect
  // browser or token traffic to non-web protocols, plaintext remote hosts, or credentials.
  for (const endpoint of [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
    if (endpoint !== undefined) parseMcpOAuthMetadataUrl(endpoint);
  }
  return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata };
}
