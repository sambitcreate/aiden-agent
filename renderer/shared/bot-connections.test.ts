import assert from "node:assert/strict";
import test from "node:test";
import { connectionSuggestionFor, rankConnections } from "./bot-connections.js";
import { isConnectablePlugin, PLUGIN_CATALOG } from "./plugin-catalog.js";

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
  assert.equal(composio?.chipLabel, "500+ apps");
  assert.deepEqual(composio?.setupEntry, { kind: "mcp-preset", presetId: "composio" });
});

test("apps Aiden cannot sign in to directly are set up through Composio", () => {
  const gmail = connectionSuggestionFor("gmail");
  assert.equal(gmail?.name, "Gmail");
  assert.deepEqual(gmail?.setupEntry, { kind: "composio", presetId: "composio", appName: "Gmail" });
  // The entry point must be a preset that the settings flow can actually finish.
  const composio = PLUGIN_CATALOG.find((plugin) => plugin.id === "composio");
  assert.ok(composio && isConnectablePlugin(composio));
  assert.equal(
    isConnectablePlugin(PLUGIN_CATALOG.find((plugin) => plugin.id === "gmail")!),
    false,
  );
});

test("unknown and listing-only plugins have no suggestion", () => {
  assert.equal(connectionSuggestionFor("not-a-plugin"), null);
  assert.equal(connectionSuggestionFor(""), null);
  // Skills-only Codex plugins cannot be connected at all.
  assert.equal(connectionSuggestionFor("superpowers"), null);
  assert.equal(connectionSuggestionFor("__proto__"), null);
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
