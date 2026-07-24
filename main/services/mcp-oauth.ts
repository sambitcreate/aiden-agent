// OAuth 2.0 (PKCE + dynamic client registration) for remote MCP servers, per the
// MCP authorization spec. Uses the official SDK's `OAuthClientProvider` contract
// and a loopback redirect (RFC 8252 native-app flow): we open the provider's
// consent page in the user's browser and capture the authorization code on a
// short-lived localhost server.

import * as http from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { shell, logger } from "../platform.js";
import { mcpOAuthStore } from "./mcp-oauth-store.js";
import {
  hasMcpOAuthSessionData,
  mcpAuthorizationBinding,
  publicMcpClientInformation,
  sessionMatchesMcpBinding,
  sessionForFreshMcpAuthorization,
} from "./mcp-oauth-session.js";
import { McpOAuthOperationGate } from "./mcp-oauth-operation.js";
import { assertMcpPresetServer } from "./mcp-presets.js";
import type { McpServer } from "./types.js";

// Fixed loopback redirect so the registered redirect_uri stays stable across
// sessions (dynamic client registration records it once).
const OAUTH_PORT = 41390;
const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/callback`;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const oauthOperations = new McpOAuthOperationGate();

const CALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Aiden Agent</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#1c1c1e;color:#fff;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}
h1{font-size:17px;font-weight:600;margin:0 0 6px}p{font-size:13px;color:#98989d;margin:0}</style></head>
<body><div><h1>Connected</h1><p>You can return to Aiden Agent and close this tab.</p></div></body></html>`;

/**
 * SDK OAuthClientProvider backed by the encrypted session store. One instance
 * per MCP server id; `redirectToAuthorization` opens the system browser.
 */
class McpOAuthProvider implements OAuthClientProvider {
  /**
   * @param interactive When false (background connections during chat), the flow
   * must never open a browser — an expired/absent session fails loudly instead so
   * the user can re-authorize from Settings on their own terms.
   */
  constructor(
    private readonly serverId: string,
    private readonly binding: string,
    private readonly interactive = false,
  ) {}

  private async boundSession() {
    const session = await mcpOAuthStore.get(this.serverId);
    return sessionMatchesMcpBinding(session, this.binding)
      ? session
      : { authorizationBinding: this.binding };
  }

  private assertCanMutate(): void {
    oauthOperations.assertMutationAllowed(this.serverId, this.interactive);
  }

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Aiden Agent",
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const information = (await this.boundSession()).clientInformation;
    return information ? publicMcpClientInformation(information) : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    await mcpOAuthStore.set(this.serverId, {
      ...session,
      authorizationBinding: this.binding,
      clientInformation: publicMcpClientInformation(info),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.boundSession()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    await mcpOAuthStore.set(this.serverId, {
      ...session,
      authorizationBinding: this.binding,
      tokens,
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.assertCanMutate();
    const session = await this.boundSession();
    this.assertCanMutate();
    await mcpOAuthStore.set(this.serverId, {
      ...session,
      authorizationBinding: this.binding,
      codeVerifier,
    });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.boundSession()).codeVerifier;
    if (!verifier) throw new Error("Missing PKCE code verifier — restart the sign-in.");
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      throw new Error("This MCP server needs sign-in. Open Settings → MCP and click Authorize.");
    }
    await shell.openExternal(authorizationUrl.toString());
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    this.assertCanMutate();
    if (scope === "all") {
      await mcpOAuthStore.clear(this.serverId);
      return;
    }
    const session = await this.boundSession();
    this.assertCanMutate();
    if (scope === "tokens") delete session.tokens;
    if (scope === "verifier") delete session.codeVerifier;
    if (scope === "client") delete session.clientInformation;
    await mcpOAuthStore.set(this.serverId, session);
  }
}

/** Build a remote transport wired with an OAuth provider for the given server. */
export function makeOAuthTransport(server: McpServer, provider: OAuthClientProvider): StreamableHTTPClientTransport | SSEClientTransport {
  assertMcpPresetServer(server);
  if (!server.url) throw new Error("This MCP server needs a URL.");
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.transport === "sse") {
    return new SSEClientTransport(url, { authProvider: provider, requestInit });
  }
  return new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit });
}

/** Provider for background (non-interactive) connections — attaches stored tokens. */
export function oauthProviderFor(server: McpServer): OAuthClientProvider {
  if (!server.url) throw new Error("This MCP server needs a URL.");
  return new McpOAuthProvider(server.id, mcpAuthorizationBinding(server.url));
}

export async function hasOAuthTokens(serverId: string, url?: string): Promise<boolean> {
  const session = await mcpOAuthStore.get(serverId);
  if (url && !sessionMatchesMcpBinding(session, mcpAuthorizationBinding(url))) return false;
  return Boolean(session.tokens);
}

export async function clearOAuth(serverId: string): Promise<void> {
  await mcpOAuthStore.clear(serverId);
}

interface Loopback {
  waitForCode: () => Promise<string>;
  close: () => void;
}

function startLoopbackServer(): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", OAUTH_REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_HTML);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) rejectCode(new Error(`Authorization denied: ${url.searchParams.get("error_description") || error}`));
      else if (code) resolveCode(code);
      else rejectCode(new Error("No authorization code was returned."));
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${OAUTH_PORT} is busy — close whatever is using it and try again.`)
          : err,
      );
    });

    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      const timer = setTimeout(() => rejectCode(new Error("Sign-in timed out.")), AUTH_TIMEOUT_MS);
      resolve({
        waitForCode: () => codePromise.finally(() => clearTimeout(timer)),
        close: () => server.close(),
      });
    });
  });
}

/**
 * Run the interactive OAuth flow for a remote MCP server: open the browser,
 * capture the code on the loopback, exchange it, and verify the connection.
 * Tokens land in the encrypted store for future connections.
 */
export async function authorizeMcpServer(server: McpServer): Promise<void> {
  assertMcpPresetServer(server);
  if (server.transport === "stdio") throw new Error("OAuth applies only to remote (HTTP/SSE) MCP servers.");
  if (!server.url) throw new Error("Add the server URL before authorizing.");

  const binding = mcpAuthorizationBinding(server.url);
  oauthOperations.begin(server.id);
  const previousSession = await mcpOAuthStore.get(server.id);
  const provider = new McpOAuthProvider(server.id, binding, true);
  let loopback: Loopback | null = null;
  try {
    loopback = await startLoopbackServer();
    // This call comes from an explicit Settings action. Preserve dynamic client
    // registration, but remove tokens/verifier so "Re-authorize" always opens a
    // fresh browser flow instead of silently accepting the existing session.
    await mcpOAuthStore.set(
      server.id,
      sessionForFreshMcpAuthorization(previousSession, binding),
    );
    const transport = makeOAuthTransport(server, provider);
    const client = new Client({ name: "aiden-agent", version: "0.27.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await client.close().catch(() => {});
      return;
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      // Expected: connect() triggered redirectToAuthorization (browser opened).
    }

    const code = await loopback.waitForCode();
    await transport.finishAuth(code);

    // Verify the freshly minted tokens actually authorize a connection.
    const verifyTransport = makeOAuthTransport(server, provider);
    const verifyClient = new Client({ name: "aiden-agent", version: "0.27.0" }, { capabilities: {} });
    await verifyClient.connect(verifyTransport);
    await verifyClient.close().catch(() => {});
  } catch (error) {
    try {
      if (hasMcpOAuthSessionData(previousSession)) {
        await mcpOAuthStore.set(server.id, previousSession);
      } else {
        await mcpOAuthStore.clear(server.id);
      }
    } catch (restoreError) {
      logger.error("mcp-oauth", `Failed to restore the previous OAuth session for "${server.name}".`, restoreError);
    }
    logger.warn("mcp-oauth", `Authorization failed for "${server.name}": ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    loopback?.close();
    oauthOperations.end(server.id);
  }
}
