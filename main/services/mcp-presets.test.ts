import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMcpPresetServer,
  mcpOAuthClientNameForServer,
  MCP_PRESETS,
  getMcpPreset,
  getMcpPresetForServerId,
  presetSecretId,
  presetServerId,
  serverFromPreset,
} from "./mcp-presets.js";
import { isConnectorAvailable } from "../../renderer/shared/connector-catalog.js";
import type { McpServer } from "./types.js";

const available = MCP_PRESETS.filter(isConnectorAvailable);
const availableHttp = available.filter((preset) => preset.transport === "http");

test("every available HTTP preset builds a server record that main accepts", () => {
  assert.ok(availableHttp.length >= 20);
  for (const preset of availableHttp) {
    const server = serverFromPreset(preset);
    assert.equal(server.id, presetServerId(preset.id));
    assert.equal(server.transport, "http");
    assert.equal(server.url, preset.url);
    assert.equal(server.oauth === true, preset.auth.kind === "oauth", `${preset.id} OAuth flag`);
    assert.equal(assertMcpPresetServer(server)?.id, preset.id);
    assert.equal(getMcpPresetForServerId(server.id)?.id, preset.id);
  }
});

test("presetServerId and presetSecretId are deterministic", () => {
  assert.equal(presetServerId("composio"), "preset-composio");
  assert.equal(presetSecretId("preset-composio"), "mcp:preset-composio");
  assert.equal(getMcpPresetForServerId("preset-notion")?.id, "notion");
  assert.equal(getMcpPresetForServerId("notion"), undefined);
  assert.equal(getMcpPreset("nope"), undefined);
});

test("hosted presets keep credentials on their exact catalog origin", () => {
  for (const preset of availableHttp.filter((entry) => !entry.local)) {
    const origin = new URL(preset.url).origin;
    // Provider-owned paths on the same origin are allowed.
    assert.equal(serverFromPreset(preset, `${origin}/mcp/session/abc`).url, `${origin}/mcp/session/abc`);
    for (const elsewhere of [
      `https://attacker.invalid/mcp`,
      `${origin.replace("https:", "http:")}/mcp`,
      `${origin}.evil.test/mcp`,
      origin.replace("https://", "https://user:pass@") + "/mcp",
    ]) {
      assert.throws(() => serverFromPreset(preset, elsewhere), /official secure server/u, `${preset.id} rejects ${elsewhere}`);
    }
  }
  // A blank address falls back to the catalog default.
  const notion = getMcpPreset("notion")!;
  assert.equal(serverFromPreset(notion, "   ").url, notion.url);
});

test("Figma Desktop connects without a credential and only to its loopback origin", () => {
  const desktop = getMcpPreset("figma-desktop");
  assert.ok(desktop);
  assert.equal(desktop.auth.kind, "none");
  const server = serverFromPreset(desktop);
  assert.deepEqual(server, {
    id: "preset-figma-desktop",
    name: "Figma Desktop",
    transport: "http",
    url: "http://127.0.0.1:3845/mcp",
    oauth: undefined,
    presetId: "figma-desktop",
    enabled: true,
  });
  for (const elsewhere of [
    "http://localhost:3845/mcp",
    "http://127.0.0.1:3846/mcp",
    "https://127.0.0.1:3845/mcp",
    "http://192.168.1.4:3845/mcp",
    "https://mcp.figma.com/mcp",
  ]) {
    assert.throws(() => serverFromPreset(desktop, elsewhere), /only connects to http:\/\/127\.0\.0\.1:3845/u, elsewhere);
  }
  assert.throws(() => assertMcpPresetServer({ ...server, oauth: true }), /invalid authentication mode/u);
  assert.throws(() => assertMcpPresetServer({ ...server, headers: { Authorization: "Bearer x" } }), /does not take headers/u);
});

test("iMCP runs only the server inside its app in an Applications folder, with nothing added, and only on a Mac", () => {
  const imcp = getMcpPreset("imcp");
  assert.ok(imcp?.transport === "stdio");
  const mac = { platform: "darwin" as const, homedir: "/Users/me" };
  for (const command of [
    "/Applications/iMCP.app/Contents/MacOS/imcp-server",
    "/Users/me/Applications/iMCP.app/Contents/MacOS/imcp-server",
  ]) {
    assert.deepEqual(serverFromPreset(imcp, command, mac), {
      id: "preset-imcp",
      name: "iMCP",
      presetId: "imcp",
      enabled: true,
      transport: "stdio",
      command,
      args: [],
    });
  }
  const valid = serverFromPreset(imcp, "/Applications/iMCP.app/Contents/MacOS/imcp-server", mac);
  for (const command of [
    "",
    "imcp-server",
    "/Applications/iMCP.app/Contents/MacOS/iMCP",
    "/Applications/Other/iMCP.app/Contents/MacOS/imcp-server",
    "/Users/someone-else/Applications/iMCP.app/Contents/MacOS/imcp-server",
    "/Applications/iMCP.app/Contents/MacOS/../../../../bin/sh",
    "/tmp/imcp-server",
  ]) {
    assert.throws(() => assertMcpPresetServer({ ...valid, command }, mac), /only runs the server inside iMCP\.app/u, command);
  }
  assert.throws(() => assertMcpPresetServer({ ...valid, args: ["--evil"] }, mac), /no arguments or environment/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, env: { NODE_OPTIONS: "--require x" } }, mac), /no arguments or environment/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, transport: "http", url: "https://example.com/mcp" }, mac), /own app on this Mac/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, oauth: true }, mac), /own app on this Mac/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, headers: { Authorization: "x" } }, mac), /own app on this Mac/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, id: "preset-notion" }, mac), /invalid identity/u);
  // A record carried to Linux never runs.
  assert.throws(() => assertMcpPresetServer(valid, { platform: "linux", homedir: "/Users/me" }), /works only on a Mac/u);
});

test("hosted Figma is refused with its reason wherever main validates a preset", () => {
  const figma = getMcpPreset("figma");
  assert.ok(figma);
  assert.equal(isConnectorAvailable(figma), false);
  const record: McpServer = {
    id: "preset-figma",
    name: "Figma",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    oauth: true,
    presetId: "figma",
    enabled: true,
  };
  assert.throws(() => assertMcpPresetServer(record), /only lets approved apps connect/u);
  assert.throws(() => serverFromPreset(figma), /Use Figma Desktop instead/u);
});

test("preset identity, transport and authentication mode are bound together", () => {
  const composio = getMcpPreset("composio")!;
  const valid = serverFromPreset(composio, "https://connect.composio.dev/mcp/session/abc");
  assert.equal(
    assertMcpPresetServer({ id: "custom", name: "Custom", transport: "http", url: "https://example.com/mcp", enabled: true }),
    undefined,
  );
  assert.throws(() => assertMcpPresetServer({ ...valid, id: "preset-notion" }), /invalid identity/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, presetId: undefined }), /invalid identity/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, presetId: "unknown" }), /invalid identity/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, transport: "stdio" }), /own HTTP connection/u);
  assert.throws(() => assertMcpPresetServer({ ...valid, oauth: true }), /invalid authentication mode/u);
  const notion = serverFromPreset(getMcpPreset("notion")!);
  assert.throws(() => assertMcpPresetServer({ ...notion, oauth: undefined }), /invalid authentication mode/u);
});

test("every server registers as Aiden Agent and presets cannot carry a pre-registered client", () => {
  for (const preset of MCP_PRESETS) {
    assert.equal(mcpOAuthClientNameForServer({ id: presetServerId(preset.id), presetId: preset.id }), "Aiden Agent");
  }
  assert.equal(mcpOAuthClientNameForServer({ id: "custom" }), "Aiden Agent");
  const notion = serverFromPreset(getMcpPreset("notion")!);
  assert.throws(() => assertMcpPresetServer({ ...notion, oauthClientId: "manual" }), /OAuth/u);
});
