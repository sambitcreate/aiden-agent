import assert from "node:assert/strict";
import test from "node:test";
import { discoverAuthorizationServerMetadata, registerClient } from "@earendil-works/pi-mcp/oauth";
import {
  DEFAULT_MCP_OAUTH_CLIENT_NAME,
  MCP_OAUTH_REDIRECT_URI,
  explainMcpOAuthFailure,
  mcpApiKeyHeaderValue,
  mcpOAuthClientMetadata,
} from "./mcp-oauth-client-metadata.js";

test("default MCP OAuth metadata is a native PKCE loopback client named Aiden Agent", () => {
  const metadata = mcpOAuthClientMetadata();
  assert.equal(metadata.client_name, DEFAULT_MCP_OAUTH_CLIENT_NAME);
  assert.equal(metadata.application_type, "native");
  assert.equal(metadata.token_endpoint_auth_method, "none");
  assert.deepEqual(metadata.redirect_uris, [MCP_OAUTH_REDIRECT_URI]);
  assert.match(MCP_OAUTH_REDIRECT_URI, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.deepEqual(mcpOAuthClientMetadata("  Codex  ").client_name, "Codex");
});

test("API-key header values accept a Bearer token with or without the prefix", () => {
  assert.equal(mcpApiKeyHeaderValue(" secret "), "secret");
  assert.equal(mcpApiKeyHeaderValue("ghp_abc", "Bearer "), "Bearer ghp_abc");
  assert.equal(mcpApiKeyHeaderValue("Bearer ghp_abc", "Bearer "), "Bearer ghp_abc");
});

test("a registration endpoint that answers 403 to dynamic registration gets a readable error", async () => {
  const raw = await registerClient("https://figma.example.test", {
    clientMetadata: mcpOAuthClientMetadata(),
    fetch: async () => new Response("Forbidden", { status: 403 }),
  }).then(() => assert.fail("registration must be rejected"), (error: unknown) => error);
  const explained = explainMcpOAuthFailure(raw);
  assert.match(explained.message, /rejected OAuth client registration/u);
  assert.equal(explained.cause, raw);
  assert.equal(Object.prototype.propertyIsEnumerable.call(explained, "cause"), false);
  const denied = new Error("Authorization denied: access_denied");
  assert.equal(explainMcpOAuthFailure(denied), denied);
  const notFound = await registerClient("https://other.example.test", {
    clientMetadata: mcpOAuthClientMetadata(),
    fetch: async () => new Response("Not found", { status: 404 }),
  }).then(() => undefined, (error: unknown) => error);
  assert.equal(explainMcpOAuthFailure(notFound), notFound, "other registration failures pass through unchanged");
});

test("authorization-server metadata with a mismatched issuer points at the metadata URL override", async () => {
  const raw = await discoverAuthorizationServerMetadata("https://login.example.test/tenant", {
    fetch: async () => Response.json({
      issuer: "https://login.example.test/other", authorization_endpoint: "https://login.example.test/authorize",
      token_endpoint: "https://login.example.test/token", response_types_supported: ["code"],
    }),
  }).then(() => assert.fail("a mismatched issuer must be refused"), (error: unknown) => error);
  const explained = explainMcpOAuthFailure(raw);
  assert.match(explained.message, /Authorization metadata URL/u);
  assert.equal(explained.cause, raw);
});
