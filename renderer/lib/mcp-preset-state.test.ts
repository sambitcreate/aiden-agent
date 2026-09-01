import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpPresetConnectionBadge,
  mcpPresetCredentialReady,
  mcpServerEditorKind,
} from "./mcp-preset-state.js";
import type { McpPreset, McpPresetState } from "./types.js";

const apiKeyPreset: McpPreset = {
  id: "composio",
  name: "Composio",
  tagline: "Tools",
  vendor: "By Composio",
  category: "Productivity",
  transport: "http",
  url: "https://connect.composio.dev/mcp",
  auth: {
    kind: "apiKey",
    headerName: "x-consumer-api-key",
    keyLabel: "API key",
    keyHelpUrl: "https://dashboard.composio.dev",
  },
  docsUrl: "https://docs.composio.dev",
};

const oauthPreset: McpPreset = {
  ...apiKeyPreset,
  id: "notion",
  name: "Notion",
  vendor: "By Notion",
  url: "https://mcp.notion.com/mcp",
  auth: { kind: "oauth" },
};

function state(
  preset: McpPreset,
  patch: Partial<McpPresetState> = {},
): McpPresetState {
  return {
    preset,
    serverId: `preset-${preset.id}`,
    configured: false,
    enabled: true,
    ready: false,
    ...patch,
  };
}

test("API-key presets require a saved or nonblank draft key", () => {
  assert.equal(
    mcpPresetCredentialReady({
      auth: apiKeyPreset.auth,
      hasStoredKey: false,
      draftKey: "   ",
      authorized: false,
    }),
    false,
  );
  assert.equal(
    mcpPresetCredentialReady({
      auth: apiKeyPreset.auth,
      hasStoredKey: false,
      draftKey: "new-key",
      authorized: false,
    }),
    true,
  );
  assert.equal(
    mcpPresetCredentialReady({
      auth: apiKeyPreset.auth,
      hasStoredKey: true,
      draftKey: "",
      authorized: false,
    }),
    true,
  );
});

test("OAuth presets require a completed browser authorization", () => {
  assert.equal(
    mcpPresetCredentialReady({
      auth: oauthPreset.auth,
      hasStoredKey: true,
      draftKey: "irrelevant",
      authorized: false,
    }),
    false,
  );
  assert.equal(
    mcpPresetCredentialReady({
      auth: oauthPreset.auth,
      hasStoredKey: false,
      draftKey: "",
      authorized: true,
    }),
    true,
  );
});

test("preset badges distinguish configured, authenticated, and enabled states", () => {
  assert.equal(mcpPresetConnectionBadge(state(apiKeyPreset)), null);
  assert.deepEqual(
    mcpPresetConnectionBadge(state(apiKeyPreset, { configured: true })),
    { label: "Needs key", color: "red" },
  );
  assert.deepEqual(
    mcpPresetConnectionBadge(state(oauthPreset, { configured: true })),
    { label: "Needs sign-in", color: "red" },
  );
  assert.deepEqual(
    mcpPresetConnectionBadge(
      state(oauthPreset, { configured: true, ready: true, enabled: false }),
    ),
    { label: "Disabled", color: "secondary" },
  );
  assert.deepEqual(
    mcpPresetConnectionBadge(
      state(oauthPreset, { configured: true, ready: true }),
    ),
    { label: "Ready", color: "green" },
  );
});

test("preset servers never fall through to the generic editor while queries race", () => {
  const server = { id: "preset-notion", presetId: "notion" };
  assert.equal(mcpServerEditorKind({ id: "custom" }, false, []), "custom");
  assert.equal(mcpServerEditorKind(server, false, []), "loading");
  assert.equal(mcpServerEditorKind(server, true, []), "missing-preset");
  assert.equal(
    mcpServerEditorKind(server, true, [
      state(oauthPreset, { serverId: "preset-notion", configured: true }),
    ]),
    "preset",
  );
});
