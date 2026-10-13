import assert from "node:assert/strict";
import test from "node:test";
import {
  filterPluginCatalog,
  isConnectablePlugin,
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_SOURCE_URL,
  PLUGIN_CATALOG_VERIFIED_ON,
  pluginCompatibilityLabel,
} from "./plugin-catalog.js";
import {
  assertMcpPresetServer,
  MCP_PRESETS,
  mcpPresetFromPlugin,
  serverFromPreset,
} from "../../main/services/mcp-presets.js";

test("plugin catalog ids are unique kebab-case entries from Codex plus Composio", () => {
  const ids = PLUGIN_CATALOG.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("composio"));
  assert.ok(ids.includes("linear"));
  assert.ok(ids.includes("superpowers"));
  assert.ok(ids.includes("crowdstrike-falcon-foundry"));
  assert.ok(PLUGIN_CATALOG.some(isConnectablePlugin));
  assert.ok(PLUGIN_CATALOG.some((plugin) => !isConnectablePlugin(plugin)));
  assert.equal(PLUGIN_CATALOG_SOURCE_URL, "https://github.com/openai/plugins");
  for (const plugin of PLUGIN_CATALOG) {
    assert.match(plugin.id, /^[a-z0-9-]+$/);
    assert.ok(plugin.name.length > 0);
    assert.ok(plugin.tagline.length > 0);
    assert.ok(plugin.vendor.startsWith("By "));
    assert.ok(plugin.category.length > 0);
    assert.match(plugin.docsUrl, /^https:\/\//);
    if (plugin.url) {
      // Every listed MCP endpoint, connectable or not, is HTTPS Streamable
      // HTTP without embedded credentials; legacy SSE endpoints are not offered.
      const url = new URL(plugin.url);
      assert.equal(url.protocol, "https:", `${plugin.id} uses HTTPS`);
      assert.doesNotMatch(url.pathname, /\/sse\/?$/u, `${plugin.id} uses an SSE endpoint`);
      assert.equal(url.username + url.password, "");
    }
    if (plugin.auth?.kind === "apiKey") assert.match(plugin.auth.keyHelpUrl, /^https:\/\//u);
    if (plugin.compatibility === "http-mcp") {
      assert.equal(plugin.transport, "http");
      assert.ok(plugin.url);
      assert.ok(plugin.auth);
      assert.equal(isConnectablePlugin(plugin), true);
    } else {
      assert.ok(plugin.compatibilityNote);
      assert.equal(isConnectablePlugin(plugin), false);
    }
  }
});

test("the catalog records when it was last reviewed against upstream", () => {
  assert.match(PLUGIN_CATALOG_VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/u);
  const verified = new Date(`${PLUGIN_CATALOG_VERIFIED_ON}T00:00:00Z`);
  assert.equal(verified.toISOString().slice(0, 10), PLUGIN_CATALOG_VERIFIED_ON, "a real calendar date");
  assert.ok(verified.getTime() <= Date.now(), "a review cannot be dated in the future");
});

test("search and compatibility filters keep connectable MCP separate from skills", () => {
  const slack = filterPluginCatalog(PLUGIN_CATALOG, "mcp.slack.com", "all", "all");
  assert.equal(slack.length, 1);
  assert.equal(slack[0]?.id, "slack");

  const connectable = filterPluginCatalog(PLUGIN_CATALOG, "", "all", "connectable");
  assert.ok(connectable.every(isConnectablePlugin));
  assert.ok(connectable.some((plugin) => plugin.id === "notion"));
  assert.ok(connectable.some((plugin) => plugin.id === "github"));
  assert.ok(!connectable.some((plugin) => plugin.id === "superpowers"));

  const skills = filterPluginCatalog(PLUGIN_CATALOG, "", "Developer Tools", "skills");
  assert.ok(skills.every((plugin) => plugin.compatibility === "skills"));
  assert.ok(skills.some((plugin) => plugin.id === "expo"));
  assert.match(
    skills[0]?.compatibilityNote ?? "",
    /does not add agent tools or workspace access/u,
  );

  const other = filterPluginCatalog(PLUGIN_CATALOG, "", "all", "other");
  assert.ok(other.some((plugin) => plugin.id === "slack"));
  assert.ok(other.some((plugin) => plugin.id === "teams"));
  assert.ok(other.some((plugin) => plugin.id === "build-ios-apps"));
  assert.ok(!other.some(isConnectablePlugin));
  assert.ok(!other.some((plugin) => plugin.compatibility === "skills"));

  assert.equal(pluginCompatibilityLabel("http-mcp"), "MCP");
  assert.equal(pluginCompatibilityLabel("chatgpt-app"), "ChatGPT app");
  assert.equal(pluginCompatibilityLabel("mcp-auth-unsupported"), "MCP (auth)");
});

test("every connectable plugin derives a built-in preset whose server record validates", () => {
  const connectable = PLUGIN_CATALOG.filter(isConnectablePlugin);
  assert.deepEqual(
    MCP_PRESETS.map((preset) => preset.id),
    connectable.map((plugin) => plugin.id),
  );
  for (const plugin of PLUGIN_CATALOG) {
    const preset = mcpPresetFromPlugin(plugin);
    if (!isConnectablePlugin(plugin)) {
      assert.equal(preset, undefined, `${plugin.id} is not connectable`);
      continue;
    }
    assert.ok(preset, `${plugin.id} derives a preset`);
    assert.deepEqual(
      { id: preset.id, name: preset.name, url: preset.url, auth: preset.auth, docsUrl: preset.docsUrl },
      { id: plugin.id, name: plugin.name, url: plugin.url, auth: plugin.auth, docsUrl: plugin.docsUrl },
    );
    const server = serverFromPreset(preset);
    assert.equal(assertMcpPresetServer(server)?.id, plugin.id);
    assert.equal(server.oauth === true, plugin.auth?.kind === "oauth");
  }
});
