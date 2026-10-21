// SDK-era OAuth workarounds the CLI still needs while it runs its own
// `@modelcontextprotocol/sdk` OAuth provider. The desktop moved to Pi's
// `pi-mcp/oauth`, which handles all of this itself, so these left the shared
// fetch policy. Delete this module when the CLI moves to the shared provider
// (docs/plans/mcp-pi-migration-plan.md, Phase 3).

import { buildAuthorizationServerDiscoveryUrls } from "@earendil-works/pi-mcp/oauth";

type FetchLike = typeof globalThis.fetch;

function rebuild(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** SDK 1.30 rejects token responses that encode absent optional values as `null` or `""`. */
async function normalizeTokenResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OAuth token response.");
  const tokens = value as Record<string, unknown>;
  if (typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.token_type !== "string" || !tokens.token_type) {
    throw new Error("OAuth token response is missing required credentials.");
  }
  for (const key of ["scope", "refresh_token", "id_token", "expires_in"]) {
    if (tokens[key] === null || tokens[key] === "") delete tokens[key];
  }
  if (tokens.expires_in !== undefined) {
    if ((typeof tokens.expires_in !== "string" && typeof tokens.expires_in !== "number") || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) < 0) {
      throw new Error("Invalid OAuth token lifetime.");
    }
    tokens.expires_in = Number(tokens.expires_in);
  }
  return rebuild(response, JSON.stringify(tokens));
}

const REGISTRATION_REQUIRED = new Set(["client_id", "redirect_uris"]);
const METADATA_REQUIRED = new Set(["issuer", "authorization_endpoint", "token_endpoint", "response_types_supported"]);
const METADATA_PATH = /\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(?:\/|$)/u;

/** SDK 1.30 rejects registration and metadata documents with `null`/`""` optional members. */
async function normalizeOptionalFields(response: Response, required: ReadonlySet<string>): Promise<Response> {
  if (!response.ok) return response;
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return rebuild(response, text); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return rebuild(response, text);
  const document = value as Record<string, unknown>;
  for (const [key, member] of Object.entries(document)) {
    if (!required.has(key) && (member === null || member === "")) delete document[key];
  }
  return rebuild(response, JSON.stringify(document));
}

/** SDK 1.30 reads `scope=""` in a challenge as the scope `""`; drop empty scope parameters. */
function withoutEmptyChallengeScope(header: string): string {
  return header
    .replace(/(^|[\s,])scope=(?:"\s*"|'\s*'|(?=,|\s|$))\s*,?/giu, "$1")
    .replace(/[\s,]+$/u, "")
    .replace(/\s{2,}/gu, " ");
}

function formGrant(init: RequestInit | undefined): string | null {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return null;
  const body = init?.body;
  return typeof body === "string" || body instanceof URLSearchParams ? new URLSearchParams(body).get("grant_type") : null;
}

/** Apply the SDK compatibility rewrites to OAuth responses (MCP traffic passes through). */
export function withSdkOAuthCompat(fetch: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const challenge = response.headers.get("www-authenticate");
    if ((response.status === 401 || response.status === 403) && challenge) {
      const rewritten = withoutEmptyChallengeScope(challenge);
      if (rewritten !== challenge) {
        const headers = new Headers(response.headers);
        headers.set("www-authenticate", rewritten);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
    }
    const grant = formGrant(init);
    if (grant === "authorization_code" || grant === "refresh_token") return normalizeTokenResponse(response);
    if (method === "GET" && METADATA_PATH.test(url.pathname)) return normalizeOptionalFields(response, METADATA_REQUIRED);
    const contentType = new Headers(init?.headers).get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const jsonRpc = typeof init?.body === "string" && /"jsonrpc"\s*:/u.test(init.body);
    if (method === "POST" && contentType === "application/json" && !jsonRpc) return normalizeOptionalFields(response, REGISTRATION_REQUIRED);
    return response;
  };
}

/**
 * SDK 1.30's OIDC metadata parsing drops `authorization_response_iss_parameter_supported`.
 * Remember it from the wire document so the CLI can still require `iss` on the callback.
 */
export class SdkIssuerPolicyObserver {
  private observed?: { url: string; issuer: string; issuerRequired: boolean };

  wrap(fetch: FetchLike): FetchLike {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = await fetch(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" || !response.ok || !METADATA_PATH.test(url.pathname)) return response;
      const text = await response.text();
      try {
        const document = JSON.parse(text) as { issuer?: unknown; authorization_response_iss_parameter_supported?: unknown };
        if (typeof document.issuer === "string") {
          this.observed = { url: url.href, issuer: document.issuer, issuerRequired: document.authorization_response_iss_parameter_supported === true };
        }
      } catch {
        // Not JSON: the SDK reports it.
      }
      return rebuild(response, text);
    };
  }

  /** The discovery state with the observed issuer policy restored, when it came from a discovery URL of that server. */
  apply<State extends { authorizationServerUrl: string; authorizationServerMetadata?: { issuer: string } }>(state: State): State {
    const metadata = state.authorizationServerMetadata;
    const observed = this.observed;
    if (!metadata || observed?.issuer !== metadata.issuer || !observed.issuerRequired) return state;
    if (!buildAuthorizationServerDiscoveryUrls(state.authorizationServerUrl).some(({ url }) => url.href === observed.url)) return state;
    return { ...state, authorizationServerMetadata: { ...metadata, authorization_response_iss_parameter_supported: true } };
  }
}
