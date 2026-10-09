import { parseMcpOAuthMetadataUrl } from "../../renderer/shared/mcp-oauth-config.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { buildDiscoveryUrls } from "@modelcontextprotocol/sdk/client/auth.js";

export interface McpOAuthSession {
  /** Normalized protected-resource URL this registration and tokens belong to. */
  authorizationBinding?: string;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** Last granted scopes survive token invalidation and explicit step-up sign-in. */
  grantedScope?: string;
  /**
   * Opaque id minted for each explicit (interactive) authorization. Background
   * token refreshes keep it, so it names the user's grant rather than whichever
   * access/refresh token pair currently represents it.
   */
  grantId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Validate decrypted session structure while retaining compatible future fields. */
export function parseMcpOAuthSession(value: unknown): McpOAuthSession {
  if (!isRecord(value)) throw new Error("MCP OAuth session must be a JSON object.");
  const session = structuredClone(value);
  if (
    session.authorizationBinding !== undefined &&
    (typeof session.authorizationBinding !== "string" || !session.authorizationBinding)
  ) {
    throw new Error("MCP OAuth authorization binding is malformed.");
  }
  if (session.codeVerifier !== undefined && typeof session.codeVerifier !== "string") {
    throw new Error("MCP OAuth PKCE verifier is malformed.");
  }
  if (session.grantedScope !== undefined && typeof session.grantedScope !== "string") {
    throw new Error("MCP OAuth granted scope is malformed.");
  }
  if (session.grantId !== undefined && (typeof session.grantId !== "string" || !session.grantId)) {
    throw new Error("MCP OAuth grant id is malformed.");
  }
  if (session.clientInformation !== undefined) {
    if (
      !isRecord(session.clientInformation) ||
      typeof session.clientInformation.client_id !== "string" ||
      !session.clientInformation.client_id ||
      (session.clientInformation.redirect_uris !== undefined &&
        (!Array.isArray(session.clientInformation.redirect_uris) ||
          !session.clientInformation.redirect_uris.every(
            (entry) => typeof entry === "string" && entry.length > 0,
          )))
    ) {
      throw new Error("MCP OAuth client information is malformed.");
    }
  }
  if (session.tokens !== undefined) {
    if (
      !isRecord(session.tokens) ||
      typeof session.tokens.access_token !== "string" ||
      !session.tokens.access_token ||
      typeof session.tokens.token_type !== "string" ||
      !session.tokens.token_type ||
      (session.tokens.refresh_token !== undefined &&
        typeof session.tokens.refresh_token !== "string") ||
      (session.tokens.scope !== undefined && typeof session.tokens.scope !== "string") ||
      (session.tokens.expires_in !== undefined &&
        (typeof session.tokens.expires_in !== "number" ||
          !Number.isFinite(session.tokens.expires_in) ||
          session.tokens.expires_in < 0))
    ) {
      throw new Error("MCP OAuth tokens are malformed.");
    }
  }
  return session as McpOAuthSession;
}

/**
 * Start an explicit Settings re-authorization without discarding the dynamic
 * client registration. The caller retains the original snapshot for rollback.
 */
export function mcpAuthorizationBinding(url: string, authServerMetadataUrl?: string, oauthClientName?: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const resource = parsed.toString();
  return authServerMetadataUrl === undefined && oauthClientName === undefined ? resource : JSON.stringify([resource, authServerMetadataUrl === undefined ? null : parseMcpOAuthMetadataUrl(authServerMetadataUrl), oauthClientName?.trim() ?? null]);
}

export function sessionMatchesMcpBinding(session: McpOAuthSession, binding: string): boolean {
  return session.authorizationBinding === binding;
}

/** Native PKCE clients are public clients; never retain a DCR client secret. */
export function publicMcpClientInformation(
  information: OAuthClientInformationFull,
): OAuthClientInformationFull {
  const {
    client_secret: _clientSecret,
    client_secret_expires_at: _clientSecretExpiry,
    ...publicInformation
  } = information;
  return publicInformation as OAuthClientInformationFull;
}

export function sessionForFreshMcpAuthorization(
  session: McpOAuthSession,
  binding: string,
): McpOAuthSession {
  if (!sessionMatchesMcpBinding(session, binding)) return { authorizationBinding: binding };
  const grantedScope = session.tokens?.scope || session.grantedScope;
  return {
    authorizationBinding: binding,
    ...(session.clientInformation ? { clientInformation: publicMcpClientInformation(session.clientInformation) } : {}),
    ...(grantedScope ? { grantedScope } : {}),
  };
}

/**
 * The replacement session an explicit Settings authorization starts from. It
 * carries a fresh grant id, so committing it is a grant change even when the
 * user signs in again with the same client registration and scopes.
 */
export function sessionForMcpAuthorizationAttempt(
  session: McpOAuthSession,
  binding: string,
): McpOAuthSession {
  return { ...sessionForFreshMcpAuthorization(session, binding), grantId: randomUUID() };
}

/** Merge tokens the SDK hands back (code exchange or refresh) into a bound session. */
export function sessionWithSavedMcpTokens(
  session: McpOAuthSession,
  binding: string,
  tokens: OAuthTokens,
  requestedScope?: string,
): McpOAuthSession {
  const grantedScope = tokens.scope || requestedScope || session.tokens?.scope || session.grantedScope;
  return {
    ...session,
    authorizationBinding: binding,
    tokens,
    ...(grantedScope ? { grantedScope } : {}),
  };
}

function normalizedScope(scope: string | undefined): string | null {
  const scopes = [...new Set((scope ?? "").split(/\s+/u).filter(Boolean))].sort();
  return scopes.length ? scopes.join(" ") : null;
}

/** Non-secret description of the authority an MCP OAuth session grants. */
export interface McpOAuthGrantIdentity {
  authorizationBinding: string | null;
  clientId: string | null;
  grantId: string | null;
  scope: string | null;
  authorized: boolean;
  refreshable: boolean;
}

/**
 * What "the same grant" means for Bot authority. Access tokens, their expiry
 * and (rotating) refresh tokens change on every routine refresh and are left
 * out. The grant is the resource binding, the client registration, the
 * explicit-authorization id, the granted scope, and whether a usable
 * (refreshable) token is held. Re-authorizing, signing out, a revoked token
 * (`invalidateCredentials("tokens")`), a new client registration, or a scope
 * change all change it.
 */
export function mcpOAuthGrantIdentity(session: McpOAuthSession): McpOAuthGrantIdentity | null {
  if (!hasMcpOAuthSessionData(session)) return null;
  return {
    authorizationBinding: session.authorizationBinding ?? null,
    clientId: session.clientInformation?.client_id ?? null,
    grantId: session.grantId ?? null,
    scope: normalizedScope(session.tokens?.scope || session.grantedScope),
    authorized: Boolean(session.tokens),
    refreshable: Boolean(session.tokens?.refresh_token),
  };
}

export function sameMcpOAuthGrant(left: McpOAuthSession, right: McpOAuthSession): boolean {
  return JSON.stringify(mcpOAuthGrantIdentity(left)) === JSON.stringify(mcpOAuthGrantIdentity(right));
}

/** Per-attempt state: never persisted or shared with another server's sign-in. */
export class McpOAuthAuthorizationFlow {
  readonly state = randomBytes(32).toString("hex");
  private discovery?: OAuthDiscoveryState;
  private expectedIssuer?: string;
  private issuerRequired = false;
  private started = false;
  private consumed = false;
  requestedScope?: string;
  private observedMetadata?: { url: string; issuer: string; issuerRequired: boolean };

  observeAuthorizationMetadata(url: URL, document: unknown): void {
    if (!isRecord(document) || typeof document.issuer !== "string") throw new Error("Invalid OAuth metadata issuer.");
    const supported = document.authorization_response_iss_parameter_supported;
    if (supported !== undefined && typeof supported !== "boolean") throw new Error("Invalid OAuth issuer response policy.");
    this.observedMetadata = { url: url.href, issuer: document.issuer, issuerRequired: supported === true };
  }

  saveDiscovery(state: OAuthDiscoveryState): void {
    const metadata = state.authorizationServerMetadata;
    if (metadata && metadata.issuer !== state.authorizationServerUrl) throw new Error("OAuth metadata issuer does not match the selected authorization server.");
    const discovery = structuredClone(state);
    const observed = this.observedMetadata;
    if (metadata && observed?.issuer === metadata.issuer && observed.issuerRequired &&
        buildDiscoveryUrls(state.authorizationServerUrl).some(({ url }) => url.href === observed.url)) {
      discovery.authorizationServerMetadata = { ...metadata, authorization_response_iss_parameter_supported: true };
    }
    this.discovery = discovery;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery ? structuredClone(this.discovery) : undefined;
  }

  clearDiscovery(): void {
    this.discovery = undefined;
    this.observedMetadata = undefined;
  }

  authorizationUrl(url: URL, grantedScope?: string): URL {
    if (url.searchParams.get("state") !== this.state) throw new Error("MCP OAuth state was not bound to this sign-in.");
    const result = new URL(url);
    const scopes = [...new Set([grantedScope, result.searchParams.get("scope")].filter(Boolean).join(" ").split(/\s+/u).filter(Boolean))];
    this.requestedScope = scopes.join(" ") || undefined;
    if (this.requestedScope) result.searchParams.set("scope", this.requestedScope);
    if (scopes.includes("offline_access") && !result.searchParams.has("prompt")) result.searchParams.set("prompt", "consent");
    const metadata = this.discovery?.authorizationServerMetadata;
    this.expectedIssuer = metadata?.issuer ?? this.discovery?.authorizationServerUrl;
    this.issuerRequired = metadata !== undefined && "authorization_response_iss_parameter_supported" in metadata &&
      metadata.authorization_response_iss_parameter_supported === true;
    this.started = true;
    return result;
  }

  callback(url: URL): { code: string } | { error: Error } {
    if (!this.started || this.consumed || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== this.state) {
      throw new Error("Invalid OAuth callback state.");
    }
    const issuers = url.searchParams.getAll("iss");
    if (issuers.length > 1 || (this.issuerRequired && issuers.length !== 1) ||
        (issuers.length === 1 && (!this.expectedIssuer || issuers[0] !== this.expectedIssuer))) {
      throw new Error("Invalid OAuth callback issuer.");
    }
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (codes.length + errors.length !== 1 || !(codes[0] || errors[0])) throw new Error("Invalid OAuth callback result.");
    this.consumed = true;
    return errors.length ? { error: new Error("Authorization was denied by the provider.") } : { code: codes[0] };
  }
}

export function hasMcpOAuthSessionData(session: McpOAuthSession): boolean {
  return Boolean(
    session.authorizationBinding ||
    session.clientInformation ||
    session.tokens ||
    session.codeVerifier,
  );
}

/** Keep an interactive replacement session private until verification succeeds. */
export class McpOAuthSessionTransaction {
  private session: McpOAuthSession;

  constructor(initial: McpOAuthSession) {
    this.session = structuredClone(initial);
  }

  read(): McpOAuthSession {
    return structuredClone(this.session);
  }

  replace(session: McpOAuthSession): void {
    this.session = structuredClone(session);
  }
}
