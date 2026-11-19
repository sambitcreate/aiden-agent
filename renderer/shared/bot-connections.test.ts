import assert from "node:assert/strict";
import test from "node:test";
import { connectionSuggestionFor } from "./bot-connections.js";
import { COMPOSIO_APPS, getConnectorCatalogEntry, isConnectorAvailable } from "./connector-catalog.js";

test("a directly connectable catalog plugin opens its own preset setup", () => {
  assert.deepEqual(connectionSuggestionFor("notion"), {
    pluginId: "notion",
    name: "Notion",
    iconId: "notion",
    setupEntry: { kind: "mcp-preset", presetId: "notion" },
  });
  const composio = connectionSuggestionFor("composio");
  assert.deepEqual(composio?.setupEntry, { kind: "mcp-preset", presetId: "composio" });
});

test("apps Aiden cannot sign in to directly are set up through Composio", () => {
  const gmail = connectionSuggestionFor("gmail");
  assert.equal(gmail?.name, "Gmail");
  assert.deepEqual(gmail?.setupEntry, { kind: "composio", presetId: "composio", appName: "Gmail" });
  // The entry point must be a preset that the settings flow can actually finish.
  const composio = getConnectorCatalogEntry("composio");
  assert.ok(composio && isConnectorAvailable(composio));
  assert.equal(getConnectorCatalogEntry("gmail"), undefined);
  for (const app of COMPOSIO_APPS) {
    assert.equal(connectionSuggestionFor(app.id)?.setupEntry.kind, "composio", app.id);
  }
});

test("unknown and unavailable connectors have no suggestion", () => {
  assert.equal(connectionSuggestionFor("not-a-plugin"), null);
  assert.equal(connectionSuggestionFor(""), null);
  // A connector that cannot be set up yet is never suggested; its alternative is.
  assert.equal(connectionSuggestionFor("figma"), null);
  assert.deepEqual(connectionSuggestionFor("figma-desktop")?.setupEntry, { kind: "mcp-preset", presetId: "figma-desktop" });
  assert.equal(connectionSuggestionFor("__proto__"), null);
  // A Mac app connector is set up in Settings on a Mac, never from a Bot's card.
  assert.equal(connectionSuggestionFor("imcp"), null);
});
