import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMcpOAuthSessionData,
  mcpAuthorizationBinding,
  McpOAuthSessionTransaction,
  McpOAuthAuthorizationFlow,
  parseMcpOAuthSession,
  sessionMatchesMcpBinding,
  sameMcpOAuthGrant,
  sessionForFreshMcpAuthorization,
  sessionForMcpAuthorizationAttempt,
  MCP_REJECTED_REFRESH_RESTORE_MS,
  mcpTokenRefreshDueAt,
  sessionAfterTokenInvalidation,
  sessionWithRefreshedMcpTokens,
  sessionWithMcpClientInformation,
  sessionWithSavedMcpTokens,
  usableMcpClientInformation,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import { McpClient } from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  type OAuthClientProvider,
} from "@earendil-works/pi-mcp/oauth";
import { createMcpRemoteFetch, createMcpRemoteTransport } from "./mcp-remote-transport.js";

test("fresh MCP authorization drops the registration, tokens and verifier but keeps granted scope", () => {
  const session = {
    clientInformation: { client_id: "client-1", client_secret: "secret-1" },
    tokens: { access_token: "old-token", token_type: "bearer", scope: "files.read" },
    codeVerifier: "old-verifier",
  } as McpOAuthSession;
  session.authorizationBinding = "https://mcp.example.test/mcp";

  assert.deepEqual(sessionForFreshMcpAuthorization(session, session.authorizationBinding), {
    authorizationBinding: session.authorizationBinding,
    grantedScope: "files.read",
  });
  assert.equal(session.tokens?.access_token, "old-token", "the rollback snapshot must not mutate");
  assert.equal(session.clientInformation?.client_id, "client-1", "the rollback snapshot keeps its registration");
});

test("fresh MCP authorization starts empty without a prior registration", () => {
  assert.deepEqual(
    sessionForFreshMcpAuthorization(
      {
        tokens: { access_token: "old-token", token_type: "bearer" },
        codeVerifier: "old-verifier",
      } as McpOAuthSession,
      "https://mcp.example.test/mcp",
    ),
    { authorizationBinding: "https://mcp.example.test/mcp" },
  );
});

test("registration is discarded when the protected-resource endpoint changes", () => {
  const old = {
    authorizationBinding: "https://mcp.example.test/mcp",
    clientInformation: { client_id: "client-1", client_secret: "secret" },
  } as McpOAuthSession;
  assert.deepEqual(sessionForFreshMcpAuthorization(old, "https://attacker.example/mcp"), {
    authorizationBinding: "https://attacker.example/mcp",
  });
  assert.equal(sessionMatchesMcpBinding(old, "https://attacker.example/mcp"), false);
});

test("authorization binding preserves resource queries while removing fragments and trailing slash", () => {
  assert.equal(
    mcpAuthorizationBinding("https://MCP.Example.test/mcp/?tenant=a#fragment"),
    "https://mcp.example.test/mcp?tenant=a",
  );
  assert.notEqual(
    mcpAuthorizationBinding("https://mcp.example.test/mcp?tenant=a"),
    mcpAuthorizationBinding("https://mcp.example.test/mcp?tenant=b"),
  );
  assert.equal(
    sessionMatchesMcpBinding(
      {
        // Old builds discarded the query. Fail closed and require fresh auth
        // rather than treating the normalized legacy binding as tenant-wide.
        authorizationBinding: "https://mcp.example.test/mcp",
      },
      "https://mcp.example.test/mcp?tenant=a",
    ),
    false,
  );
});

test("a stored client secret is usable until its server-issued expiry", () => {
  const now = Date.UTC(2026, 9, 20);
  const registration = (expiresAt?: number) => ({
    client_id: "c", redirect_uris: ["http://127.0.0.1/callback"], client_secret: "s",
    ...(expiresAt === undefined ? {} : { client_secret_expires_at: expiresAt }),
  });
  assert.equal(usableMcpClientInformation(registration(), now)?.client_secret, "s");
  assert.equal(usableMcpClientInformation(registration(0), now)?.client_secret, "s", "0 means the secret never expires");
  assert.equal(usableMcpClientInformation(registration(now / 1000 + 60), now)?.client_secret, "s");
  assert.equal(usableMcpClientInformation(registration(now / 1000 - 1), now), undefined, "an expired secret forces a new registration");
  assert.equal(usableMcpClientInformation(undefined, now), undefined);
});

test("a stored client secret survives the encrypted round trip and malformed secrets are rejected", () => {
  const session = sessionWithMcpClientInformation({}, "https://mcp.example.test/mcp", {
    client_id: "c", redirect_uris: ["http://127.0.0.1/callback"], client_secret: "s", client_secret_expires_at: 0,
  });
  const restored = parseMcpOAuthSession(JSON.parse(JSON.stringify(session)));
  assert.equal(restored.clientInformation?.client_secret, "s");
  assert.equal(restored.clientInformation?.client_secret_expires_at, 0);
  for (const clientInformation of [{ client_id: "c", client_secret: 7 }, { client_id: "c", client_secret: "s", client_secret_expires_at: "never" }]) {
    assert.throws(() => parseMcpOAuthSession({ clientInformation }), /secret is malformed/u);
  }
});

test("a public registration answered with an empty secret still stores a readable session", () => {
  const session = sessionWithMcpClientInformation({}, "https://mcp.example.test/mcp", {
    client_id: "c", redirect_uris: ["http://127.0.0.1/callback"], client_secret: "", client_secret_expires_at: 0,
    token_endpoint_auth_method: "none",
  });
  const restored = parseMcpOAuthSession(JSON.parse(JSON.stringify(session)));
  assert.equal(restored.clientInformation?.client_id, "c");
  assert.equal(restored.clientInformation?.client_secret, undefined);
});

test("OAuth session data detection distinguishes an absent rollback snapshot", () => {
  assert.equal(hasMcpOAuthSessionData({}), false);
  assert.equal(
    hasMcpOAuthSessionData({
      tokens: { access_token: "token", token_type: "bearer" },
    } as McpOAuthSession),
    true,
  );
});

test("interactive authorization buffers replacement credentials until explicit commit", () => {
  const previous = {
    authorizationBinding: "https://mcp.example.test/mcp",
    tokens: { access_token: "old-token", token_type: "bearer" },
  } as McpOAuthSession;
  const transaction = new McpOAuthSessionTransaction(
    sessionForFreshMcpAuthorization(previous, previous.authorizationBinding!),
  );

  const staged = transaction.read();
  staged.tokens = { access_token: "new-token", token_type: "bearer" };
  transaction.replace(staged);

  assert.equal(previous.tokens?.access_token, "old-token");
  assert.equal(transaction.read().tokens?.access_token, "new-token");
  const leakedMutation = transaction.read();
  leakedMutation.tokens!.access_token = "mutated-outside";
  assert.equal(transaction.read().tokens?.access_token, "new-token");
});

test("decrypted MCP sessions reject malformed roots and known fields", () => {
  for (const malformed of [
    null,
    [],
    { tokens: null },
    { tokens: { access_token: "token" } },
    { clientInformation: { client_id: 7 } },
    { codeVerifier: 7 },
    { grantedScope: [] },
  ]) {
    assert.throws(() => parseMcpOAuthSession(malformed), /MCP OAuth/u);
  }
});

function startedFlow(requireIssuer = false) {
  const flow = new McpOAuthAuthorizationFlow();
  flow.saveDiscovery({
    authorizationServerUrl: "https://accounts.example.test/tenant",
    authorizationServerMetadata: {
      issuer: "https://accounts.example.test/tenant",
      authorization_endpoint: "https://accounts.example.test/authorize",
      token_endpoint: "https://accounts.example.test/token",
      response_types_supported: ["code"],
      authorization_response_iss_parameter_supported: requireIssuer,
    },
  });
  flow.authorizationUrl(new URL(`https://accounts.example.test/authorize?state=${flow.state}`));
  return flow;
}

test("callbacks require the active sign-in state and do not consume it on a rejected callback", () => {
  const flow = startedFlow();
  for (const query of ["code=unrelated", "code=unrelated&state=wrong", `code=unrelated&state=${flow.state}&state=${flow.state}`]) {
    assert.throws(() => flow.callback(new URL(`http://127.0.0.1/callback?${query}`)), /state/u);
  }
  const valid = new URL(`http://127.0.0.1/callback?code=accepted&state=${flow.state}`);
  assert.deepEqual(flow.callback(valid), { code: "accepted" });
  assert.throws(() => flow.callback(valid), /state/u, "authorization codes must not be accepted twice");
  const unstarted = new McpOAuthAuthorizationFlow();
  assert.throws(() => unstarted.callback(new URL(`http://127.0.0.1/callback?code=early&state=${unstarted.state}`)), /state/u);
});

test("callback issuer must match discovered issuer, including tenant and trailing slash", () => {
  const flow = startedFlow(true);
  for (const issuer of [undefined, "https://other.example.test/tenant", "https://accounts.example.test/other", "https://accounts.example.test/tenant/"]) {
    const url = new URL(`http://127.0.0.1/callback?code=untrusted&state=${flow.state}`);
    if (issuer) url.searchParams.set("iss", issuer);
    assert.throws(() => flow.callback(url), /issuer/u);
  }
  const valid = new URL(`http://127.0.0.1/callback?code=trusted&state=${flow.state}`);
  valid.searchParams.set("iss", "https://accounts.example.test/tenant");
  assert.deepEqual(flow.callback(valid), { code: "trusted" });
});

test("optional issuer remains compatible when absent but never accepts a mismatched or duplicate issuer", () => {
  const flow = startedFlow();
  const callback = new URL(`http://127.0.0.1/callback?code=code&state=${flow.state}`);
  callback.searchParams.set("iss", "https://wrong.example.test");
  assert.throws(() => flow.callback(callback), /issuer/u);
  callback.searchParams.set("iss", "https://accounts.example.test/tenant");
  callback.searchParams.append("iss", "https://accounts.example.test/tenant");
  assert.throws(() => flow.callback(callback), /issuer/u);
  callback.searchParams.delete("iss");
  assert.deepEqual(flow.callback(callback), { code: "code" });
});

test("provider denials are bound to state and ambiguous callback payloads cannot complete sign-in", () => {
  const flow = startedFlow();
  for (const query of ["code=a&code=b", "code=a&error=access_denied", "code=", "error="]) {
    assert.throws(() => flow.callback(new URL(`http://127.0.0.1/callback?state=${flow.state}&${query}`)), /result/u);
  }
  assert.throws(() => flow.callback(new URL("http://127.0.0.1/callback?state=wrong&error=access_denied")), /state/u);
  const denied = flow.callback(new URL(`http://127.0.0.1/callback?state=${flow.state}&error=access_denied&error_description=${encodeURIComponent("Admin\u0000 approval\nrequired " + "x".repeat(400))}`));
  assert.ok("error" in denied);
  assert.match(denied.error.message, /^Sign-in was denied in the browser: Admin approval required x+…$/u, "one line, no control characters, bounded");
  assert.ok(denied.error.message.length < 360);
  const odd = startedFlow();
  const unusual = odd.callback(new URL(`http://127.0.0.1/callback?state=${odd.state}&error=${encodeURIComponent("<script>")}`));
  assert.ok("error" in unusual);
  assert.equal(unusual.error.message, "The authorization server returned “invalid_response”.", "an error code that is not a token is not echoed");
});

test("step-up authorization retains granted scopes only for the same protected-resource binding", () => {
  const session: McpOAuthSession = {
    authorizationBinding: "https://mcp.example.test/mcp?tenant=one",
    tokens: { access_token: "old", token_type: "Bearer", scope: "files.read offline_access" },
  };
  const fresh = sessionForFreshMcpAuthorization(session, session.authorizationBinding!);
  assert.equal(fresh.tokens, undefined);
  assert.equal(fresh.grantedScope, "files.read offline_access");
  const flow = new McpOAuthAuthorizationFlow();
  const request = flow.authorizationUrl(new URL(`https://accounts.example.test/authorize?state=${flow.state}&scope=files.write%20files.read`), fresh.grantedScope);
  assert.equal(request.searchParams.get("scope"), "files.read offline_access files.write");
  assert.equal(request.searchParams.get("prompt"), "consent");
  const explicit = new McpOAuthAuthorizationFlow();
  assert.equal(explicit.authorizationUrl(new URL(`https://accounts.example.test/authorize?state=${explicit.state}&prompt=login`), "offline_access").searchParams.get("prompt"), "login");
  assert.deepEqual(sessionForFreshMcpAuthorization(session, "https://mcp.example.test/mcp?tenant=two"), {
    authorizationBinding: "https://mcp.example.test/mcp?tenant=two",
  });
});

test("OAuth discovery and token exchange use the issuer bound before the browser opens", async () => {
  const flow = new McpOAuthAuthorizationFlow();
  let browserUrl: URL | undefined;
  let verifier: string | undefined;
  let exchanged = 0;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:49152/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:49152/callback"], token_endpoint_auth_method: "none" },
    state: () => flow.state,
    clientInformation: () => ({ client_id: "registered-client" }),
    tokens: () => undefined,
    saveTokens: () => undefined,
    saveDiscoveryState: (state) => flow.saveDiscovery(state),
    discoveryState: () => flow.discoveryState(),
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier!,
    redirectToAuthorization: (url) => { browserUrl = flow.authorizationUrl(url, "files.read"); },
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://accounts.example.test"] });
    if (url.pathname.includes("oauth-authorization-server")) return Response.json({
      issuer: "https://accounts.example.test",
      authorization_endpoint: "https://accounts.example.test/authorize",
      token_endpoint: "https://accounts.example.test/token",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    if (url.pathname === "/token") {
      exchanged += 1;
      assert.equal(new URLSearchParams(String(init?.body)).get("code"), "trusted-code");
      return Response.json({ access_token: "new-token", token_type: "Bearer" });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
  const options = { serverUrl: "https://mcp.example.test/mcp", scope: "files.write", fetch: fetchFn };
  assert.equal(await authorizeMcp(provider, options), "REDIRECT");
  assert.equal(browserUrl?.searchParams.get("scope"), "files.read files.write");
  const callback = new URL(`http://127.0.0.1:49152/callback?state=${flow.state}&code=trusted-code&iss=https://wrong.example.test`);
  assert.throws(() => flow.callback(callback), /issuer/u);
  assert.equal(exchanged, 0);
  callback.searchParams.set("iss", "https://accounts.example.test");
  const accepted = flow.callback(callback);
  assert.ok("code" in accepted);
  assert.equal(await authorizeMcp(provider, { ...options, ...flow.codeExchange(accepted.code) }), "AUTHORIZED");
  assert.equal(exchanged, 1);
});

test("decrypted MCP sessions preserve compatible future fields", () => {
  const parsed = parseMcpOAuthSession({
    authorizationBinding: "https://mcp.example.test/mcp",
    tokens: {
      access_token: "token",
      token_type: "bearer",
      future_token_hint: { mode: "device" },
    },
    futureSessionState: { generation: 2 },
  }) as McpOAuthSession & { futureSessionState?: unknown };

  assert.deepEqual(parsed.futureSessionState, { generation: 2 });
  assert.deepEqual(
    (parsed.tokens as unknown as { future_token_hint?: unknown }).future_token_hint,
    { mode: "device" },
  );
});

test("configured OAuth metadata bypasses a wrong advertised issuer without changing resource or callback binding", async () => {
  const { loadMcpOAuthMetadataOverride } = await import("./mcp-oauth-metadata.js");
  const flow = new McpOAuthAuthorizationFlow();
  const requests: string[] = [];
  let browser: URL | undefined;
  let verifier = "";
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    if (url === "https://identity.test/config") {
      assert.equal(new Headers(init?.headers).has("X-Service-Secret"), false);
      assert.notEqual(init?.redirect ?? "follow", "follow", "redirects are never followed blindly");
      return Response.json({ issuer: "https://identity.test", authorization_endpoint: "https://identity.test/authorize", token_endpoint: "https://identity.test/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true });
    }
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://service.test/mcp", authorization_servers: ["https://wrong.test"], scopes_supported: ["files.read"] });
    if (url === "https://identity.test/token") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("resource"), "https://service.test/mcp");
      assert.equal(body.get("redirect_uri"), "http://127.0.0.1:41390/callback");
      return Response.json({ access_token: "new", token_type: "Bearer" });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:41390/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:41390/callback"], token_endpoint_auth_method: "none" },
    state: () => flow.state, clientInformation: () => ({ client_id: "registered" }), tokens: () => undefined, saveTokens() {},
    saveDiscoveryState: (state) => flow.saveDiscovery(state),
    async discoveryState() {
      if (!flow.discoveryState()) flow.saveDiscovery(await loadMcpOAuthMetadataOverride("https://identity.test/config", { serviceUrl: "https://service.test/mcp", serviceHeaders: { "X-Service-Secret": "secret" }, fetch: fetchFn }));
      return flow.discoveryState();
    },
    saveCodeVerifier(value) { verifier = value; }, codeVerifier: () => verifier,
    redirectToAuthorization(url) { browser = flow.authorizationUrl(url, "files.old"); },
  };
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://service.test/mcp", fetch: fetchFn }), "REDIRECT");
  assert.equal(browser?.origin, "https://identity.test");
  assert.equal(browser?.searchParams.get("scope"), "files.old files.read");
  assert.throws(() => flow.callback(new URL(`http://127.0.0.1:41390/callback?state=${flow.state}&code=code&iss=https://wrong.test`)), /issuer/u);
  const accepted = flow.callback(new URL(`http://127.0.0.1:41390/callback?state=${flow.state}&code=code&iss=https://identity.test`));
  assert.ok("code" in accepted);
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://service.test/mcp", ...flow.codeExchange(accepted.code), fetch: fetchFn }), "AUTHORIZED");
  assert.equal(requests.filter((url) => url === "https://identity.test/config").length, 1);
  assert.ok(requests.every((url) => !url.includes("wrong.test")));
});

test("OAuth metadata overrides reject oversized, insecure and stale discovery before browser use", async () => {
  const { loadMcpOAuthMetadataOverride } = await import("./mcp-oauth-metadata.js");
  const options = { serviceUrl: "https://service.test/mcp" };
  await assert.rejects(loadMcpOAuthMetadataOverride("https://identity.test/config", { ...options, fetch: async () => Response.json({ pad: "x".repeat(65536) }) }), /transport limit/u);
  await assert.rejects(loadMcpOAuthMetadataOverride("https://identity.test/config", { ...options, fetch: async () => Response.json({ issuer: "https://identity.test", authorization_endpoint: "http://remote.test/login", token_endpoint: "https://identity.test/token", response_types_supported: ["code"] }) }), /HTTPS/u);
  let current = true;
  await assert.rejects(loadMcpOAuthMetadataOverride("https://identity.test/config", { ...options, isCurrent: () => current, fetch: async () => { current = false; return Response.json({}); } }), /no longer current/u);
  const oldBinding = mcpAuthorizationBinding("https://service.test/mcp");
  const newBinding = mcpAuthorizationBinding("https://service.test/mcp", "https://identity.test/config");
  assert.notEqual(oldBinding, newBinding);
  assert.deepEqual(sessionForFreshMcpAuthorization({ authorizationBinding: oldBinding, tokens: { access_token: "old", token_type: "Bearer", scope: "secret.scope" } }, newBinding), { authorizationBinding: newBinding });
  assert.notEqual(newBinding, mcpAuthorizationBinding("https://service.test/mcp", "https://identity.test/config", "Different client"));
});


for (const oidc of [false, true]) {
  for (const issuerMismatch of [false, true]) {
    test(`real MCP transport ${oidc ? "OIDC fallback" : "OAuth discovery"} ${issuerMismatch ? "rejects an inconsistent issuer before consent" : "preserves mandatory callback issuer policy"}`, async (t) => {
      const flow = new McpOAuthAuthorizationFlow();
      let browser: URL | undefined;
      let verifier: string | undefined;
      let exchanges = 0;
      const requested: string[] = [];
      const issuer = "https://identity.example.test/tenant";
      const provider: OAuthClientProvider = {
        redirectUrl: "http://127.0.0.1:49152/callback",
        clientMetadata: { redirect_uris: ["http://127.0.0.1:49152/callback"], token_endpoint_auth_method: "none" },
        clientInformation: () => ({ client_id: "registered-client" }),
        state: () => flow.state,
        tokens: () => undefined,
        saveTokens: () => {},
        saveDiscoveryState: (state) => flow.saveDiscovery(state),
        discoveryState: () => flow.discoveryState(),
        saveCodeVerifier: (value) => { verifier = value; },
        codeVerifier: () => verifier!,
        redirectToAuthorization: (url) => { browser = flow.authorizationUrl(url); },
      };
      const policy = {
        serviceUrl: "https://resource.example.test/mcp", authProvider: provider,
        fetch: async (input: Parameters<typeof globalThis.fetch>[0]) => {
          const url = new URL(String(input));
          requested.push(url.pathname);
          if (url.pathname === "/mcp") return new Response(null, { status: 401 });
          if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://resource.example.test/mcp", authorization_servers: [issuer] });
          if (oidc && url.pathname.includes("oauth-authorization-server")) return new Response(null, { status: 404 });
          if (url.pathname.includes("/.well-known/")) return Response.json({
            issuer: issuerMismatch ? `${issuer}/other` : issuer,
            authorization_endpoint: "https://identity.example.test/authorize",
            token_endpoint: "https://identity.example.test/token",
            response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
            ...(oidc ? { jwks_uri: "https://identity.example.test/jwks", subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] } : {}),
          });
          if (url.pathname === "/token") { exchanges++; return Response.json({ access_token: "token", token_type: "Bearer" }); }
          throw new Error(`Unexpected request ${url}`);
        },
      };
      const transport = createMcpRemoteTransport(policy);
      const client = new McpClient({ name: "issuer-regression", version: "1" });
      t.after(async () => { await client.close(); await transport.close(); });
      await assert.rejects(client.connect(transport), issuerMismatch ? /issuer/u : McpOAuthAuthorizationRequiredError);
      assert.equal(exchanges, 0);
      assert.equal(requested.some((path) => path.includes("openid-configuration")), oidc);
      if (issuerMismatch) {
        assert.equal(browser, undefined);
        assert.equal(flow.discoveryState(), undefined);
        return;
      }
      assert.ok(browser);
      const callback = new URL(`http://127.0.0.1:49152/callback?state=${flow.state}&code=trusted`);
      assert.throws(() => flow.callback(callback), /issuer/u, "the OIDC issuer-parameter extension must survive metadata parsing");
      callback.searchParams.set("iss", `${issuer}/`);
      assert.throws(() => flow.callback(callback), /issuer/u);
      assert.equal(exchanges, 0);
      callback.searchParams.set("iss", issuer);
      const accepted = flow.callback(callback);
      assert.ok("code" in accepted);
      assert.equal(await authorizeMcp(provider, {
        serverUrl: policy.serviceUrl, ...flow.codeExchange(accepted.code), fetch: createMcpRemoteFetch(policy),
      }), "AUTHORIZED");
      assert.equal(exchanges, 1);
    });
  }
}


test("a token refresh keeps the same grant; re-authorization, revocation and sign-out do not", async () => {
  const binding = mcpAuthorizationBinding("https://mcp.example.test/mcp");
  const granted = sessionWithSavedMcpTokens(
    // The interactive attempt registers a client before the code exchange.
    sessionWithMcpClientInformation(sessionForMcpAuthorizationAttempt({}, binding), binding, { client_id: "client-1", redirect_uris: ["http://127.0.0.1:49152/callback"] }),
    binding,
    { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600, scope: "pages.read pages.write" },
  );
  let stored = structuredClone(granted);
  let refreshes = 0;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:49152/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:49152/callback"], token_endpoint_auth_method: "none" },
    clientInformation: () => stored.clientInformation,
    tokens: () => stored.tokens,
    // The background provider's exact merge: rotate tokens into the bound session.
    saveTokens: (tokens) => { stored = sessionWithSavedMcpTokens(stored, binding, tokens); },
    saveCodeVerifier: () => undefined,
    codeVerifier: () => "",
    redirectToAuthorization: () => { throw new Error("A refresh must not open a browser."); },
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://accounts.example.test"] });
    if (url.pathname.includes("oauth-authorization-server")) return Response.json({
      issuer: "https://accounts.example.test",
      authorization_endpoint: "https://accounts.example.test/authorize",
      token_endpoint: "https://accounts.example.test/token",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    });
    if (url.pathname === "/token") {
      refreshes += 1;
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
      // A rotating provider: new access and refresh tokens, no scope echoed.
      return Response.json({ access_token: `access-${refreshes + 1}`, token_type: "bearer", refresh_token: `refresh-${refreshes + 1}`, expires_in: 3599 });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };

  assert.equal(await authorizeMcp(provider, { serverUrl: "https://mcp.example.test/mcp", fetch: fetchFn }), "AUTHORIZED");
  assert.equal(refreshes, 1);
  assert.equal(stored.tokens?.access_token, "access-2");
  assert.equal(stored.tokens?.refresh_token, "refresh-2");
  assert.equal(sameMcpOAuthGrant(granted, stored), true);

  const reauthorized = sessionWithSavedMcpTokens(
    sessionForMcpAuthorizationAttempt(stored, binding),
    binding,
    { access_token: "access-other", token_type: "Bearer", refresh_token: "refresh-other", scope: "pages.read pages.write" },
  );
  assert.equal(sameMcpOAuthGrant(stored, reauthorized), false, "an explicit sign-in is a new grant");

  const revoked = structuredClone(stored);
  delete revoked.tokens;
  assert.equal(sameMcpOAuthGrant(stored, revoked), false);
  assert.equal(sameMcpOAuthGrant(stored, {}), false);
  assert.equal(
    sameMcpOAuthGrant(stored, sessionWithSavedMcpTokens(stored, binding, { access_token: "narrow", token_type: "Bearer", refresh_token: "r", scope: "pages.read" })),
    false,
    "a narrower granted scope is a grant change",
  );
  assert.equal(
    sameMcpOAuthGrant(stored, { ...stored, clientInformation: { client_id: "client-2", redirect_uris: ["http://127.0.0.1:49152/callback"] } }),
    false,
  );
});

/** Minimal interactive-style provider recording what the OAuth flow persists and opens. */
function recordingProvider(flow: McpOAuthAuthorizationFlow, overrides: Partial<OAuthClientProvider> = {}) {
  const record: { browser?: URL; client?: unknown } = {};
  let verifier: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:49152/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:49152/callback"], token_endpoint_auth_method: "none" },
    clientInformation: () => record.client as never,
    saveClientInformation: (information) => { record.client = information; },
    state: () => flow.state,
    tokens: () => undefined,
    saveTokens: () => {},
    saveDiscoveryState: (state) => flow.saveDiscovery(state),
    discoveryState: () => flow.discoveryState(),
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier!,
    redirectToAuthorization: (url) => { record.browser = flow.authorizationUrl(url); },
    ...overrides,
  };
  return { provider, record };
}

async function connectExpectingSignIn(serviceUrl: string, provider: OAuthClientProvider, fetch: typeof globalThis.fetch) {
  const transport = createMcpRemoteTransport({ serviceUrl, authProvider: provider, fetch });
  const client = new McpClient({ name: "oauth-regression", version: "1" });
  try {
    await assert.rejects(client.connect(transport), McpOAuthAuthorizationRequiredError);
  } finally {
    await client.close();
  }
}

const rootMetadata = (issuer: string, extra: Record<string, unknown> = {}) => Response.json({
  issuer, authorization_endpoint: "https://login.example.test/authorize", token_endpoint: "https://login.example.test/token",
  response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...extra,
});

test("quote-only scope remnants are never requested as scopes", () => {
  const flow = new McpOAuthAuthorizationFlow();
  const url = flow.authorizationUrl(new URL(`https://login.example.test/authorize?state=${flow.state}&scope=%22%22`), "''");
  assert.equal(url.searchParams.has("scope"), false);
});

test("Pi's parsers accept null and empty optional members in metadata and registration responses", async () => {
  const flow = new McpOAuthAuthorizationFlow();
  const { provider, record } = recordingProvider(flow);
  let registrations = 0;
  await connectExpectingSignIn("https://mcp.example.test/mcp", provider, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/mcp") return new Response(null, { status: 401 });
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://login.example.test"] });
    if (url.pathname === "/register") {
      registrations += 1;
      assert.equal(init?.method, "POST");
      return Response.json({ client_id: "dcr-client", redirect_uris: ["http://127.0.0.1:49152/callback"], client_secret: null,
        client_secret_expires_at: null, client_uri: "", logo_uri: null, scope: "", software_version: null }, { status: 201 });
    }
    return rootMetadata("https://login.example.test", { registration_endpoint: "https://login.example.test/register",
      scopes_supported: null, service_documentation: "", op_policy_uri: null, revocation_endpoint: "" });
  });
  assert.equal(registrations, 1);
  const client = record.client as Record<string, unknown>;
  assert.equal(client.client_id, "dcr-client");
  assert.equal("client_secret" in client, false, "a null secret is no secret");
  assert.ok(record.browser, "registration proceeds to the consent page");
});

test("required registration and metadata members stay strict when null or empty", async () => {
  const flow = new McpOAuthAuthorizationFlow();
  const { provider, record } = recordingProvider(flow);
  const transport = createMcpRemoteTransport({ serviceUrl: "https://mcp.example.test/mcp", authProvider: provider, fetch: async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/mcp") return new Response(null, { status: 401 });
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://login.example.test"] });
    if (url.pathname === "/register") return Response.json({ client_id: null, redirect_uris: ["http://127.0.0.1:49152/callback"] }, { status: 201 });
    return rootMetadata("https://login.example.test", { registration_endpoint: "https://login.example.test/register" });
  } });
  const client = new McpClient({ name: "oauth-regression", version: "1" });
  try {
    await assert.rejects(client.connect(transport), (error: unknown) => !(error instanceof McpOAuthAuthorizationRequiredError));
  } finally { await client.close(); }
  assert.equal(record.client, undefined);
  assert.equal(record.browser, undefined);
});

test("a root issuer without trailing slash matches the root fallback, and the callback issuer agrees", async () => {
  const flow = new McpOAuthAuthorizationFlow();
  const { provider, record } = recordingProvider(flow, { clientInformation: () => ({ client_id: "registered" }) });
  await connectExpectingSignIn("https://mcp.example.test/mcp", provider, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/mcp") return new Response(null, { status: 401 });
    if (url.pathname.includes("oauth-protected-resource")) return new Response(null, { status: 404 });
    // No protected-resource metadata: the flow selects new URL("/", serverUrl).
    return Response.json({ issuer: "https://mcp.example.test", authorization_endpoint: "https://mcp.example.test/authorize",
      token_endpoint: "https://mcp.example.test/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true });
  });
  assert.ok(record.browser, "the root issuer was accepted");
  for (const iss of ["https://mcp.example.test/other", "https://mcp.example.test//"]) {
    const rejected = new URL(`http://127.0.0.1:49152/callback?state=${flow.state}&code=c`);
    rejected.searchParams.set("iss", iss);
    assert.throws(() => flow.callback(rejected), /issuer/u, iss);
  }
  const callback = new URL(`http://127.0.0.1:49152/callback?state=${flow.state}&code=accepted`);
  callback.searchParams.set("iss", "https://mcp.example.test");
  assert.deepEqual(flow.callback(callback), { code: "accepted" });
  const tenant = new McpOAuthAuthorizationFlow();
  assert.throws(() => tenant.saveDiscovery({ authorizationServerUrl: "https://login.example.test/tenant/", authorizationServerMetadata: {
    issuer: "https://login.example.test/tenant", authorization_endpoint: "https://login.example.test/a", token_endpoint: "https://login.example.test/t", response_types_supported: ["code"],
  } }), /issuer/u, "path issuers stay exact");
});

test("a background 403 insufficient_scope challenge is requested by the next interactive authorization", async () => {
  const { mcpInteractiveAuthorizationScope, clearMcpStepUpScope } = await import("./mcp-oauth-session.js");
  const serviceUrl = "https://step-up.example.test/mcp";
  const background: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:49152/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:49152/callback"] },
    clientInformation: () => ({ client_id: "registered" }),
    tokens: () => ({ access_token: "narrow", token_type: "Bearer" }),
    saveTokens: () => {}, saveCodeVerifier: () => {}, codeVerifier: () => "v",
    redirectToAuthorization: () => { throw new Error("This MCP server needs sign-in."); },
  };
  const transport = createMcpRemoteTransport({ serviceUrl, authProvider: background, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: serviceUrl, authorization_servers: ["https://login.example.test"] });
    if (url.pathname.includes("/.well-known/")) return rootMetadata("https://login.example.test");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.method === "tools/call") {
      return new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="files.read files.write"' } });
    }
    if (request.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } } });
  } });
  const client = new McpClient({ name: "step-up", version: "1" });
  client.onError(() => {});
  try {
    await client.connect(transport);
    await assert.rejects(client.callTool("write", {}), /sign-in/u);
  } finally { await client.close(); }
  const scope = mcpInteractiveAuthorizationScope(`${serviceUrl}/`, "files.read offline_access");
  const flow = new McpOAuthAuthorizationFlow();
  const url = flow.authorizationUrl(new URL(`https://login.example.test/authorize?state=${flow.state}`), scope);
  assert.deepEqual(url.searchParams.get("scope")?.split(" ").sort(), ["files.read", "files.write", "offline_access"]);
  clearMcpStepUpScope(serviceUrl);
  assert.equal(mcpInteractiveAuthorizationScope(serviceUrl, "files.read"), "files.read");
});

test("a late refresh response neither overwrites newer tokens nor restores a signed-out session", () => {
  const binding = mcpAuthorizationBinding("https://mcp.example.test/mcp");
  const presented = { access_token: "access-1", refresh_token: "refresh-1" };
  const late = { access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2" };
  const current = { authorizationBinding: binding, tokens: { ...presented, token_type: "Bearer" } } as McpOAuthSession;
  assert.equal(sessionWithRefreshedMcpTokens(current, binding, presented, late)?.tokens?.refresh_token, "refresh-2");
  const rotated = { authorizationBinding: binding, tokens: { access_token: "access-3", token_type: "Bearer", refresh_token: "refresh-3" } } as McpOAuthSession;
  assert.equal(sessionWithRefreshedMcpTokens(rotated, binding, presented, late), undefined);
  assert.equal(sessionWithRefreshedMcpTokens({ authorizationBinding: binding }, binding, presented, late), undefined);
});

test("a rotation of a refresh token another client gave up on is restored only for the same grant, in time", () => {
  const binding = mcpAuthorizationBinding("https://mcp.example.test/mcp");
  const presented = { access_token: "access-1", refresh_token: "refresh-1", grantId: "grant-1" };
  const rotation = { access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2" };
  const signedIn = { authorizationBinding: binding, grantId: "grant-1", tokens: { access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer" } } as McpOAuthSession;
  const at = 1_000_000;
  // Another client's refresh with the same token was rejected; it removed the pair. The marker survives a store round trip.
  const rejected = parseMcpOAuthSession(JSON.parse(JSON.stringify(sessionAfterTokenInvalidation(signedIn, presented, at))));
  assert.equal(rejected.tokens, undefined);
  assert.doesNotMatch(JSON.stringify(rejected), /refresh-1/u, "the rejected token itself is not kept");
  const restored = sessionWithRefreshedMcpTokens(rejected, binding, presented, rotation, undefined, at + 1_000);
  assert.equal(restored?.tokens?.refresh_token, "refresh-2");
  assert.equal(restored?.grantId, "grant-1");
  assert.equal(restored?.rejectedRefresh, undefined, "a restored rotation clears the marker");
  // Too late, another refresh token, or another grant: the response is stale.
  assert.equal(sessionWithRefreshedMcpTokens(rejected, binding, presented, rotation, undefined, at + MCP_REJECTED_REFRESH_RESTORE_MS + 1), undefined);
  assert.equal(sessionWithRefreshedMcpTokens(rejected, binding, { ...presented, refresh_token: "refresh-0" }, rotation, undefined, at + 1_000), undefined);
  assert.equal(sessionWithRefreshedMcpTokens(rejected, binding, { ...presented, grantId: "grant-0" }, rotation, undefined, at + 1_000), undefined);
  assert.equal(sessionWithRefreshedMcpTokens({ ...rejected, grantId: "grant-2" }, binding, presented, rotation, undefined, at + 1_000), undefined);
  // Once anything newer is stored, it wins.
  const newer = sessionWithSavedMcpTokens(rejected, binding, { access_token: "access-9", token_type: "Bearer", refresh_token: "refresh-9" });
  assert.equal(newer.rejectedRefresh, undefined);
  assert.equal(sessionWithRefreshedMcpTokens(newer, binding, presented, rotation, undefined, at + 1_000), undefined);
  // A malformed marker is dropped rather than making the stored sign-in unreadable.
  assert.equal(parseMcpOAuthSession({ ...rejected, rejectedRefresh: { refreshTokenHash: "nope", at } }).rejectedRefresh, undefined);
});

test("saved tokens record when they expire, and a refresh is due 30 seconds before that", () => {
  const binding = mcpAuthorizationBinding("https://mcp.example.test/mcp");
  const savedAt = 1_000_000;
  const saved = sessionWithSavedMcpTokens({ authorizationBinding: binding }, binding,
    { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 }, undefined, savedAt);
  // The expiry survives the encrypted store's JSON round trip.
  const stored = parseMcpOAuthSession(JSON.parse(JSON.stringify(saved)));
  assert.equal(stored.expiresAt, savedAt + 3_600_000);
  assert.equal(mcpTokenRefreshDueAt(stored), savedAt + 3_600_000 - 30_000);
  // A refresh replaces the expiry with the new token's.
  const refreshed = sessionWithRefreshedMcpTokens(stored, binding, { access_token: "access-1", refresh_token: "refresh-1" },
    { access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 600 }, undefined, savedAt + 3_000_000);
  assert.equal(refreshed?.expiresAt, savedAt + 3_000_000 + 600_000);
  // Giving the tokens up drops their expiry with them.
  assert.equal(sessionAfterTokenInvalidation(stored, undefined, savedAt)?.expiresAt, undefined);
});

test("a token lifetime shorter than a minute is refreshed at half its life, not on every request", () => {
  const binding = mcpAuthorizationBinding("https://mcp.example.test/mcp");
  const saved = sessionWithSavedMcpTokens({ authorizationBinding: binding }, binding,
    { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 20 }, undefined, 5_000);
  assert.equal(mcpTokenRefreshDueAt(saved), 5_000 + 10_000);
});

test("tokens without a lifetime, without a refresh token or from an older record are refreshed only after a 401", () => {
  const binding = mcpAuthorizationBinding("https://mcp.example.test/mcp");
  const noLifetime = sessionWithSavedMcpTokens({ authorizationBinding: binding }, binding,
    { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1" }, undefined, 5_000);
  assert.equal(noLifetime.expiresAt, undefined);
  assert.equal(mcpTokenRefreshDueAt(noLifetime), undefined);
  const notRefreshable = sessionWithSavedMcpTokens({ authorizationBinding: binding }, binding,
    { access_token: "access-1", token_type: "Bearer", expires_in: 60 }, undefined, 5_000);
  assert.equal(mcpTokenRefreshDueAt(notRefreshable), undefined);
  // A record written before expiries were stored keeps a relative lifetime only.
  const older = parseMcpOAuthSession({ authorizationBinding: binding, tokens: { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 } });
  assert.equal(mcpTokenRefreshDueAt(older), undefined);
  // A malformed expiry is dropped rather than making the stored sign-in unreadable.
  for (const expiresAt of ["soon", -1, Number.NaN, null]) {
    const parsed = parseMcpOAuthSession({ ...older, expiresAt });
    assert.equal(parsed.expiresAt, undefined);
    assert.equal(parsed.tokens?.access_token, "access-1");
  }
});

test("a 403 insufficient_scope on another path of the service origin is remembered for the server", async () => {
  const { createMcpFetchPolicy } = await import("./mcp-fetch-policy.js");
  const { mcpInteractiveAuthorizationScope, clearMcpStepUpScope } = await import("./mcp-oauth-session.js");
  const serviceUrl = "https://sse-step-up.example.test/sse";
  const fetch = createMcpFetchPolicy({ serviceUrl, fetch: async () =>
    new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="mail.send"' } }) });
  const response = await fetch("https://sse-step-up.example.test/messages?sessionId=abc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "send", arguments: {} } }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(mcpInteractiveAuthorizationScope(serviceUrl, "mail.read")?.split(" ").sort(), ["mail.read", "mail.send"]);
  clearMcpStepUpScope(serviceUrl);
  // A non-MCP request on the same origin (an OAuth form POST) records nothing.
  await fetch("https://sse-step-up.example.test/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" });
  assert.equal(mcpInteractiveAuthorizationScope(serviceUrl, "mail.read"), "mail.read");
});

test("OAuth endpoint and metadata URL helpers isolate remote servers from loopback, plaintext, credentials, and fragments", async () => {
  const {
    mcpOAuthMetadataUrlForServer,
    parseMcpOAuthEndpointUrl,
    parseMcpOAuthMetadataUrl,
  } = await import("../../renderer/shared/mcp-oauth-config.js");

  const remoteService = "https://remote-mcp.example/mcp";
  for (const rejected of [
    "http://remote-auth.example/authorize",
    "http://127.0.0.1:3000/authorize",
    "https://127.0.0.1:3000/authorize",
    "https://127.0.0.2:3000/authorize",
    "https://localhost:3000/authorize",
    "https://idp.localhost:3000/authorize",
    "https://[::1]:3000/authorize",
    "https://[::]:3000/authorize",
    "https://0.0.0.0:3000/authorize",
    "https://169.254.169.254/latest/meta-data",
    "https://[fe80::1]/authorize",
    "https://[::ffff:127.0.0.1]/authorize",
    "https://[64:ff9b::127.0.0.1]/authorize",
    "https://canary-user:canary-pass@remote-auth.example/authorize",
    "https://canary-user@remote-auth.example/authorize",
    "https://remote-auth.example/authorize#fragment",
  ]) {
    assert.throws(() => parseMcpOAuthEndpointUrl(rejected, remoteService), /OAuth endpoint URL/u, rejected);
    assert.throws(() => parseMcpOAuthMetadataUrl(rejected, remoteService), /OAuth metadata URL/u, rejected);
  }

  assert.equal(
    parseMcpOAuthEndpointUrl("https://remote-auth.example/authorize?client_id=a", remoteService),
    "https://remote-auth.example/authorize?client_id=a",
  );
  assert.throws(
    () => mcpOAuthMetadataUrlForServer({ transport: "http", oauth: true, url: remoteService, authServerMetadataUrl: "http://127.0.0.1:3000/metadata" }),
    /OAuth metadata URL/u,
  );
  assert.equal(
    mcpOAuthMetadataUrlForServer({ transport: "http", oauth: true, url: "http://127.0.0.1:8080/mcp", authServerMetadataUrl: "http://127.0.0.1:3000/metadata" }),
    "http://127.0.0.1:3000/metadata",
  );
  assert.equal(
    mcpOAuthMetadataUrlForServer({ transport: "http", oauth: true, authServerMetadataUrl: "http://127.0.0.1:3000/metadata" }),
    "http://127.0.0.1:3000/metadata",
  );

  for (const loopbackService of ["http://127.0.0.1:8080/mcp", "http://localhost:8080/mcp", "http://[::1]:8080/mcp"]) {
    assert.equal(
      parseMcpOAuthEndpointUrl("http://127.0.0.1:9000/token", loopbackService),
      "http://127.0.0.1:9000/token",
    );
    assert.throws(() => parseMcpOAuthEndpointUrl("http://remote-auth.example/token", loopbackService), /HTTPS/u);
    assert.throws(() => parseMcpOAuthEndpointUrl("http://user:pass@127.0.0.1:9000/token", loopbackService), /credentials/u);
  }
});

test("saveDiscovery, authorizationUrl, and metadata overrides reject loopback, HTTP, and credentialed endpoints for remote servers", async () => {
  const { loadMcpOAuthMetadataOverride } = await import("./mcp-oauth-metadata.js");
  const remoteService = "https://remote-mcp.example/mcp";
  const validMetadata = {
    issuer: "https://remote-auth.example",
    authorization_endpoint: "https://remote-auth.example/authorize",
    token_endpoint: "https://remote-auth.example/token",
    registration_endpoint: "https://remote-auth.example/register",
    response_types_supported: ["code"],
  };

  for (const badState of [
    {
      authorizationServerUrl: "http://127.0.0.1:4000",
      authorizationServerMetadata: { ...validMetadata, issuer: "http://127.0.0.1:4000" },
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      resourceMetadataUrl: "http://127.0.0.1:4000/.well-known/oauth-protected-resource",
      authorizationServerMetadata: validMetadata,
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      resourceMetadata: { resource: remoteService, authorization_servers: ["http://127.0.0.1:4000"] },
      authorizationServerMetadata: validMetadata,
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      authorizationServerMetadata: { ...validMetadata, authorization_endpoint: "http://canary-user:canary-pass@remote-auth.example/authorize" },
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      authorizationServerMetadata: { ...validMetadata, authorization_endpoint: "https://canary-user:canary-pass@remote-auth.example/authorize" },
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      authorizationServerMetadata: { ...validMetadata, token_endpoint: "http://127.0.0.1:4000/token" },
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      authorizationServerMetadata: { ...validMetadata, token_endpoint: "https://127.0.0.1:4000/token" },
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      authorizationServerMetadata: { ...validMetadata, registration_endpoint: "http://127.0.0.1:4000/register" },
    },
    {
      authorizationServerUrl: "https://remote-auth.example",
      authorizationServerMetadata: { ...validMetadata, registration_endpoint: "https://localhost:4000/register" },
    },
  ]) {
    const flow = new McpOAuthAuthorizationFlow(remoteService);
    assert.throws(() => flow.saveDiscovery(badState), /OAuth endpoint URL/u);
    assert.equal(flow.discoveryState(), undefined);
  }

  const remoteFlow = new McpOAuthAuthorizationFlow(remoteService);
  assert.throws(() => remoteFlow.authorizationUrl(new URL(`http://remote-auth.example/authorize?state=${remoteFlow.state}`)), /HTTPS/u);
  assert.throws(() => remoteFlow.authorizationUrl(new URL(`https://user:pass@remote-auth.example/authorize?state=${remoteFlow.state}`)), /credentials/u);
  assert.throws(() => remoteFlow.authorizationUrl(new URL(`https://127.0.0.1:4443/authorize?state=${remoteFlow.state}`)), /loopback/u);

  const loopbackFlow = new McpOAuthAuthorizationFlow("http://127.0.0.1:8080/mcp");
  loopbackFlow.saveDiscovery({
    authorizationServerUrl: "http://127.0.0.1:8080",
    authorizationServerMetadata: {
      issuer: "http://127.0.0.1:8080",
      authorization_endpoint: "http://127.0.0.1:8080/authorize",
      token_endpoint: "http://127.0.0.1:8080/token",
      registration_endpoint: "http://127.0.0.1:8080/register",
      response_types_supported: ["code"],
    },
  });
  assert.equal(
    loopbackFlow.authorizationUrl(new URL(`http://127.0.0.1:8080/authorize?state=${loopbackFlow.state}`)).origin,
    "http://127.0.0.1:8080",
  );

  await assert.rejects(
    loadMcpOAuthMetadataOverride("http://127.0.0.1:4000/config", { serviceUrl: remoteService, fetch: async () => Response.json(validMetadata) }),
    /HTTPS/u,
  );
  await assert.rejects(
    loadMcpOAuthMetadataOverride("https://remote-auth.example/config", {
      serviceUrl: remoteService,
      fetch: async () => Response.json({ ...validMetadata, registration_endpoint: "https://127.0.0.1:4000/register" }),
    }),
    /loopback/u,
  );
  await assert.rejects(
    loadMcpOAuthMetadataOverride("https://remote-auth.example/config", {
      serviceUrl: remoteService,
      fetch: async (input) => String(input).includes("oauth-protected-resource")
        ? Response.json({ resource: remoteService, authorization_servers: ["http://127.0.0.1:4000"] })
        : Response.json(validMetadata),
    }),
    /HTTPS/u,
  );
});

test("remote MCP transport rejects untrusted WWW-Authenticate resource_metadata URLs before discovery across interactive and refresh flows", async () => {
  const { OAuthInsecureEndpointError } = await import("@earendil-works/pi-mcp/oauth");
  const serviceUrl = "https://remote-mcp.example/mcp";

  for (const untrustedResourceMetadata of [
    "http://127.0.0.1:9100/canary-resource-metadata",
    "https://127.0.0.1:9100/canary-resource-metadata",
    "https://localhost:9100/canary-resource-metadata",
    "http://remote-auth.example/canary-resource-metadata",
    "https://user:secret@remote-auth.example/canary-resource-metadata",
  ]) {
    for (const withLock of [false, true]) {
      const seenUrls: string[] = [];
      const flow = new McpOAuthAuthorizationFlow(serviceUrl);
      const base = recordingProvider(flow, {
        tokens: () => ({ access_token: "expired-token", token_type: "Bearer", refresh_token: "refresh-token" }),
      }).provider;
      const provider = withLock
        ? { ...base, withRefreshLock: <T>(operation: () => Promise<T>) => operation() }
        : base;

      const transport = createMcpRemoteTransport({
        serviceUrl,
        authProvider: provider,
        fetch: async (input) => {
          const url = new URL(String(input));
          seenUrls.push(url.href);
          if (url.href === serviceUrl) {
            return new Response(null, {
              status: 401,
              headers: { "www-authenticate": `Bearer resource_metadata="${untrustedResourceMetadata}"` },
            });
          }
          throw new Error(`Untrusted resource_metadata caused unexpected fetch to ${url.href}`);
        },
      });
      const client = new McpClient({ name: "www-auth-ssrf", version: "1" });
      try {
        await assert.rejects(client.connect(transport), (error: unknown) => {
          assert.ok(error instanceof OAuthInsecureEndpointError, `expected OAuthInsecureEndpointError, got ${String(error)}`);
          assert.doesNotMatch(error.message, /secret/u);
          return true;
        });
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
      assert.deepEqual(seenUrls, [serviceUrl], `no discovery request should follow ${untrustedResourceMetadata}`);
    }
  }
});

test("MCP fetch policy enforces DNS and socket IP guards for public and private enterprise remote servers", async () => {
  const { createMcpFetchPolicy } = await import("./mcp-fetch-policy.js");
  type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void;

  const lookupFrom = (table: Record<string, { address: string; family: number }[]>) =>
    ((hostname: string, _options: unknown, callback: LookupCallback) => {
      const entries = table[hostname];
      if (!entries) {
        callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), []);
        return;
      }
      callback(null, entries);
    }) as unknown as typeof import("node:dns").lookup;

  // 1. Public remote MCP server blocks loopback, link-local, private IPs, and mixed public+private answers.
  for (const blockedTargetIp of [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
    { address: "::ffff:127.0.0.1", family: 6 },
    { address: "169.254.169.254", family: 4 },
    { address: "fe80::1", family: 6 },
    { address: "10.0.0.8", family: 4 },
    { address: "192.168.1.20", family: 4 },
    { address: "fd00::1", family: 6 },
  ]) {
    let dispatched = false;
    const policy = createMcpFetchPolicy({
      serviceUrl: "https://public-mcp.example/mcp",
      lookup: lookupFrom({
        "public-mcp.example": [{ address: "93.184.216.34", family: 4 }],
        "oauth-target.example": [blockedTargetIp],
      }),
      fetch: async () => {
        dispatched = true;
        return Response.json({ ok: true });
      },
    });
    await assert.rejects(
      policy("https://oauth-target.example/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token",
      }),
      /Could not reach oauth-target\.example/u,
      blockedTargetIp.address,
    );
    assert.equal(dispatched, false, `request to ${blockedTargetIp.address} must not dispatch`);
  }

  // Mixed public + private DNS response and post-latch DNS rebinding of service host are refused.
  let rebindCalls = 0;
  let rebindDispatched = 0;
  const rebindingPolicy = createMcpFetchPolicy({
    serviceUrl: "https://public-mcp.example/mcp",
    lookup: ((hostname: string, _options: unknown, callback: LookupCallback) => {
      if (hostname === "mixed-auth.example") {
        callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]);
        return;
      }
      rebindCalls += 1;
      callback(null, rebindCalls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.7", family: 4 }]);
    }) as unknown as typeof import("node:dns").lookup,
    fetch: async () => {
      rebindDispatched += 1;
      return Response.json({ ok: true });
    },
  });
  const firstResponse = await rebindingPolicy("https://public-mcp.example/.well-known/oauth-authorization-server");
  assert.equal(firstResponse.status, 200);
  assert.equal(rebindDispatched, 1);
  await assert.rejects(rebindingPolicy("https://mixed-auth.example/token", { method: "POST", body: "a=1" }), /Could not reach mixed-auth\.example/u);
  await assert.rejects(rebindingPolicy("https://public-mcp.example/token", { method: "POST", body: "a=1" }), /Could not reach public-mcp\.example/u);
  assert.equal(rebindDispatched, 1);

  // 2. Private enterprise HTTPS server allows private enterprise OAuth hosts while blocking loopback and link-local IPs.
  let enterpriseCalls = 0;
  const enterprisePolicy = createMcpFetchPolicy({
    serviceUrl: "https://mcp.corp.internal/mcp",
    lookup: lookupFrom({
      "mcp.corp.internal": [{ address: "10.20.30.40", family: 4 }],
      "sso.corp.internal": [{ address: "10.20.30.41", family: 4 }],
      "loopback.corp.internal": [{ address: "127.0.0.1", family: 4 }],
      "imds.corp.internal": [{ address: "169.254.169.254", family: 4 }],
    }),
    fetch: async () => {
      enterpriseCalls += 1;
      return Response.json({ ok: true });
    },
  });
  assert.equal((await enterprisePolicy("https://sso.corp.internal/.well-known/oauth-authorization-server")).status, 200);
  assert.equal(enterpriseCalls, 1);
  await assert.rejects(enterprisePolicy("https://loopback.corp.internal/token", { method: "POST", body: "a=1" }), /Could not reach loopback\.corp\.internal/u);
  await assert.rejects(enterprisePolicy("https://imds.corp.internal/.well-known/oauth-authorization-server"), /Could not reach imds\.corp\.internal/u);
  assert.equal(enterpriseCalls, 1);
});

