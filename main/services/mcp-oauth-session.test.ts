import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMcpOAuthSessionData,
  mcpAuthorizationBinding,
  McpOAuthSessionTransaction,
  parseMcpOAuthSession,
  publicMcpClientInformation,
  sessionMatchesMcpBinding,
  sessionForFreshMcpAuthorization,
  type McpOAuthSession,
} from "./mcp-oauth-session.js";

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
  ]) {
    assert.throws(() => parseMcpOAuthSession(malformed), /MCP OAuth/u);
  }
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
