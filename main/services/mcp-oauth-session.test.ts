import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMcpOAuthSessionData,
  mcpAuthorizationBinding,
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
  assert.deepEqual(
    sessionForFreshMcpAuthorization(old, "https://attacker.example/mcp"),
    { authorizationBinding: "https://attacker.example/mcp" },
  );
  assert.equal(sessionMatchesMcpBinding(old, "https://attacker.example/mcp"), false);
});

test("authorization binding normalizes query, fragment, and trailing slash", () => {
  assert.equal(
    mcpAuthorizationBinding("https://MCP.Example.test/mcp/?tenant=a#fragment"),
    "https://mcp.example.test/mcp",
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
