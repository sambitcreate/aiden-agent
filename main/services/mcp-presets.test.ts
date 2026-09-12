import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMcpPresetServer,
  createNoRedirectFetch,
  mcpOAuthClientNameForServer,
  MCP_PRESETS,
  getMcpPreset,
  getMcpPresetForServerId,
  presetSecretId,
  presetServerId,
  serverFromPreset,
} from "./mcp-presets.js";

test("catalog entries are well-formed", () => {
  assert.ok(MCP_PRESETS.length >= 20, "expected Composio plus hosted Codex MCP plugins Aiden can authorize");
  const ids = new Set(MCP_PRESETS.map((p) => p.id));
  assert.equal(ids.size, MCP_PRESETS.length, "preset ids must be unique");
  for (const preset of MCP_PRESETS) {
    assert.match(preset.id, /^[a-z0-9-]+$/);
    assert.ok(preset.name.length > 0);
    assert.ok(preset.tagline.length > 0);
    assert.ok(preset.vendor.startsWith("By "));
    assert.ok(preset.category.length > 0);
    assert.equal(preset.transport, "http");
    assert.match(preset.url, /^https:\/\//);
    assert.match(preset.docsUrl, /^https:\/\//);
    if (preset.auth.kind === "apiKey") {
      assert.ok(preset.auth.headerName.length > 0);
      assert.ok(preset.auth.keyLabel.length > 0);
      assert.match(preset.auth.keyHelpUrl, /^https:\/\//);
    }
    assert.equal(new URL(preset.url).origin.length > 0, true);
  }
});

test("catalog includes composio (apiKey) and hosted Codex OAuth plugins", () => {
  const composio = getMcpPreset("composio");
  assert.equal(composio?.auth.kind, "apiKey");
  if (composio?.auth.kind === "apiKey") {
    assert.equal(composio.auth.headerName, "x-consumer-api-key");
  }
  assert.equal(getMcpPreset("notion")?.auth.kind, "oauth");
  assert.equal(getMcpPreset("linear")?.auth.kind, "oauth");
  assert.equal(getMcpPreset("github")?.auth.kind, "apiKey");
  assert.equal(getMcpPreset("figma")?.url, "https://mcp.figma.com/mcp");
  const figmaAuth = getMcpPreset("figma")?.auth;
  assert.equal(figmaAuth?.kind, "oauth");
  if (figmaAuth?.kind === "oauth") {
    assert.equal(figmaAuth.clientName, "Codex");
  }
  assert.equal(mcpOAuthClientNameForServer({ id: "preset-figma", presetId: "figma" }), "Codex");
  assert.equal(mcpOAuthClientNameForServer({ id: "preset-notion", presetId: "notion" }), "Aiden Agent");
  assert.equal(getMcpPreset("superpowers"), undefined);
  assert.equal(getMcpPreset("nope"), undefined);
});

test("presetServerId and presetSecretId are deterministic", () => {
  assert.equal(presetServerId("composio"), "preset-composio");
  assert.equal(presetSecretId("preset-composio"), "mcp:preset-composio");
  assert.equal(getMcpPresetForServerId("preset-notion")?.id, "notion");
  assert.equal(getMcpPresetForServerId("notion"), undefined);
});

test("serverFromPreset builds an enabled http server with preset defaults", () => {
  const composio = getMcpPreset("composio");
  assert.ok(composio);
  const server = serverFromPreset(composio);
  assert.deepEqual(server, {
    id: "preset-composio",
    name: "Composio",
    transport: "http",
    url: "https://connect.composio.dev/mcp",
    oauth: undefined,
    presetId: "composio",
    enabled: true,
  });
  assert.equal(composio.category, "Productivity");
});

test("serverFromPreset sets oauth and allows only provider-owned endpoint paths", () => {
  const notion = getMcpPreset("notion");
  assert.ok(notion);
  const server = serverFromPreset(notion, "  https://mcp.notion.com/mcp/session/abc  ");
  assert.equal(server.oauth, true);
  assert.equal(server.url, "https://mcp.notion.com/mcp/session/abc");
  // Blank url falls back to the preset default.
  assert.equal(serverFromPreset(notion, "   ").url, notion.url);
  assert.throws(
    () => serverFromPreset(notion, "https://attacker.invalid/mcp"),
    /official secure server/,
  );
});

test("hosted Figma credentials stay on mcp.figma.com", () => {
  const figma = getMcpPreset("figma");
  assert.ok(figma);
  const server = serverFromPreset(figma, "https://mcp.figma.com/mcp/session/abc");
  assert.equal(server.oauth, true);
  assert.throws(
    () => serverFromPreset(figma, "https://api.figma.com/mcp"),
    /official secure server/,
  );
});

test("GitHub remote MCP stays on api.githubcopilot.com with a Bearer PAT", () => {
  const github = getMcpPreset("github");
  assert.ok(github);
  assert.equal(github.auth.kind, "apiKey");
  if (github.auth.kind === "apiKey") {
    assert.equal(github.auth.headerName, "Authorization");
    assert.equal(github.auth.headerValuePrefix, "Bearer ");
  }
  const server = serverFromPreset(github);
  assert.equal(server.oauth, undefined);
  assert.equal(server.url, "https://api.githubcopilot.com/mcp/");
  assert.throws(
    () => serverFromPreset(github, "https://github.com/mcp"),
    /official secure server/,
  );
});

test("preset validation binds credentials to exact identities and HTTPS origins", () => {
  const composio = getMcpPreset("composio");
  assert.ok(composio);
  const valid = serverFromPreset(composio, "https://connect.composio.dev/mcp/session/abc");
  assert.equal(assertMcpPresetServer(valid)?.id, "composio");
  assert.equal(
    assertMcpPresetServer({
      id: "custom",
      name: "Custom",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    }),
    undefined,
  );

  assert.throws(
    () => assertMcpPresetServer({ ...valid, id: "preset-notion" }),
    /invalid identity/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, presetId: undefined }),
    /invalid identity/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, presetId: "unknown" }),
    /invalid identity/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, url: "http://connect.composio.dev/mcp" }),
    /official secure server/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, url: "https://connect.composio.dev.evil.test/mcp" }),
    /official secure server/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, url: "https://user:pass@connect.composio.dev/mcp" }),
    /official secure server/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, transport: "sse" }),
    /secure HTTP connection/,
  );
  assert.throws(
    () => assertMcpPresetServer({ ...valid, oauth: true }),
    /invalid authentication mode/,
  );
});

test("OAuth presets require OAuth while API-key presets reject it", () => {
  const notion = getMcpPreset("notion");
  assert.ok(notion);
  const notionServer = serverFromPreset(notion);
  assert.equal(assertMcpPresetServer(notionServer)?.auth.kind, "oauth");
  assert.throws(
    () => assertMcpPresetServer({ ...notionServer, oauth: undefined }),
    /invalid authentication mode/,
  );
});

test("API-key preset fetches cannot follow credential-bearing redirects", async () => {
  let observedRedirect: RequestRedirect | undefined;
  const guardedFetch = createNoRedirectFetch(
    (async (_input, init) => {
      observedRedirect = init?.redirect;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  );

  await guardedFetch("https://connect.composio.dev/mcp", {
    headers: { "x-consumer-api-key": "secret" },
    redirect: "follow",
  });
  assert.equal(observedRedirect, "error");
});
