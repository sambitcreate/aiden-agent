import assert from "node:assert/strict";
import test from "node:test";
import { connectionSuggestionFor, rankConnections } from "./bot-connections.js";
import { COMPOSIO_APPS, getConnectorCatalogEntry, isConnectorAvailable } from "./connector-catalog.js";

const ids = (text: string, presetIds?: readonly string[], limit?: number) =>
  rankConnections(text, presetIds, limit).map((suggestion) => suggestion.pluginId);

test("a directly connectable catalog plugin opens its own preset setup", () => {
  assert.deepEqual(connectionSuggestionFor("notion"), {
    pluginId: "notion",
    name: "Notion",
    chipLabel: "Notion",
    iconId: "notion",
    setupEntry: { kind: "mcp-preset", presetId: "notion" },
  });
  const composio = connectionSuggestionFor("composio");
  assert.equal(composio?.chipLabel, "More apps (Composio)");
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
  assert.ok(!rankConnections("my calendar, reminders and messages", ["imcp"]).some((suggestion) => suggestion.pluginId === "imcp"));
});

test("email words rank mail apps first, Gmail before Outlook", () => {
  assert.deepEqual(ids("Help me get through my inbox").slice(0, 2), ["gmail", "outlook-email"]);
  assert.deepEqual(ids("Answer EMAIL for me").slice(0, 2), ["gmail", "outlook-email"]);
  assert.deepEqual(ids("sort my mail").slice(0, 2), ["gmail", "outlook-email"]);
});

test("matches are ordered by where they first appear in the answer", () => {
  assert.deepEqual(ids("Prep for meetings and keep my notes tidy").slice(0, 2), [
    "google-calendar",
    "notion",
  ]);
  assert.deepEqual(ids("Keep my wiki tidy and my calendar clear").slice(0, 2), [
    "notion",
    "google-calendar",
  ]);
});

test("words only match whole words", () => {
  // "mailboxes" and "documentary" are not email or docs keywords, so only defaults remain.
  const defaults = ["gmail", "google-calendar", "notion", "composio"];
  assert.deepEqual(ids("Recommend a documentary"), defaults);
  assert.deepEqual(ids("Name my mailboxes"), defaults);
});

test("'apps' and 'everything' point at Composio", () => {
  assert.equal(ids("Connect all my apps")[0], "composio");
  assert.equal(ids("help with everything")[0], "composio");
});

test("preset suggestions follow keyword matches and are never duplicated", () => {
  assert.deepEqual(ids("Plan dinners", ["notion", "google-calendar"]).slice(0, 2), [
    "notion",
    "google-calendar",
  ]);
  const ranked = ids("calendar please", ["notion", "google-calendar"]);
  assert.deepEqual(ranked.slice(0, 2), ["google-calendar", "notion"]);
  assert.equal(new Set(ranked).size, ranked.length);
});

test("unknown preset ids are dropped and Composio is always offered", () => {
  const ranked = ids("", ["not-a-plugin", "superpowers"]);
  assert.equal(ranked.includes("not-a-plugin"), false);
  assert.equal(ranked.includes("superpowers"), false);
  assert.deepEqual(ranked, ["gmail", "google-calendar", "notion", "composio"]);
  assert.deepEqual(ids("inbox", undefined, 2), ["gmail", "composio"]);
});
