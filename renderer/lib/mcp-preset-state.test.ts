import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpPresetCardStatus,
  mcpPresetCredentialReady,
  mcpServerDraftForEditor,
  mcpServerEditorKind,
} from "./mcp-preset-state.js";
import type { McpLiveStatus, McpPreset, McpPresetState } from "./types.js";

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

test("a no-credential preset is ready without a key or sign-in", () => {
  assert.equal(
    mcpPresetCredentialReady({ auth: { kind: "none" }, hasStoredKey: false, draftKey: "", authorized: false }),
    true,
  );
});

test("card status follows the live connection, never saved state alone", () => {
  const live = (patch: Partial<McpLiveStatus>): McpLiveStatus => ({ serverId: "preset-notion", state: "closed", ...patch });
  const ready = state(oauthPreset, { configured: true, ready: true });
  assert.equal(mcpPresetCardStatus(state(apiKeyPreset), live({ state: "connected" })), null);
  assert.deepEqual(mcpPresetCardStatus(state(apiKeyPreset, { configured: true }), undefined), { label: "Needs key", color: "warning" });
  assert.deepEqual(mcpPresetCardStatus(state(oauthPreset, { configured: true }), undefined), { label: "Needs sign-in", color: "warning" });
  assert.deepEqual(
    mcpPresetCardStatus(state(oauthPreset, { configured: true, ready: true, error: "Invalid identity" }), live({ state: "connected" })),
    { label: "Needs repair", color: "red" },
  );
  assert.deepEqual(mcpPresetCardStatus({ ...ready, enabled: false }, live({ state: "connected" })), { label: "Off", color: "gray" });
  // Saved and signed in, but the connection is failing: never green.
  assert.deepEqual(mcpPresetCardStatus(ready, live({ state: "failed", error: "HTTP 500" })), { label: "Couldn’t connect", color: "red" });
  assert.deepEqual(mcpPresetCardStatus(ready, live({ state: "connected", needsSignIn: true })), { label: "Needs sign-in", color: "warning" });
  assert.deepEqual(mcpPresetCardStatus(ready, live({ state: "connecting" })), { label: "Connecting…", color: "gray" });
  assert.deepEqual(mcpPresetCardStatus(ready, undefined), { label: "Not connected yet", color: "gray" });
  // Before main's live snapshot loads, a ready card claims nothing; saved-state problems still show.
  assert.equal(mcpPresetCardStatus(ready, undefined, false), null);
  assert.deepEqual(mcpPresetCardStatus(state(apiKeyPreset, { configured: true }), undefined, false), { label: "Needs key", color: "warning" });
  assert.deepEqual(mcpPresetCardStatus(ready, live({ state: "closed" })), { label: "Idle", color: "gray" });
  assert.deepEqual(mcpPresetCardStatus(ready, live({ state: "connected" })), { label: "Connected", color: "green" });
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

test("removed presets reopen as custom drafts so save is not origin-locked", () => {
  const server = {
    id: "preset-github",
    name: "GitHub",
    transport: "http" as const,
    url: "https://api.githubcopilot.com/mcp/",
    oauth: true,
    presetId: "github",
    enabled: true,
  };
  const draft = mcpServerDraftForEditor(server, "missing-preset");
  assert.equal(draft.presetId, undefined);
  assert.equal(draft.id, "preset-github");
  assert.equal(draft.oauth, true);
  assert.equal(mcpServerDraftForEditor(server, "preset").presetId, "github");
  assert.equal(mcpServerDraftForEditor(server, "loading").presetId, "github");
});
