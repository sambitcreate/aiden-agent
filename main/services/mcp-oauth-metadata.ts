import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { parseMcpOAuthMetadataUrl } from "../../renderer/shared/mcp-oauth-config.js";
import { createMcpFetchPolicy, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";

/** Observe the bounded wire document before the SDK's OIDC schema drops extensions. */
export function withMcpOAuthMetadataObservation(
  fetch: typeof globalThis.fetch,
  observe: (url: URL, document: unknown) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" || !response.ok || !/\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(?:\/|$)/u.test(url.pathname)) return response;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (reader) while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 64 * 1024) throw new Error("OAuth metadata document exceeds its bounds.");
        chunks.push(part.value);
      }
      const document: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      observe(url, document);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(JSON.stringify(document), { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      await reader?.cancel(error).catch(() => undefined);
      throw error;
    }
  };
}

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
