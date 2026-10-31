import {
  discoverProtectedResourceMetadata,
  type AuthorizationServerMetadata,
  type OAuthDiscoveryState,
  type OAuthProtectedResourceMetadata,
} from "@earendil-works/pi-mcp/oauth";
import { parseMcpOAuthMetadataUrl } from "../../renderer/shared/mcp-oauth-config.js";
import { createMcpFetchPolicy, type McpFetchPolicyOptions } from "./mcp-fetch-policy.js";

const OPTIONAL_STRING_ARRAYS = [
  "scopes_supported", "response_modes_supported", "grant_types_supported",
  "token_endpoint_auth_methods_supported", "token_endpoint_auth_signing_alg_values_supported",
  "revocation_endpoint_auth_methods_supported", "revocation_endpoint_auth_signing_alg_values_supported",
  "introspection_endpoint_auth_methods_supported", "introspection_endpoint_auth_signing_alg_values_supported",
  "code_challenge_methods_supported",
] as const;
const OPTIONAL_STRINGS = ["registration_endpoint", "service_documentation", "revocation_endpoint", "introspection_endpoint"] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** RFC 8414 authorization-server metadata, structurally checked; unknown members are kept. */
export function parseMcpAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const document = value as Record<string, unknown>;
  if (typeof document.issuer !== "string" || typeof document.authorization_endpoint !== "string" ||
      typeof document.token_endpoint !== "string" || !isStringArray(document.response_types_supported)) return undefined;
  if (OPTIONAL_STRINGS.some((key) => document[key] !== undefined && typeof document[key] !== "string")) return undefined;
  if (OPTIONAL_STRING_ARRAYS.some((key) => document[key] !== undefined && !isStringArray(document[key]))) return undefined;
  if (document.client_id_metadata_document_supported !== undefined && typeof document.client_id_metadata_document_supported !== "boolean") return undefined;
  return document as AuthorizationServerMetadata;
}

/**
 * Pi's adapted OAuth provider never passes a metadata override to the flow;
 * the provider's discovery-state hook hands it trusted metadata (plus the
 * service's own protected-resource metadata) instead.
 */
export async function loadMcpOAuthMetadataOverride(metadataUrl: string, options: McpFetchPolicyOptions): Promise<OAuthDiscoveryState> {
  const url = parseMcpOAuthMetadataUrl(metadataUrl);
  const fetch = createMcpFetchPolicy({ ...options, maximumBytes: 64 * 1024 });
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OAuth metadata request failed (HTTP ${response.status}).`);
  }
  const metadata = parseMcpAuthorizationServerMetadata(await response.json());
  if (!metadata) throw new Error("OAuth metadata document is invalid.");
  // Configured documents may describe a different issuer, but cannot redirect
  // browser or token traffic to non-web protocols, plaintext remote hosts, or credentials.
  for (const endpoint of [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
    if (endpoint !== undefined) parseMcpOAuthMetadataUrl(endpoint);
  }
  // The protected resource still names the `resource` indicator and its
  // scopes; only the authorization server it advertises is overridden. A
  // missing document is tolerated as in discovery; a network failure is not.
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    resourceMetadata = await discoverProtectedResourceMetadata(options.serviceUrl, { fetch });
  } catch (error) {
    if (error instanceof TypeError) throw error;
  }
  return {
    authorizationServerUrl: metadata.issuer,
    authorizationServerMetadata: metadata,
    ...(resourceMetadata ? { resourceMetadata } : {}),
  };
}
