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

/**
 * Start an explicit Settings re-authorization without discarding the dynamic
 * client registration. The caller retains the original snapshot for rollback.
 */
export function mcpAuthorizationBinding(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

export function sessionMatchesMcpBinding(
  session: McpOAuthSession,
  binding: string,
): boolean {
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
