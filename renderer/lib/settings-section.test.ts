import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSettingsSearch,
  parseSettingsSection,
  SETTINGS_DESTINATIONS,
} from "./settings-section.js";

test("accepts known settings deep links and rejects arbitrary search values", () => {
  assert.equal(parseSettingsSection("modelData"), "modelData");
  assert.equal(parseSettingsSection("computerUse"), "computerUse");
  assert.equal(parseSettingsSection("scheduledTasks"), "scheduledTasks");
  assert.equal(parseSettingsSection("assistant"), "assistant");
  assert.equal(parseSettingsSection("remoteAccess"), "remoteAccess");
  assert.equal(parseSettingsSection("memory"), "memory");
  assert.equal(parseSettingsSection("about"), "about");
  assert.equal(parseSettingsSection("unknown"), undefined);
  assert.equal(parseSettingsSection(["modelData"]), undefined);
  assert.deepEqual(parseSettingsSearch({ section: "modelData", ignored: "value" }), {
    section: "modelData",
  });
  assert.deepEqual(parseSettingsSearch({ section: "unknown" }), {});
});

test("parses the Remote Access settings deep link", () => {
  assert.deepEqual(parseSettingsSearch({ section: "remoteAccess" }), {
    section: "remoteAccess",
  });
});

test("parses the Aiden settings deep link", () => {
  assert.deepEqual(parseSettingsSearch({ section: "assistant" }), {
    section: "assistant",
  });
});

test("Plugins navigation advertises MCP, connectors, and the plugin directory", () => {
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "mcp");
  assert.ok(destination);
  assert.equal(destination.title, "Plugins");
  assert.deepEqual(destination.keywords, [
    "mcp",
    "connections",
    "protocol",
    "plugins",
    "connectors",
  ]);
});

test("Web Search navigation advertises provider routing and privacy controls", () => {
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "websearch");
  assert.ok(destination);
  assert.deepEqual(destination.keywords, [
    "web access",
    "search",
    "internet",
    "providers",
    "route",
    "automatic",
    "fixed",
    "privacy",
    "exa",
  ]);
});


test("settings can be found by the user's task without knowing feature names", () => {
  for (const [query, expected] of [["connect my phone", "remoteAccess"], ["use my voice", "voice"], ["connect my ai", "providers"], ["see my screen", "computerUse"], ["do this every day", "scheduledTasks"]]) {
    assert.ok(SETTINGS_DESTINATIONS.find((entry) => entry.id === expected)?.keywords.includes(query));
  }
  assert.equal(SETTINGS_DESTINATIONS.find((entry) => entry.id === "remoteAccess")?.title, "Aiden On The Go");
});
