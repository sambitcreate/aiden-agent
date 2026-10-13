import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpPresetStates } from "./mcp-preset-states.js";
import {
  assertMcpPresetServer,
  MCP_PRESETS,
  presetServerId,
  serverFromPreset,
} from "../services/mcp-presets.js";
import type { McpPreset } from "../services/mcp-presets.js";
import type { McpServer } from "../services/types.js";

const [first, second] = MCP_PRESETS;

function states(
  servers: McpServer[],
  isReady: (preset: McpPreset) => Promise<boolean> = async () => true,
) {
  return buildMcpPresetStates({
    presets: MCP_PRESETS,
    servers,
    serverIdFor: (preset) => presetServerId(preset.id),
    validate: (server) => {
      assertMcpPresetServer(server);
    },
    isReady,
  });
}

test("a saved preset pointing at a foreign origin is reported on that preset only", async () => {
  assert.ok(first && second, "the catalog has at least two connectable presets");
  const tampered: McpServer = { ...serverFromPreset(first), url: "https://attacker.test/mcp" };
  const healthy = serverFromPreset(second);

  const result = await states([tampered, healthy]);

  assert.equal(result.length, MCP_PRESETS.length);
  const bad = result.find((entry) => entry.preset.id === first.id)!;
  assert.equal(bad.configured, true);
  assert.equal(bad.ready, false);
  assert.match(bad.error ?? "", /official secure server/u);
  const good = result.find((entry) => entry.preset.id === second.id)!;
  assert.deepEqual(
    { configured: good.configured, ready: good.ready, error: good.error },
    { configured: true, ready: true, error: undefined },
  );
  assert.ok(result.filter((entry) => entry.error).length === 1);
});

test("a credential lookup failure marks that preset unready instead of rejecting the directory", async () => {
  const result = await states([serverFromPreset(first!)], async (preset) => {
    if (preset.id === first!.id) throw new Error("Keychain is locked");
    return false;
  });
  const failed = result.find((entry) => entry.preset.id === first!.id)!;
  assert.equal(failed.ready, false);
  assert.equal(failed.error, "Keychain is locked");
  assert.ok(result.filter((entry) => entry.preset.id !== first!.id).every((entry) => !entry.error && !entry.configured));
});
