// Test support: a local OAuth authorization server plus a protected MCP
// endpoint on 127.0.0.1, configurable per case. What it observed (requests,
// registrations, token requests and their verdicts) is the oracle for the
// MCP OAuth tests; nothing here imports production OAuth code.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOAuthServerOptions {
  /** `token_endpoint_auth_methods_supported`. Default `["none"]`. */
  authMethods?: string[];
  /** Registration responses include a client secret. */
  issueSecret?: boolean;
  /** The token endpoint rejects clients that do not present their secret. */
  requireSecret?: boolean;
  /** Offer dynamic registration. Default true. */
  registration?: boolean;
  /** Advertise `client_id_metadata_document_supported` and accept this URL as a client id. */
  cimdClientId?: string;
  /** A client registered by hand (no dynamic registration needed). */
  preRegistered?: { clientId: string; clientSecret?: string };
  /** `scopes_supported` in the protected-resource metadata. */
  scopesSupported?: string[];
  /** Token responses leave out `scope`. */
  omitTokenScope?: boolean;
  /** The MCP endpoint accepts requests without a token. */
  anonymousInitialize?: boolean;
  /** The 401 challenge carries `scope=""`. */
  emptyChallengeScope?: boolean;
  /** The protected-resource metadata document answers with a redirect. */
  metadataRedirect?: "same-origin" | "cross-origin";
  /** `/authorize` sends the browser back with this OAuth error instead of a code. */
  denyAuthorization?: { error: string; description?: string };
}

export interface FakeTokenRequest {
  grant: string;
  clientId: string | null;
  presentedSecret: boolean;
  /** `basic`, `post` or `none`. */
  authMethod: "basic" | "post" | "none";
  status: number;
  error?: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

interface Client {
  secret?: string;
  redirectUris: string[];
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function startFakeOAuthServer(options: FakeOAuthServerOptions = {}) {
  const clients = new Map<string, Client>();
  if (options.preRegistered) clients.set(options.preRegistered.clientId, { secret: options.preRegistered.clientSecret, redirectUris: [] });
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; scope?: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, { clientId: string; scope?: string }>();
  const seen = {
    requests: [] as FakeRequest[],
    registrations: [] as Record<string, unknown>[],
    authorizations: [] as URL[],
    tokenRequests: [] as FakeTokenRequest[],
  };
  const control = {
    /** Answer refresh-token requests with this HTTP status (a server error). */
    refreshStatus: undefined as number | undefined,
    /** Status the MCP endpoint answers authorized requests with. */
    mcpStatus: 200,
    /** The MCP endpoint rejects every token (as if the grant were never valid there). */
    rejectAllTokens: false,
    /** Runs once an authorization code was exchanged, before the response is sent. */
    afterCodeExchange: undefined as (() => void) | undefined,
    /** Answer code exchanges with this response instead of tokens. */
    codeExchangeResponse: undefined as { status: number; contentType: string; body: string } | undefined,
    /** Answer refresh requests with this response instead of tokens (`refreshStatus` sends a plain-text body). */
    refreshResponse: undefined as { status: number; contentType: string; body: string } | undefined,
    /** `expires_in` of issued tokens. */
    expiresIn: 3600 as unknown,
    /** Issue no refresh tokens. */
    withoutRefreshTokens: false,
  };
  let issued = 0;
  let base = "";
  const altBase = () => base.replace("127.0.0.1", "localhost");

  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  const prm = () => ({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
  });

  const issueTokens = (clientId: string, scope: string | undefined) => {
    const access = `access-${++issued}`;
    const refresh = `refresh-${issued}-${randomBytes(4).toString("hex")}`;
    accessTokens.add(access);
    if (!control.withoutRefreshTokens) refreshTokens.set(refresh, { clientId, scope });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: control.expiresIn,
      ...(control.withoutRefreshTokens ? {} : { refresh_token: refresh }),
      ...(scope && !options.omitTokenScope ? { scope } : {}),
    };
  };

  const knownClient = (clientId: string | null): Client | undefined => {
    if (!clientId) return undefined;
    if (options.cimdClientId && clientId === options.cimdClientId) return { redirectUris: [] };
    return clients.get(clientId);
  };

  const handleToken = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const form = new URLSearchParams(body);
    const grant = form.get("grant_type") ?? "";
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    let authMethod: FakeTokenRequest["authMethod"] = secret ? "post" : "none";
    const basic = /^Basic\s+(.+)$/iu.exec(req.headers.authorization ?? "")?.[1];
    if (basic) {
      const [id, value] = Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
      clientId = id ?? null;
      secret = value ?? null;
      authMethod = "basic";
    }
    const record = (status: number, error?: string) => {
      seen.tokenRequests.push({ grant, clientId, presentedSecret: Boolean(secret), authMethod, status, ...(error ? { error } : {}) });
    };
    const fail = (status: number, error: string, description?: string) => {
      record(status, error);
      json(res, status, { error, ...(description ? { error_description: description } : {}) });
    };
    const client = knownClient(clientId);
    if (!client) return fail(401, "invalid_client", "Unknown client");
    if (options.requireSecret && (!secret || secret !== client.secret)) return fail(401, "invalid_client", "Client ID and client secret are required");
    const canned = grant === "authorization_code" ? control.codeExchangeResponse : grant === "refresh_token" ? control.refreshResponse : undefined;
    if (canned) {
      record(canned.status);
      res.writeHead(canned.status, { "content-type": canned.contentType });
      return res.end(canned.body);
    }
    if (grant === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!code || code.clientId !== clientId) return fail(400, "invalid_grant");
      if (s256(form.get("code_verifier") ?? "") !== code.challenge) return fail(400, "invalid_grant", "PKCE verification failed");
      if (form.get("redirect_uri") !== code.redirectUri) return fail(400, "invalid_grant", "redirect_uri mismatch");
      record(200);
      control.afterCodeExchange?.();
      return json(res, 200, issueTokens(clientId!, code.scope));
    }
    if (grant === "refresh_token") {
      if (control.refreshStatus !== undefined) {
        record(control.refreshStatus);
        res.writeHead(control.refreshStatus, { "content-type": "text/plain" });
        return res.end("temporarily unavailable");
      }
      const presented = form.get("refresh_token") ?? "";
      const owner = refreshTokens.get(presented);
      if (!owner || owner.clientId !== clientId) return fail(400, "invalid_grant");
      refreshTokens.delete(presented);
      record(200);
      return json(res, 200, issueTokens(clientId!, owner.scope));
    }
    return fail(400, "unsupported_grant_type");
  };

  const handleMcp = (req: IncomingMessage, res: ServerResponse, body: string) => {
    if (req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      return res.end();
    }
    const token = /^Bearer\s+(.+)$/iu.exec(req.headers.authorization ?? "")?.[1];
    const authorized = !control.rejectAllTokens && token !== undefined && accessTokens.has(token);
    if (!authorized && !options.anonymousInitialize) {
      const scope = options.emptyChallengeScope ? ', scope=""' : "";
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"${scope}` });
      return res.end();
    }
    if (control.mcpStatus !== 200) {
      res.writeHead(control.mcpStatus, { "content-type": "text/plain" });
      return res.end("upstream unavailable");
    }
    const message = JSON.parse(body) as { id?: number | string; method: string };
    if (message.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] } : {};
    return json(res, 200, { jsonrpc: "2.0", id: message.id, result });
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const body = Buffer.concat(chunks).toString("utf8");
      seen.requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers });
      if (url.pathname === "/mcp") return handleMcp(req, res, body);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (options.metadataRedirect === "same-origin") {
          res.writeHead(307, { location: "/moved/oauth-protected-resource" });
          return res.end();
        }
        if (options.metadataRedirect === "cross-origin") {
          res.writeHead(307, { location: `${altBase()}/moved/oauth-protected-resource` });
          return res.end();
        }
        return json(res, 200, prm());
      }
      if (url.pathname === "/moved/oauth-protected-resource") return json(res, 200, prm());
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(options.registration === false ? {} : { registration_endpoint: `${base}/register` }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: options.authMethods ?? ["none"],
          ...(options.cimdClientId ? { client_id_metadata_document_supported: true } : {}),
        });
      }
      if (url.pathname.startsWith("/.well-known/")) {
        res.writeHead(404);
        return res.end();
      }
      if (url.pathname === "/register" && req.method === "POST" && options.registration !== false) {
        const metadata = JSON.parse(body) as Record<string, unknown>;
        seen.registrations.push(metadata);
        const clientId = `client-${seen.registrations.length}`;
        const secret = options.issueSecret ? `secret-${seen.registrations.length}` : undefined;
        clients.set(clientId, { secret, redirectUris: (metadata.redirect_uris as string[]) ?? [] });
        return json(res, 201, { ...metadata, client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) });
      }
      if (url.pathname === "/authorize") {
        seen.authorizations.push(url);
        const clientId = url.searchParams.get("client_id");
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const client = knownClient(clientId);
        // A server that does not know the client shows an error page and never calls back.
        if (!client || (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri))) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("Unknown client");
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (options.denyAuthorization) {
          callback.searchParams.set("error", options.denyAuthorization.error);
          if (options.denyAuthorization.description) callback.searchParams.set("error_description", options.denyAuthorization.description);
        } else {
          const code = `code-${++issued}`;
          codes.set(code, {
            clientId: clientId!,
            challenge: url.searchParams.get("code_challenge") ?? "",
            redirectUri,
            scope: url.searchParams.get("scope") ?? undefined,
          });
          callback.searchParams.set("code", code);
        }
        res.writeHead(302, { location: callback.href });
        return res.end();
      }
      if (url.pathname === "/token" && req.method === "POST") return handleToken(req, res, body);
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    serviceUrl: `${base}/mcp`,
    seen,
    control,
    /** Every issued access token stops working (as if it expired). */
    expireAccessTokens: () => accessTokens.clear(),
    /** Every issued refresh token is revoked. */
    revokeRefreshTokens: () => refreshTokens.clear(),
    /** The server drops every registered client (a stale client_id). */
    forgetClients: () => {
      for (const id of [...clients.keys()]) if (id !== options.preRegistered?.clientId) clients.delete(id);
    },
    requestsTo: (path: string | RegExp) => seen.requests.filter((request) => (typeof path === "string" ? request.path === path : path.test(request.path))),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

export type FakeOAuthServer = Awaited<ReturnType<typeof startFakeOAuthServer>>;
