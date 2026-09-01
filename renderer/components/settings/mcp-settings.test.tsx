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
  assert.ok(source.indexOf("Add custom MCP") < source.indexOf("Plugin directory"));
});
