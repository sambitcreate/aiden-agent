import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpOAuthSession {
  /** Normalized protected-resource URL this registration and tokens belong to. */
  authorizationBinding?: string;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
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
export function mcpAuthorizationBinding(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
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
  return sessionMatchesMcpBinding(session, binding) && session.clientInformation
    ? {
        authorizationBinding: binding,
        clientInformation: publicMcpClientInformation(session.clientInformation),
      }
    : { authorizationBinding: binding };
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
