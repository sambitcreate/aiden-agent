import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./mcp-settings.tsx", import.meta.url), "utf8");

test("plugins settings browse the shared catalog and keep custom MCP setup", () => {
  assert.match(source, /Browse plugins, connect hosted MCP servers, or add your own/u);
  assert.match(source, /Listing a plugin does not/u);
  assert.match(source, /workspace/u);
  assert.match(source, /filterPluginCatalog/u);
  assert.match(source, /PLUGIN_CATALOG/u);
  assert.match(source, /mcpServerDraftForEditor/u);
  assert.match(source, /Add custom MCP/u);
  assert.match(source, /aria-label="Search plugins"/u);
  assert.doesNotMatch(source, /focus-within:border-focus-ring/u);
  assert.doesNotMatch(source, /Popular MCPs/u);
  assert.match(source, /Aiden stores credentials on this device/u);
  assert.doesNotMatch(source, /Aiden stores credentials on this Mac/u);
  assert.ok(source.indexOf("Add custom MCP") < source.indexOf("Plugin directory"));
});


test("OAuth metadata field labels optional setup and exposes invalid addresses accessibly", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { McpOAuthMetadataField, mcpOAuthMetadataFieldError } = await import("./mcp-oauth-metadata-field.js");
  const { createElement } = await import("react");
  const render = (value: string) => renderToStaticMarkup(createElement(McpOAuthMetadataField, { value, onChange() {} }));
  const defaults = render("");
  assert.match(defaults, /aria-label="Authorization metadata URL"/u);
  assert.match(defaults, /placeholder="Automatic discovery"/u);
  assert.doesNotMatch(defaults, /role="alert"/u);
  assert.match(defaults, /requires signing in again/u);
  const invalid = render("http://remote.test/metadata");
  assert.match(invalid, /aria-invalid="true"/u);
  assert.match(invalid, /role="alert"/u);
  assert.equal(mcpOAuthMetadataFieldError("https://identity.test/.well-known/openid-configuration"), undefined);
  assert.equal(mcpOAuthMetadataFieldError(""), undefined);
  assert.ok(mcpOAuthMetadataFieldError("file:///tmp/metadata"));
});


test("provider credential consent identifies the exact endpoint and separates saving from approval", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { McpProviderAuthFields } = await import("./mcp-provider-auth-fields.js");
  const props = { providerId: "openai", endpoint: "https://tools.test/mcp?tenant=one", approved: false, busy: false, disabled: false, providers: [{ id: "openai", label: "OpenAI" }], onProviderChange() {}, onConsent() {} };
  const html = renderToStaticMarkup(createElement(McpProviderAuthFields, props));
  assert.match(html, /https:\/\/tools.test\/mcp\?tenant=one/u);
  assert.match(html, /Allow provider credential/u);
  assert.match(html, /Saving the server does not grant access/u);
  assert.match(html, /each device needs your approval/u);
  assert.match(html, /Only attended desktop workspace chats/u);
  const approved = renderToStaticMarkup(createElement(McpProviderAuthFields, { ...props, approved: true }));
  assert.match(approved, /Stop sharing credential/u);
  assert.match(approved, /Approved on this device/u);
});
