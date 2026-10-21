import { parseMcpOAuthMetadataUrl } from "../../renderer/shared/mcp-oauth-config.js";
import {
  type OAuthClientInformationMixed,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@earendil-works/pi-mcp/oauth";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface McpOAuthSession {
  /** Normalized protected-resource URL this registration and tokens belong to. */
  authorizationBinding?: string;
  clientInformation?: OAuthClientInformationMixed;
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
  /**
   * The refresh token a background connection saw rejected (`invalid_grant`)
   * and removed, as a hash. Another client (a second CLI process) may have
   * presented the same token a moment earlier and received its rotation; its
   * late save may restore the new tokens while nothing newer is stored. See
   * `sessionWithRefreshedMcpTokens`.
   */
  rejectedRefresh?: McpRejectedRefresh;
}

export interface McpRejectedRefresh {
  /** SHA-256 (hex) of the rejected refresh token. */
  refreshTokenHash: string;
  /** The grant the rejected tokens belonged to. */
  grantId?: string;
  /** When the tokens were removed (ms since the epoch). */
  at: number;
}

/** The tokens a provider last read or received, and the grant they belonged to. */
export type McpObservedTokens = Pick<OAuthTokens, "access_token" | "refresh_token"> & { grantId?: string };

/**
 * How long after a rejected refresh a concurrent rotation of the same refresh
 * token may still be restored. A token response older than this is stale.
 */
export const MCP_REJECTED_REFRESH_RESTORE_MS = 5 * 60_000;

function refreshTokenHash(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
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
  if (session.rejectedRefresh !== undefined) {
    const marker = session.rejectedRefresh;
    // Advisory only: a malformed marker is dropped rather than failing the session.
    if (
      !isRecord(marker) ||
      typeof marker.refreshTokenHash !== "string" || !/^[0-9a-f]{64}$/u.test(marker.refreshTokenHash) ||
      (marker.grantId !== undefined && (typeof marker.grantId !== "string" || !marker.grantId)) ||
      typeof marker.at !== "number" || !Number.isFinite(marker.at)
    ) {
      delete session.rejectedRefresh;
    }
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
    const { client_secret: secret, client_secret_expires_at: secretExpiry } = session.clientInformation;
    if (
      (secret !== undefined && (typeof secret !== "string" || !secret)) ||
      (secretExpiry !== undefined && (typeof secretExpiry !== "number" || !Number.isFinite(secretExpiry) || secretExpiry < 0))
    ) {
      throw new Error("MCP OAuth client secret is malformed.");
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
 * What stored registrations and tokens belong to: the protected resource, an
 * explicit authorization-metadata document, and the OAuth client identity
 * (`clientIdentity`, see `mcpOAuthClientIdentityKey`). Changing any of them
 * leaves the old session unmatched, so it is never reused.
 */
export function mcpAuthorizationBinding(url: string, authServerMetadataUrl?: string, clientIdentity?: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const resource = parsed.toString();
  return authServerMetadataUrl === undefined && clientIdentity === undefined ? resource : JSON.stringify([resource, authServerMetadataUrl === undefined ? null : parseMcpOAuthMetadataUrl(authServerMetadataUrl), clientIdentity ?? null]);
}

export function sessionMatchesMcpBinding(session: McpOAuthSession, binding: string): boolean {
  return session.authorizationBinding === binding;
}

/**
 * The stored dynamic client registration, or undefined when the server-issued
 * client secret has expired (RFC 7591 `client_secret_expires_at`, seconds; 0
 * means it never expires) so the SDK registers again. Confidential-only
 * servers (Figma, Vercel, Supabase) need the secret at the token endpoint, so
 * it stays in the encrypted session and is handed back to the SDK.
 */
export function usableMcpClientInformation(
  information: OAuthClientInformationMixed | undefined,
  nowMs: number = Date.now(),
): OAuthClientInformationMixed | undefined {
  const expiresAt = information?.client_secret_expires_at;
  if (information?.client_secret && typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1000 <= nowMs) {
    return undefined;
  }
  return information;
}

/** Persist a registration response (including any client secret) into a bound session. */
export function sessionWithMcpClientInformation(
  session: McpOAuthSession,
  binding: string,
  information: OAuthClientInformationMixed,
): McpOAuthSession {
  const clientInformation = structuredClone(information);
  // Public clients sometimes come back with `"client_secret": ""`; keeping it
  // would read as a secret at the token endpoint and fail the stored parse.
  if (typeof clientInformation.client_secret !== "string" || !clientInformation.client_secret) {
    delete clientInformation.client_secret;
    delete clientInformation.client_secret_expires_at;
  } else {
    const expiry: unknown = clientInformation.client_secret_expires_at;
    if (expiry !== undefined && (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry < 0)) {
      delete clientInformation.client_secret_expires_at;
    }
  }
  return { ...session, authorizationBinding: binding, clientInformation };
}

/**
 * Start an explicit Settings re-authorization. Tokens, the PKCE verifier and
 * the stored client registration are all left behind: a server may have
 * dropped the old client_id (and then never calls back), so every interactive
 * sign-in registers a fresh client. Granted scopes carry over for step-up. The
 * caller retains the original snapshot for rollback.
 */
export function sessionForFreshMcpAuthorization(
  session: McpOAuthSession,
  binding: string,
): McpOAuthSession {
  if (!sessionMatchesMcpBinding(session, binding)) return { authorizationBinding: binding };
  const grantedScope = session.tokens?.scope || session.grantedScope;
  return {
    authorizationBinding: binding,
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
  const { rejectedRefresh: _supersededByNewTokens, ...rest } = session;
  return {
    ...rest,
    authorizationBinding: binding,
    tokens,
    ...(grantedScope ? { grantedScope } : {}),
  };
}

/**
 * Whether a refresh that presented `observed` may restore its response into a
 * session whose tokens a concurrent client removed after its own attempt with
 * the same refresh token was rejected (the server had just rotated it for
 * this client). Only while nothing newer is stored, for the same grant, and
 * within the restore window. A sign-out clears the whole session and a
 * re-authorization mints a new grant, so neither leaves a matching marker.
 */
function mayRestoreRejectedRefresh(session: McpOAuthSession, observed: McpObservedTokens, nowMs: number): boolean {
  const marker = session.rejectedRefresh;
  return Boolean(
    marker && !session.tokens && observed.refresh_token &&
    marker.refreshTokenHash === refreshTokenHash(observed.refresh_token) &&
    marker.grantId === observed.grantId && session.grantId === observed.grantId &&
    nowMs >= marker.at && nowMs - marker.at <= MCP_REJECTED_REFRESH_RESTORE_MS,
  );
}

/**
 * Compare-and-set for tokens a background refresh returned. The refresh
 * presented the tokens this client last observed; if the stored pair has since
 * changed (another client rotated, re-authorized or signed out), the response
 * is older than what is persisted and must not replace it. The one exception:
 * a concurrent client presented the same refresh token after this one, was
 * rejected because the server had already rotated it for this refresh, and
 * removed the pair; this response is then the grant's only live tokens and
 * is restored (see `mayRestoreRejectedRefresh`). Returns undefined when the
 * stored session should be kept as is.
 */
export function sessionWithRefreshedMcpTokens(
  session: McpOAuthSession,
  binding: string,
  observed: McpObservedTokens | undefined,
  tokens: OAuthTokens,
  requestedScope?: string,
  nowMs: number = Date.now(),
): McpOAuthSession | undefined {
  const stored = session.tokens;
  if (observed && (stored?.access_token !== observed.access_token || stored?.refresh_token !== observed.refresh_token) &&
      !mayRestoreRejectedRefresh(session, observed, nowMs)) {
    return undefined;
  }
  return sessionWithSavedMcpTokens(session, binding, tokens, requestedScope);
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

/** Scope tokens from challenges or saved grants; quote-only remnants such as `""` are not scopes. */
export function mcpScopeTokens(...scopes: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(scopes.filter(Boolean).join(" ").split(/\s+/u).filter((token) => token && !/^["']*$/u.test(token)))];
}

/**
 * Issuer comparison. A root issuer (`https://host` vs `https://host/`) is
 * compared after removing one trailing slash: without protected-resource
 * metadata the SDK falls back to `new URL("/", serverUrl)`, which always ends
 * in `/`. Path issuers (tenants) stay exact, so `/tenant` never equals `/tenant/`.
 */
export function sameMcpOAuthIssuer(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (left === right) return true;
  const root = (value: string) => {
    try {
      const url = new URL(value);
      return (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash ? `${url.protocol}//${url.host}` : undefined;
    } catch {
      return undefined;
    }
  };
  const a = root(left);
  return a !== undefined && a === root(right) && [left, right].every((value) => value === a || value === `${a}/`);
}

/**
 * Step-up scopes a server demanded with `403 insufficient_scope`. Background
 * connections cannot open a browser, and the SDK keeps the challenge only on
 * the transport, so the next interactive Settings authorization would start
 * from the 401 challenge again. Bounded, in memory, keyed by service URL.
 */
const MAX_STEP_UP_SERVERS = 64;
const stepUpScopes = new Map<string, string>();

function stepUpKey(serviceUrl: string): string | undefined {
  try { return mcpAuthorizationBinding(serviceUrl); } catch { return undefined; }
}

export function recordMcpStepUpScope(serviceUrl: string, scope: string): void {
  const key = stepUpKey(serviceUrl);
  const tokens = mcpScopeTokens(scope);
  if (!key || tokens.length === 0) return;
  const merged = mcpScopeTokens(stepUpScopes.get(key), ...tokens).join(" ");
  stepUpScopes.delete(key);
  stepUpScopes.set(key, merged);
  while (stepUpScopes.size > MAX_STEP_UP_SERVERS) stepUpScopes.delete(stepUpScopes.keys().next().value!);
}

/** Granted scopes plus any recorded step-up challenge, for an interactive authorization. */
export function mcpInteractiveAuthorizationScope(serviceUrl: string | undefined, grantedScope: string | undefined): string | undefined {
  const key = serviceUrl === undefined ? undefined : stepUpKey(serviceUrl);
  return mcpScopeTokens(grantedScope, key ? stepUpScopes.get(key) : undefined).join(" ") || undefined;
}

/** Forget a step-up challenge once an interactive authorization has committed. */
export function clearMcpStepUpScope(serviceUrl: string | undefined): void {
  const key = serviceUrl === undefined ? undefined : stepUpKey(serviceUrl);
  if (key) stepUpScopes.delete(key);
}

/**
 * `invalidateCredentials("tokens")` as compare-and-delete. The SDK invalidates
 * after `invalid_grant`, but a concurrent client (status check, child agent,
 * Bot catalog) may already have rotated and saved newer tokens. Delete only
 * when the stored tokens are the ones this provider last observed; otherwise
 * the stale caller would sign the user out of a working grant.
 */
export function sessionAfterTokenInvalidation(
  session: McpOAuthSession,
  observed: McpObservedTokens | undefined,
  nowMs: number = Date.now(),
): McpOAuthSession | undefined {
  const stored = session.tokens;
  if (!stored) return undefined;
  if (observed && (stored.access_token !== observed.access_token || stored.refresh_token !== observed.refresh_token)) {
    return undefined;
  }
  const next = structuredClone(session);
  if (stored.scope) next.grantedScope = stored.scope;
  delete next.tokens;
  // Remember which refresh token was given up on, so a concurrent client's
  // rotation of that same token can still land (sessionWithRefreshedMcpTokens).
  if (stored.refresh_token) {
    next.rejectedRefresh = {
      refreshTokenHash: refreshTokenHash(stored.refresh_token),
      ...(session.grantId ? { grantId: session.grantId } : {}),
      at: nowMs,
    };
  } else {
    delete next.rejectedRefresh;
  }
  return next;
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
  /**
   * The `iss` to hand the code exchange (RFC 9207) once this flow validated
   * the callback's issuer: the discovered metadata's own issuer, so a root
   * issuer's trailing-slash spelling cannot fail the exchange's exact check.
   */
  responseIssuer?: string;

  saveDiscovery(state: OAuthDiscoveryState): void {
    const metadata = state.authorizationServerMetadata;
    if (metadata && !sameMcpOAuthIssuer(metadata.issuer, state.authorizationServerUrl)) throw new Error("OAuth metadata issuer does not match the selected authorization server.");
    this.discovery = structuredClone(state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery ? structuredClone(this.discovery) : undefined;
  }

  clearDiscovery(): void {
    this.discovery = undefined;
  }

  authorizationUrl(url: URL, grantedScope?: string): URL {
    if (url.searchParams.get("state") !== this.state) throw new Error("MCP OAuth state was not bound to this sign-in.");
    const result = new URL(url);
    const scopes = mcpScopeTokens(grantedScope, result.searchParams.get("scope"));
    this.requestedScope = scopes.join(" ") || undefined;
    if (this.requestedScope) result.searchParams.set("scope", this.requestedScope);
    else result.searchParams.delete("scope");
    // Pi asks for consent when its own scope includes offline_access; a
    // granted scope merged in here can add it, so apply the same rule.
    if (scopes.includes("offline_access") && !result.searchParams.has("prompt")) result.searchParams.set("prompt", "consent");
    const metadata = this.discovery?.authorizationServerMetadata;
    this.expectedIssuer = metadata?.issuer ?? this.discovery?.authorizationServerUrl;
    this.issuerRequired = metadata !== undefined && "authorization_response_iss_parameter_supported" in metadata &&
      metadata.authorization_response_iss_parameter_supported === true;
    this.started = true;
    return result;
  }

  /**
   * Options for exchanging this sign-in's authorization code: the validated
   * response issuer, and the scope the browser was actually sent to. Without
   * that scope the flow records its own recomputed one on tokens whose
   * response omits `scope`, which would drop scopes granted earlier.
   */
  codeExchange(code: string): { authorizationCode: string; iss?: string; scope?: string } {
    return {
      authorizationCode: code,
      ...(this.responseIssuer === undefined ? {} : { iss: this.responseIssuer }),
      ...(this.requestedScope ? { scope: this.requestedScope } : {}),
    };
  }

  callback(url: URL): { code: string } | { error: Error } {
    if (!this.started || this.consumed || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== this.state) {
      throw new Error("Invalid OAuth callback state.");
    }
    const issuers = url.searchParams.getAll("iss");
    if (issuers.length > 1 || (this.issuerRequired && issuers.length !== 1) ||
        (issuers.length === 1 && !sameMcpOAuthIssuer(issuers[0], this.expectedIssuer))) {
      throw new Error("Invalid OAuth callback issuer.");
    }
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (codes.length + errors.length !== 1 || !(codes[0] || errors[0])) throw new Error("Invalid OAuth callback result.");
    this.consumed = true;
    this.responseIssuer = issuers.length === 1 ? this.discovery?.authorizationServerMetadata?.issuer : undefined;
    return errors.length
      ? { error: new McpOAuthCallbackError(errors[0], url.searchParams.get("error_description") ?? undefined) }
      : { code: codes[0] };
  }
}

const MAX_CALLBACK_DESCRIPTION_CHARS = 300;

/** Text from an OAuth server shown to the user: one line, no control characters, bounded. */
export function mcpOAuthDisplayText(value: string | undefined, maximum: number = MAX_CALLBACK_DESCRIPTION_CHARS): string | undefined {
  const line = value === undefined ? undefined : [...value]
    .map((char) => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) ? " " : char; })
    .join("").replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

/**
 * The authorization server redirected back with `error=` (RFC 6749 §4.1.2.1).
 * `code` is the OAuth error code; `description` is the server's sanitized
 * `error_description`, if it sent one.
 */
export class McpOAuthCallbackError extends Error {
  readonly code: string;
  readonly description?: string;

  constructor(code: string, description?: string) {
    const safeCode = /^[\w.-]{1,64}$/u.test(code) ? code : "invalid_response";
    const detail = mcpOAuthDisplayText(description);
    super(
      safeCode === "access_denied"
        ? `Sign-in was denied in the browser${detail ? `: ${detail}` : "."}`
        : `The authorization server returned “${safeCode}”${detail ? `: ${detail}` : "."}`,
    );
    this.name = "McpOAuthCallbackError";
    this.code = safeCode;
    this.description = detail;
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

/** What Settings shows for a server's stored browser sign-in. */
export interface McpOAuthSignInState {
  /** Tokens are stored for the server's current binding. */
  authorized: boolean;
  /**
   * A sign-in for the current binding lost its tokens (the server rejected
   * them, for example with `invalid_grant`). Read from the stored session, so
   * it survives restarts.
   */
  needsSignIn: boolean;
  /** Anything is stored for the server, matching its binding or not: Sign out can remove it. */
  hasSession: boolean;
}

export function mcpOAuthSignInState(session: McpOAuthSession, binding: string | undefined): McpOAuthSignInState {
  const hasSession = hasMcpOAuthSessionData(session);
  if (binding === undefined || !sessionMatchesMcpBinding(session, binding)) {
    return { authorized: false, needsSignIn: false, hasSession };
  }
  const authorized = Boolean(session.tokens);
  return { authorized, needsSignIn: !authorized && Boolean(session.grantId || session.grantedScope), hasSession };
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
