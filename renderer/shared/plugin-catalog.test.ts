import assert from "node:assert/strict";
import test from "node:test";
import {
  filterPluginCatalog,
  isConnectablePlugin,
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_SOURCE_URL,
  pluginCompatibilityLabel,
} from "./plugin-catalog.js";

test("plugin catalog ids are unique kebab-case entries from Codex plus Composio", () => {
  const ids = PLUGIN_CATALOG.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("composio"));
  assert.ok(ids.includes("linear"));
  assert.ok(ids.includes("superpowers"));
  assert.ok(ids.includes("crowdstrike-falcon-foundry"));
  assert.equal(PLUGIN_CATALOG.length, 65);
  assert.equal(PLUGIN_CATALOG.filter(isConnectablePlugin).length, 20);
  assert.equal(
    PLUGIN_CATALOG.filter((plugin) => plugin.compatibility === "mcp-auth-unsupported").length,
    7,
  );
  assert.equal(PLUGIN_CATALOG_SOURCE_URL, "https://github.com/openai/plugins");
  for (const plugin of PLUGIN_CATALOG) {
    assert.match(plugin.id, /^[a-z0-9-]+$/);
    assert.ok(plugin.name.length > 0);
    assert.ok(plugin.tagline.length > 0);
    assert.ok(plugin.vendor.startsWith("By "));
    assert.ok(plugin.category.length > 0);
    assert.match(plugin.docsUrl, /^https:\/\//);
    if (plugin.compatibility === "http-mcp") {
      assert.equal(plugin.transport, "http");
      assert.ok(plugin.url);
      assert.match(plugin.url, /^https:\/\//);
      assert.ok(plugin.auth);
      assert.equal(isConnectablePlugin(plugin), true);
    } else {
      assert.ok(plugin.compatibilityNote);
      assert.equal(isConnectablePlugin(plugin), false);
    }
  }
});

test("search and compatibility filters keep connectable MCP separate from skills", () => {
  const slack = filterPluginCatalog(PLUGIN_CATALOG, "mcp.slack.com", "all", "all");
  assert.equal(slack.length, 1);
  assert.equal(slack[0]?.id, "slack");

  const connectable = filterPluginCatalog(PLUGIN_CATALOG, "", "all", "connectable");
  assert.ok(connectable.every(isConnectablePlugin));
  assert.ok(connectable.some((plugin) => plugin.id === "notion"));
  assert.ok(!connectable.some((plugin) => plugin.id === "superpowers"));

  const skills = filterPluginCatalog(PLUGIN_CATALOG, "", "Developer Tools", "skills");
  assert.ok(skills.every((plugin) => plugin.compatibility === "skills"));
  assert.ok(skills.some((plugin) => plugin.id === "expo"));
  assert.match(
    skills[0]?.compatibilityNote ?? "",
    /does not add agent tools or workspace access/u,
  );

  const other = filterPluginCatalog(PLUGIN_CATALOG, "", "all", "other");
  assert.ok(other.some((plugin) => plugin.id === "github"));
  assert.ok(other.some((plugin) => plugin.id === "teams"));
  assert.ok(other.some((plugin) => plugin.id === "build-ios-apps"));
  assert.ok(!other.some(isConnectablePlugin));
  assert.ok(!other.some((plugin) => plugin.compatibility === "skills"));

  assert.equal(pluginCompatibilityLabel("http-mcp"), "MCP");
  assert.equal(pluginCompatibilityLabel("chatgpt-app"), "ChatGPT app");
  assert.equal(pluginCompatibilityLabel("mcp-auth-unsupported"), "MCP (auth)");
});
