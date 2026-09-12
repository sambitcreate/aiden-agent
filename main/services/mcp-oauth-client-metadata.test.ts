import assert from "node:assert/strict";
import test from "node:test";
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

test("Figma-style plaintext DCR 403 becomes a readable authorization error", () => {
  const raw = new Error(
    `ServerError: HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F', "Forbidden" is not valid JSON. Raw body: Forbidden`,
  );
  const explained = explainMcpOAuthFailure(raw);
  assert.match(explained.message, /rejected OAuth client registration/u);
  assert.equal(explained.cause, raw);
  assert.equal(Object.prototype.propertyIsEnumerable.call(explained, "cause"), false);
  const other = new Error("Authorization denied: access_denied");
  assert.equal(explainMcpOAuthFailure(other), other);
});

test("API-key header values accept a Bearer token with or without the prefix", () => {
  assert.equal(mcpApiKeyHeaderValue(" secret "), "secret");
  assert.equal(mcpApiKeyHeaderValue("ghp_abc", "Bearer "), "Bearer ghp_abc");
  assert.equal(mcpApiKeyHeaderValue("Bearer ghp_abc", "Bearer "), "Bearer ghp_abc");
});
