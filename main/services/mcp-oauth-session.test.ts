import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMcpOAuthSessionData,
  mcpAuthorizationBinding,
  mcpScopeTokens,
  McpOAuthSessionTransaction,
  McpOAuthAuthorizationFlow,
  parseMcpOAuthSession,
  sessionMatchesMcpBinding,
  sameMcpOAuthGrant,
  sessionForFreshMcpAuthorization,
  sessionForMcpAuthorizationAttempt,
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
  type OAuthClientInformationMixed,
  type OAuthClientProvider,
} from "@earendil-works/pi-mcp/oauth";
import { createMcpRemoteFetch, createMcpRemoteTransport } from "./mcp-remote-transport.js";
import { MCP_OAUTH_REDIRECT_URI, mcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.js";

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
  const denied = flow.callback(new URL(`http://127.0.0.1/callback?state=${flow.state}&error=access_denied&error_description=secret`));
  assert.ok("error" in denied);
  assert.equal(denied.error.message, "Authorization was denied by the provider.");
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
      assert.equal(init?.redirect, "error");
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


test("token exchanges normalize optional null and empty fields before saving without weakening required credentials", async () => {
  const { createMcpFetchPolicy } = await import("./mcp-fetch-policy.js");
  const responses = [
    { access_token: "valid", token_type: "Bearer", scope: null, refresh_token: "", id_token: null, expires_in: null },
    { access_token: "valid", token_type: "Bearer", scope: "", refresh_token: null, id_token: "", expires_in: "3600" },
    { access_token: "", token_type: "Bearer", scope: null },
    { access_token: "valid", token_type: null, scope: null },
  ];
  const saved: unknown[] = [];
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1/callback", clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
    clientInformation: () => ({ client_id: "registered" }), tokens: () => undefined, saveTokens: (tokens) => { saved.push(tokens); },
    discoveryState: () => ({ authorizationServerUrl: "https://identity.test", resourceMetadata: { resource: "https://service.test/mcp" }, authorizationServerMetadata: { issuer: "https://identity.test", authorization_endpoint: "https://identity.test/authorize", token_endpoint: "https://identity.test/token", response_types_supported: ["code"] } }),
    saveCodeVerifier() {}, codeVerifier: () => "verifier", redirectToAuthorization() { throw new Error("Unexpected browser request"); },
  };
  for (const response of responses) {
    const fetchFn = createMcpFetchPolicy({ serviceUrl: "https://service.test/mcp", fetch: async () => Response.json(response) });
    if (response.access_token && response.token_type) assert.equal(await authorizeMcp(provider, { serverUrl: "https://service.test/mcp", authorizationCode: "code", fetch: fetchFn }), "AUTHORIZED");
    else await assert.rejects(authorizeMcp(provider, { serverUrl: "https://service.test/mcp", authorizationCode: "code", fetch: fetchFn }), /required credentials/u);
  }
  assert.deepEqual(saved, [{ access_token: "valid", token_type: "Bearer" }, { access_token: "valid", token_type: "Bearer", expires_in: 3600 }]);
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
      const provider: OAuthClientProvider & { observeAuthorizationMetadata: (url: URL, document: unknown) => void } = {
        redirectUrl: "http://127.0.0.1:49152/callback",
        clientMetadata: { redirect_uris: ["http://127.0.0.1:49152/callback"], token_endpoint_auth_method: "none" },
        clientInformation: () => ({ client_id: "registered-client" }),
        state: () => flow.state,
        tokens: () => undefined,
        saveTokens: () => {},
        saveDiscoveryState: (state) => flow.saveDiscovery(state),
        discoveryState: () => flow.discoveryState(),
        observeAuthorizationMetadata: (url, document) => flow.observeAuthorizationMetadata(url, document),
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


test("metadata observation rejects oversized wire documents and forgets policy after invalidation", async () => {
  const { withMcpOAuthMetadataObservation } = await import("./mcp-oauth-metadata.js");
  const flow = new McpOAuthAuthorizationFlow();
  const url = new URL("https://identity.test/.well-known/openid-configuration");
  let observed = 0;
  const fetch = withMcpOAuthMetadataObservation(async () => Response.json({ issuer: "https://identity.test", padding: "x".repeat(64 * 1024) }), () => { observed++; });
  await assert.rejects(fetch(url), /bounds/u);
  assert.equal(observed, 0);
  flow.observeAuthorizationMetadata(url, { issuer: "https://identity.test", authorization_response_iss_parameter_supported: true });
  flow.clearDiscovery();
  flow.saveDiscovery({ authorizationServerUrl: "https://identity.test", authorizationServerMetadata: { issuer: "https://identity.test", authorization_endpoint: "https://identity.test/authorize", token_endpoint: "https://identity.test/token", response_types_supported: ["code"] } });
  flow.authorizationUrl(new URL(`https://identity.test/authorize?state=${flow.state}`));
  assert.deepEqual(flow.callback(new URL(`http://127.0.0.1/callback?state=${flow.state}&code=allowed`)), { code: "allowed" });
});

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

test("an empty challenge scope falls back to the resource's scopes_supported instead of requesting \"\"", async () => {
  for (const challenge of ['Bearer scope="", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope=" "']) {
    const flow = new McpOAuthAuthorizationFlow();
    const { provider, record } = recordingProvider(flow, { clientInformation: () => ({ client_id: "registered" }) });
    await connectExpectingSignIn("https://mcp.example.test/mcp", provider, async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/mcp") return new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
      if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://login.example.test"], scopes_supported: ["files.read", "files.write"] });
      return rootMetadata("https://login.example.test");
    });
    assert.equal(record.browser?.searchParams.get("scope"), "files.read files.write", challenge);
  }
  const flow = new McpOAuthAuthorizationFlow();
  const url = flow.authorizationUrl(new URL(`https://login.example.test/authorize?state=${flow.state}&scope=%22%22`), "''");
  assert.equal(url.searchParams.has("scope"), false, "quote-only remnants are never requested as scopes");
});

test("null and empty optional members in metadata and registration responses do not fail dynamic registration", async () => {
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
  assert.deepEqual(record.client, { client_id: "dcr-client", redirect_uris: ["http://127.0.0.1:49152/callback"] });
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

/**
 * A local authorization server that, like Figma, Vercel and Supabase, only
 * accepts confidential clients: registration issues a client secret and the
 * token endpoint rejects any request that does not present it.
 */
async function startConfidentialOnlyAuthorizationServer(options: { scopesSupported?: string[] } = {}) {
  const { createServer } = await import("node:http");
  const clients = new Map<string, string>();
  const codes = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const seen = { registrations: 0, authorizeClientIds: [] as string[], rejectedTokenRequests: 0, grants: [] as string[] };
  let base = "";
  let issued = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", base);
      const body = Buffer.concat(chunks).toString("utf8");
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base], ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}) });
      }
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return json(200, {
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`, response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        seen.registrations += 1;
        const clientId = `client-${seen.registrations}`;
        const clientSecret = `secret-${seen.registrations}`;
        clients.set(clientId, clientSecret);
        // Echo the requested metadata (including token_endpoint_auth_method "none") and add a secret anyway.
        return json(201, { ...JSON.parse(body), client_id: clientId, client_secret: clientSecret, client_secret_expires_at: 0 });
      }
      if (url.pathname === "/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        seen.authorizeClientIds.push(clientId);
        // A server that dropped a registration shows an error page and never calls back.
        if (!clients.has(clientId)) { response.writeHead(400); return response.end("Unknown client"); }
        const code = `code-${++issued}`;
        codes.set(code, clientId);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { location: callback.href });
        return response.end();
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(body);
        let clientId = form.get("client_id");
        let clientSecret = form.get("client_secret");
        const basic = /^Basic\s+(.+)$/iu.exec(request.headers.authorization ?? "")?.[1];
        if (basic) {
          const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
          clientId = id;
          clientSecret = secret;
        }
        if (!clientId || !clientSecret || clients.get(clientId) !== clientSecret) {
          seen.rejectedTokenRequests += 1;
          return json(401, { error: "invalid_client", error_description: "Client ID and client secret are required" });
        }
        const grant = form.get("grant_type") ?? "";
        const owner = grant === "authorization_code" ? codes.get(form.get("code") ?? "") : refreshTokens.get(form.get("refresh_token") ?? "");
        if (owner !== clientId) return json(400, { error: "invalid_grant" });
        if (grant === "authorization_code") codes.delete(form.get("code")!);
        else refreshTokens.delete(form.get("refresh_token")!);
        seen.grants.push(grant);
        const refreshToken = `refresh-${++issued}`;
        refreshTokens.set(refreshToken, clientId);
        return json(200, { access_token: `access-${issued}`, token_type: "Bearer", refresh_token: refreshToken, expires_in: 3600 });
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake authorization server did not bind.");
  base = `http://127.0.0.1:${address.port}`;
  return { serviceUrl: `${base}/mcp`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * The desktop provider's persistence path without Electron: the session goes
 * through the same JSON + parse round trip as the encrypted store, so a new
 * provider instance reading it is what Aiden sees after a restart.
 */
function storeBackedProvider(
  store: Map<string, string>,
  serverId: string,
  binding: string,
  options: { transaction?: McpOAuthSessionTransaction; flow?: McpOAuthAuthorizationFlow } = {},
) {
  const flow = options.flow ?? new McpOAuthAuthorizationFlow();
  const read = (): McpOAuthSession => {
    const session = options.transaction ? options.transaction.read() : parseMcpOAuthSession(JSON.parse(store.get(serverId) ?? "{}"));
    return sessionMatchesMcpBinding(session, binding) ? session : { authorizationBinding: binding };
  };
  const write = (session: McpOAuthSession) => {
    if (options.transaction) options.transaction.replace(session);
    else store.set(serverId, JSON.stringify(session));
  };
  const browser: { url?: URL } = {};
  const provider: OAuthClientProvider = {
    redirectUrl: MCP_OAUTH_REDIRECT_URI,
    clientMetadata: mcpOAuthClientMetadata() as OAuthClientProvider["clientMetadata"],
    state: () => flow.state,
    saveDiscoveryState: (state) => flow.saveDiscovery(state),
    discoveryState: () => flow.discoveryState(),
    clientInformation: () => usableMcpClientInformation(read().clientInformation),
    // Dynamic registration always returns the full RFC 7591 document.
    saveClientInformation: (information) => write(sessionWithMcpClientInformation(read(), binding, information as OAuthClientInformationMixed)),
    tokens: () => read().tokens,
    saveTokens: (tokens) => write(sessionWithSavedMcpTokens(read(), binding, tokens, flow.requestedScope)),
    saveCodeVerifier: (codeVerifier) => write({ ...read(), codeVerifier }),
    codeVerifier: () => read().codeVerifier!,
    redirectToAuthorization: (url) => {
      if (!options.transaction) throw new Error("A background connection must not open a browser.");
      browser.url = flow.authorizationUrl(url, read().grantedScope);
    },
  };
  return { provider, flow, browser };
}

/** Settings → Authorize: a transactional attempt, the browser consent, the code exchange, then commit. */
async function interactiveSignIn(store: Map<string, string>, serverId: string, serviceUrl: string) {
  const { createMcpFetchPolicy } = await import("./mcp-fetch-policy.js");
  const binding = mcpAuthorizationBinding(serviceUrl);
  const previous = parseMcpOAuthSession(JSON.parse(store.get(serverId) ?? "{}"));
  const transaction = new McpOAuthSessionTransaction(sessionForMcpAuthorizationAttempt(previous, binding));
  const { provider, flow, browser } = storeBackedProvider(store, serverId, binding, { transaction });
  const fetchFn = createMcpFetchPolicy({ serviceUrl });
  assert.equal(await authorizeMcp(provider, { serverUrl: serviceUrl, fetch: fetchFn }), "REDIRECT");
  const consent = await fetch(browser.url!, { redirect: "manual" });
  assert.equal(consent.status, 302, "the authorization server accepted the client and called back");
  const callback = flow.callback(new URL(consent.headers.get("location")!));
  assert.ok("code" in callback);
  assert.equal(await authorizeMcp(provider, { serverUrl: serviceUrl, fetch: fetchFn, ...flow.codeExchange(callback.code) }), "AUTHORIZED");
  store.set(serverId, JSON.stringify(transaction.read()));
}

test("a confidential-only authorization server completes sign-in and refreshes after a restart", async () => {
  const { createMcpFetchPolicy } = await import("./mcp-fetch-policy.js");
  const authorizationServer = await startConfidentialOnlyAuthorizationServer();
  try {
    const store = new Map<string, string>();
    const { serviceUrl, seen } = authorizationServer;
    await interactiveSignIn(store, "preset-figma", serviceUrl);
    assert.deepEqual(seen.grants, ["authorization_code"]);
    assert.equal(seen.rejectedTokenRequests, 0);
    const signedIn = parseMcpOAuthSession(JSON.parse(store.get("preset-figma")!));
    assert.equal(signedIn.clientInformation?.client_id, "client-1");
    assert.ok(signedIn.tokens?.refresh_token);

    // Restart: a background provider reads the persisted session and refreshes.
    const { provider } = storeBackedProvider(store, "preset-figma", mcpAuthorizationBinding(serviceUrl));
    assert.equal(await authorizeMcp(provider, { serverUrl: serviceUrl, fetch: createMcpFetchPolicy({ serviceUrl }) }), "AUTHORIZED");
    assert.deepEqual(seen.grants, ["authorization_code", "refresh_token"]);
    assert.equal(seen.rejectedTokenRequests, 0);
    assert.equal(seen.registrations, 1, "a background refresh reuses the stored registration");
    const refreshed = parseMcpOAuthSession(JSON.parse(store.get("preset-figma")!));
    assert.notEqual(refreshed.tokens?.access_token, signedIn.tokens?.access_token);
  } finally {
    await authorizationServer.close();
  }
});

test("an interactive Authorize registers a fresh client instead of reusing one the server dropped", async () => {
  const authorizationServer = await startConfidentialOnlyAuthorizationServer();
  try {
    const { serviceUrl, seen } = authorizationServer;
    const binding = mcpAuthorizationBinding(serviceUrl);
    const store = new Map([["preset-figma", JSON.stringify({
      authorizationBinding: binding,
      clientInformation: { client_id: "forgotten-client", client_secret: "stale-secret", redirect_uris: [MCP_OAUTH_REDIRECT_URI] },
    } satisfies McpOAuthSession)]]);
    await interactiveSignIn(store, "preset-figma", serviceUrl);
    assert.equal(seen.registrations, 1);
    assert.deepEqual(seen.authorizeClientIds, ["client-1"]);
    assert.equal(parseMcpOAuthSession(JSON.parse(store.get("preset-figma")!)).clientInformation?.client_id, "client-1");
  } finally {
    await authorizationServer.close();
  }
});

test("re-authorizing keeps earlier granted scopes when the token response omits scope", async () => {
  const authorizationServer = await startConfidentialOnlyAuthorizationServer({ scopesSupported: ["files.read"] });
  try {
    const { serviceUrl } = authorizationServer;
    const binding = mcpAuthorizationBinding(serviceUrl);
    // An earlier step-up granted files.write; the resource advertises only files.read.
    const store = new Map([["server", JSON.stringify({ authorizationBinding: binding, grantedScope: "files.write" } satisfies McpOAuthSession)]]);
    await interactiveSignIn(store, "server", serviceUrl);
    const session = parseMcpOAuthSession(JSON.parse(store.get("server")!));
    assert.deepEqual(mcpScopeTokens(session.tokens?.scope).sort(), ["files.read", "files.write"]);
    assert.deepEqual(mcpScopeTokens(session.grantedScope).sort(), ["files.read", "files.write"]);
  } finally {
    await authorizationServer.close();
  }
});
