import assert from "node:assert/strict";
import test from "node:test";
import { discoverAuthorizationServerMetadata, registerClient } from "@earendil-works/pi-mcp/oauth";
import { readFileSync } from "node:fs";
import {
  AIDEN_MCP_CLIENT_METADATA_URL,
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

test("the checked-in client metadata document describes the client Aiden registers as", () => {
  // The document a hosted CIMD URL must serve (docs/mcp/aiden-agent-client-metadata.json).
  const document = JSON.parse(readFileSync(new URL("../../docs/mcp/aiden-agent-client-metadata.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const registered = mcpOAuthClientMetadata();
  for (const field of ["client_name", "redirect_uris", "grant_types", "response_types", "token_endpoint_auth_method", "application_type"] as const) {
    assert.deepEqual(document[field], registered[field], field);
  }
  const clientId = new URL(String(document.client_id));
  assert.equal(clientId.protocol, "https:", "a client ID metadata document URL must be HTTPS");
  assert.notEqual(clientId.pathname, "/", "and must have a path");
  if (AIDEN_MCP_CLIENT_METADATA_URL !== undefined) assert.equal(document.client_id, AIDEN_MCP_CLIENT_METADATA_URL, "the document names the URL it is served from");
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
    fetch: async () => new Response(`<html>${"Not found\n".repeat(500)}</html>`, { status: 404 }),
  }).then(() => undefined, (error: unknown) => error);
  const other = explainMcpOAuthFailure(notFound);
  assert.equal(other.message, "This MCP server rejected OAuth client registration (HTTP 404).", "the server's body never reaches Settings");
  assert.equal(other.cause, notFound);
  const described = await registerClient("https://other.example.test", {
    clientMetadata: mcpOAuthClientMetadata(),
    fetch: async () => Response.json({ error: "invalid_client_metadata", error_description: "redirect_uris\nmust be https" }, { status: 400 }),
  }).then(() => undefined, (error: unknown) => error);
  assert.equal(explainMcpOAuthFailure(described).message, "This MCP server rejected OAuth client registration (HTTP 400): redirect_uris must be https");
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
