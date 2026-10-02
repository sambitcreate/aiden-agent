import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMcpOAuthSessionData,
  mcpAuthorizationBinding,
  McpOAuthSessionTransaction,
  McpOAuthAuthorizationFlow,
  parseMcpOAuthSession,
  publicMcpClientInformation,
  sessionMatchesMcpBinding,
  sessionForFreshMcpAuthorization,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

test("fresh MCP authorization preserves registration and drops tokens plus verifier", () => {
  const session = {
    clientInformation: { client_id: "client-1" },
    tokens: { access_token: "old-token", token_type: "bearer" },
    codeVerifier: "old-verifier",
  } as McpOAuthSession;
  session.authorizationBinding = "https://mcp.example.test/mcp";

  assert.deepEqual(sessionForFreshMcpAuthorization(session, session.authorizationBinding), {
    authorizationBinding: session.authorizationBinding,
    clientInformation: session.clientInformation,
  });
  assert.equal(session.tokens?.access_token, "old-token", "the rollback snapshot must not mutate");
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

test("dynamic registration secrets are not retained for the public PKCE client", () => {
  assert.deepEqual(
    publicMcpClientInformation({
      client_id: "public-client",
      redirect_uris: ["http://127.0.0.1/callback"],
      client_secret: "must-not-persist",
      client_secret_expires_at: 123,
    }),
    {
      client_id: "public-client",
      redirect_uris: ["http://127.0.0.1/callback"],
    },
  );
  assert.deepEqual(
    sessionForFreshMcpAuthorization(
      {
        authorizationBinding: "https://mcp.example.test/mcp",
        clientInformation: {
          client_id: "public-client",
          redirect_uris: ["http://127.0.0.1/callback"],
          client_secret: "must-not-persist",
        },
      },
      "https://mcp.example.test/mcp",
    ),
    {
      authorizationBinding: "https://mcp.example.test/mcp",
      clientInformation: {
        client_id: "public-client",
        redirect_uris: ["http://127.0.0.1/callback"],
      },
    },
  );
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
  assert.deepEqual(sessionForFreshMcpAuthorization(session, "https://mcp.example.test/mcp?tenant=two"), {
    authorizationBinding: "https://mcp.example.test/mcp?tenant=two",
  });
});

test("pinned SDK discovery and token exchange use the issuer bound before the browser opens", async () => {
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
  const options = { serverUrl: "https://mcp.example.test/mcp", scope: "files.write", fetchFn };
  assert.equal(await auth(provider, options), "REDIRECT");
  assert.equal(browserUrl?.searchParams.get("scope"), "files.read files.write");
  const callback = new URL(`http://127.0.0.1:49152/callback?state=${flow.state}&code=trusted-code&iss=https://wrong.example.test`);
  assert.throws(() => flow.callback(callback), /issuer/u);
  assert.equal(exchanged, 0);
  callback.searchParams.set("iss", "https://accounts.example.test");
  const accepted = flow.callback(callback);
  assert.ok("code" in accepted);
  assert.equal(await auth(provider, { ...options, authorizationCode: accepted.code }), "AUTHORIZED");
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
