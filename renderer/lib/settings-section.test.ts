import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantSettingsPages,
  availableSettingsDestinations,
  availableSettingsPages,
  firstMatchingSettingsSection,
  matchesSettingsSearch,
  pageFor,
  parseSettingsSearch,
  parseSettingsSection,
  resolveSettingsSection,
  settingsLocation,
  SETTINGS_DESTINATIONS,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_SECTIONS,
  settingsTabLabel,
} from "./settings-section.js";

const APPLE_SILICON = { computerUse: true, devices: true, botComputers: true, hooks: true };
const INTEL_MAC = { computerUse: true, devices: true, botComputers: false, hooks: true };
const LINUX = { computerUse: false, devices: false, botComputers: false, hooks: true };

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

test("Bot computers appear only on Apple silicon and are found by VM words", () => {
  const ids = (botComputers: boolean) =>
    availableSettingsDestinations({ computerUse: true, devices: true, botComputers, hooks: true }).map((destination) => destination.id);
  assert.equal(ids(false).includes("botComputers"), false, "an Intel Mac has Computer Use but no Bot computers");
  assert.equal(ids(true).includes("botComputers"), true);
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "botComputers");
  assert.ok(destination);
  for (const term of ["virtual machine", "vm", "lume", "macos", "bot computer"]) {
    assert.ok(matchesSettingsSearch(destination, term), term);
  }
  assert.equal(parseSettingsSection("botComputers"), "botComputers");
  // The assistant never offers a page this Mac can't show.
  assert.equal(assistantSettingsPages(INTEL_MAC).join().includes("Bot computers"), false);
  assert.equal(assistantSettingsPages(APPLE_SILICON).join().includes("Bot computers"), true);
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

test("moving around Settings keeps one history entry so Back to app leaves it", () => {
  const onLinks = { pathname: "/settings" };
  assert.equal(settingsLocation("links", onLinks).replace, true);
  assert.equal(settingsLocation("providers", onLinks).replace, true);
  assert.equal(settingsLocation("links", { pathname: "/chat" }).replace, undefined);
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

test("Image Generation is reachable by deep link and model names", () => {
  assert.deepEqual(parseSettingsSearch({ section: "imageGeneration" }), {
    section: "imageGeneration",
  });
  const destination = SETTINGS_DESTINATIONS.find((entry) => entry.id === "imageGeneration");
  assert.equal(destination?.title, "Image Generation");
  assert.equal(pageFor("imageGeneration").group, "Capabilities");
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

test("every section lives on exactly one page, and every destination has a section", () => {
  for (const section of SETTINGS_SECTIONS) {
    const homes = SETTINGS_PAGES.filter(
      (page) => page.tabs.includes(section) || page.anchors?.includes(section),
    );
    assert.equal(homes.length, 1, section);
    assert.equal(parseSettingsSection(section), section);
    assert.ok(SETTINGS_DESTINATIONS.some((entry) => entry.id === section), section);
  }
});

test("every sidebar group holds a page", () => {
  for (const group of SETTINGS_GROUPS) {
    assert.ok(SETTINGS_PAGES.some((page) => page.group === group), group);
  }
});

test("old deep links reach their merged page", () => {
  assert.equal(pageFor("approvals").title, "Bots & Approvals");
  assert.equal(pageFor("botComputers").title, "Computers & VMs");
  assert.equal(pageFor("tts").title, "Voice & Speech");
  assert.equal(pageFor("telegram").title, "Connections");
  assert.equal(pageFor("remoteAccess").title, "Connections");
});

test("links opens Appearance as a spot on the page, not a tab", () => {
  assert.equal(pageFor("links").id, "appearance");
  assert.deepEqual(pageFor("links").tabs, ["appearance"]);
  assert.equal(resolveSettingsSection("links", LINUX), "links");
});

test("Connections names its tabs for what they do", () => {
  assert.deepEqual(pageFor("remoteAccess").tabs.map(settingsTabLabel), [
    "Control this device",
    "Control other devices",
    "Telegram",
  ]);
});

test("Computers & VMs follows the host", () => {
  const page = (capabilities: typeof APPLE_SILICON) =>
    availableSettingsPages(capabilities).find((entry) => entry.id === "computers");
  assert.deepEqual(page(APPLE_SILICON)?.tabs, ["computerUse", "botComputers"]);
  assert.equal(page(APPLE_SILICON)?.title, "Computers & VMs");
  assert.deepEqual(page(INTEL_MAC)?.tabs, ["computerUse"]);
  assert.equal(page(INTEL_MAC)?.title, "Computer Use");
  assert.equal(page(LINUX), undefined);
});

test("a section this host can't show opens the next tab on its page, then Providers", () => {
  assert.equal(resolveSettingsSection("botComputers", INTEL_MAC), "computerUse");
  assert.equal(resolveSettingsSection("botComputers", LINUX), "providers");
  assert.equal(resolveSettingsSection("computerUse", LINUX), "providers");
  assert.equal(resolveSettingsSection("simulator", LINUX), "providers");
  assert.equal(resolveSettingsSection(undefined, APPLE_SILICON), "providers");
  assert.equal(resolveSettingsSection("tts", LINUX), "tts");
});

test("the assistant names pages as people see them, and none this host hides", () => {
  const pages = assistantSettingsPages(APPLE_SILICON);
  assert.ok(pages.includes("Bots & Approvals (Bots, Tool approvals, Controls in chat)"));
  assert.ok(pages.includes("Connections (Control this device, Control other devices, Telegram)"));
  assert.ok(pages.includes("Appearance (Links)"));
  assert.ok(pages.includes("Memory"));
  assert.ok(assistantSettingsPages(INTEL_MAC).includes("Computer Use"));
  assert.equal(assistantSettingsPages(LINUX).join().includes("Computer"), false);
});

test("search finds a tab by what the tab says", () => {
  const connections = pageFor("peerHosts");
  assert.equal(firstMatchingSettingsSection(connections, "this device"), "remoteAccess");
  assert.equal(firstMatchingSettingsSection(connections, "other devices"), "peerHosts");
});

test("chat links finds the Links row", () => {
  assert.equal(firstMatchingSettingsSection(pageFor("links"), "chat links"), "links");
});

function searchSidebar(search: string, capabilities = APPLE_SILICON) {
  return availableSettingsPages(capabilities).flatMap((page) => {
    const target = firstMatchingSettingsSection(page, search);
    return target ? [{ page: page.id, target }] : [];
  });
}

test("sidebar search opens the tab that matched", () => {
  assert.deepEqual(searchSidebar("read aloud"), [{ page: "voiceSpeech", target: "tts" }]);
  assert.deepEqual(searchSidebar("stop asking me"), [
    { page: "botsApprovals", target: "bots" },
  ]);
  assert.ok(searchSidebar("chat controls").some((row) => row.target === "appControls"));
  assert.ok(searchSidebar("multiple computers").some((row) => row.target === "peerHosts"));
});

test("sidebar search on a page title's word prefers the tab that names it", () => {
  assert.ok(searchSidebar("approvals").some((row) => row.target === "approvals"));
  assert.deepEqual(searchSidebar("voice & speech"), [{ page: "voiceSpeech", target: "voice" }]);
  assert.deepEqual(searchSidebar("connections telegram"), [{ page: "connections", target: "telegram" }]);
});

test("sidebar search opens the links row from Appearance", () => {
  assert.ok(searchSidebar("open links").some((row) => row.page === "appearance" && row.target === "links"));
});

test("an empty sidebar search opens each page's first tab", () => {
  const rows = searchSidebar("", INTEL_MAC);
  assert.equal(rows.length, availableSettingsPages(INTEL_MAC).length);
  assert.equal(rows.find((row) => row.page === "connections")?.target, "remoteAccess");
  assert.equal(rows.find((row) => row.page === "appearance")?.target, "appearance");
});

test("sidebar search can't open a hidden tab", () => {
  assert.equal(searchSidebar("lume", INTEL_MAC).length, 0);
});
