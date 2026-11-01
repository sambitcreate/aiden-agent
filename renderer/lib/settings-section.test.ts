import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantSettingsSections,
  availableSettingsDestinations,
  matchesSettingsSearch,
  parseSettingsSearch,
  parseSettingsSection,
  SETTINGS_DESTINATIONS,
} from "./settings-section.js";

test("capability-aware settings destinations hide Computer Use everywhere", () => {
  assert.equal(
    availableSettingsDestinations({ computerUse: false, devices: true, botComputers: true, hooks: true }).some(
      (destination) => destination.id === "computerUse",
    ),
    false,
  );
  assert.equal(
    availableSettingsDestinations({ computerUse: true, devices: true, botComputers: true, hooks: true }).some(
      (destination) => destination.id === "computerUse",
    ),
    true,
  );
});

test("capability-aware settings destinations hide Simulator without the devices capability", () => {
  const ids = (capabilities: { computerUse: boolean; devices: boolean; botComputers: boolean; hooks: boolean }) =>
    availableSettingsDestinations(capabilities).map((destination) => destination.id);
  assert.equal(ids({ computerUse: true, devices: false, botComputers: true, hooks: true }).includes("simulator"), false);
  assert.equal(ids({ computerUse: true, devices: true, botComputers: true, hooks: true }).includes("simulator"), true);
  const linux = ids({ computerUse: false, devices: false, botComputers: false, hooks: true });
  assert.equal(linux.includes("simulator"), false);
  assert.equal(linux.includes("computerUse"), false);
  assert.equal(linux.includes("botComputers"), false);
  assert.equal(linux.length, SETTINGS_DESTINATIONS.length - 3);
});

test("Bot computers appear only on Apple silicon, in Agent, and are found by VM words", () => {
  const ids = (botComputers: boolean) =>
    availableSettingsDestinations({ computerUse: true, devices: true, botComputers, hooks: true }).map((destination) => destination.id);
  assert.equal(ids(false).includes("botComputers"), false, "an Intel Mac has Computer Use but no Bot computers");
  assert.equal(ids(true).includes("botComputers"), true);
  assert.equal(SETTINGS_DESTINATIONS.find((entry) => entry.id === "botComputers")?.group, "Agent");
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "botComputers");
  assert.ok(destination);
  for (const term of ["virtual machine", "vm", "lume", "macos", "bot computer"]) {
    assert.ok(matchesSettingsSearch(destination, term), term);
  }
  assert.equal(parseSettingsSection("botComputers"), "botComputers");
  // The assistant never offers a page this Mac can't show.
  assert.equal(assistantSettingsSections({ devices: true, botComputers: false }).includes("botComputers"), false);
  assert.equal(assistantSettingsSections({ devices: true, botComputers: true }).includes("botComputers"), true);
});

test("Hooks appear only where the host can run them", () => {
  const ids = (hooks: boolean) =>
    availableSettingsDestinations({ computerUse: true, devices: true, botComputers: true, hooks }).map((destination) => destination.id);
  assert.equal(ids(false).includes("hooks"), false, "a host without process-group support has no Hooks page");
  assert.equal(ids(true).includes("hooks"), true);
  // Only Hooks goes; every other page stays.
  assert.deepEqual(
    ids(true).filter((id) => id !== "hooks"),
    ids(false),
  );
});

test("accepts known settings deep links and rejects arbitrary search values", () => {
  assert.equal(parseSettingsSection("modelData"), "modelData");
  assert.equal(parseSettingsSection("computerUse"), "computerUse");
  assert.equal(parseSettingsSection("scheduledTasks"), "scheduledTasks");
  assert.equal(parseSettingsSection("geminiLive"), "geminiLive");
  assert.equal(parseSettingsSection("assistant"), undefined);
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

test("parses the Gemini Live settings deep link", () => {
  assert.deepEqual(parseSettingsSearch({ section: "geminiLive" }), {
    section: "geminiLive",
  });
});

test("Connectors navigation is found by its name, MCP, and the apps it connects", () => {
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "mcp");
  assert.ok(destination);
  assert.equal(destination.title, "Connectors");
  // The former names stay findable.
  for (const keyword of ["mcp", "plugins", "integrations", "composio"]) assert.ok(destination.keywords.includes(keyword), keyword);
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
  for (const [query, expected] of [
    ["connect my phone", "remoteAccess"],
    ["use my voice", "voice"],
    ["connect my ai", "providers"],
    ["see my screen", "computerUse"],
    ["do this every day", "scheduledTasks"],
    ["stop asking me", "approvals"],
  ]) {
    assert.ok(
      SETTINGS_DESTINATIONS.find((entry) => entry.id === expected)?.keywords.includes(query),
    );
  }
  assert.equal(
    SETTINGS_DESTINATIONS.find((entry) => entry.id === "remoteAccess")?.title,
    "Connections",
  );
});

function searchIds(search: string, descriptions: Partial<Record<string, string>> = {}): string[] {
  return SETTINGS_DESTINATIONS.filter((destination) =>
    matchesSettingsSearch(destination, search, descriptions[destination.id]),
  ).map((destination) => destination.id);
}

test("settings search matches every term in any order across title and keywords", () => {
  assert.deepEqual(searchIds("phone connect"), searchIds("connect phone"));
  assert.ok(searchIds("phone connect").includes("remoteAccess"));
  assert.ok(searchIds("  Phone   CONNECT ").includes("remoteAccess"));
  // A term that appears nowhere for a destination excludes it even when others match.
  assert.equal(searchIds("phone zzqx").length, 0);
});

test("settings search finds About by update, diagnostics, logs, and reset terms", () => {
  for (const term of ["update", "diagnostics", "logs", "reset onboarding"]) {
    assert.ok(searchIds(term).includes("about"), term);
  }
});

test("settings search also matches the page description", () => {
  const destination = { title: "Voice", keywords: ["microphone"] };
  assert.equal(matchesSettingsSearch(destination, "dictation"), false);
  assert.equal(
    matchesSettingsSearch(destination, "voice dictation", "Dictation and transcription."),
    true,
  );
  assert.equal(searchIds("").length, SETTINGS_DESTINATIONS.length);
});

test("Image Generation is an Agent destination reachable by deep link and model names", () => {
  assert.deepEqual(parseSettingsSearch({ section: "imageGeneration" }), {
    section: "imageGeneration",
  });
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "imageGeneration");
  assert.equal(destination?.title, "Image Generation");
  assert.equal(destination?.group, "Agent");
  for (const term of ["replicate", "fal", "nano banana", "flux", "seedream", "image api keys"]) {
    assert.ok(searchIds(term).includes("imageGeneration"), term);
  }
  // Every platform shows it; no capability gates image generation.
  assert.ok(
    availableSettingsDestinations({ computerUse: false, devices: false, botComputers: false, hooks: false }).some(
      (entry) => entry.id === "imageGeneration",
    ),
  );
});
