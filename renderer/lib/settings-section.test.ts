import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSettingsSearch,
  parseSettingsSection,
  settingsDestinationsForCapabilities,
  settingsSectionsForCapabilities,
} from "./settings-section.js";

test("accepts known settings deep links and rejects arbitrary search values", () => {
  assert.equal(parseSettingsSection("modelData"), "modelData");
  assert.equal(parseSettingsSection("computerUse"), "computerUse");
  assert.equal(parseSettingsSection("scheduledTasks"), "scheduledTasks");
  assert.equal(parseSettingsSection("assistant"), "assistant");
  assert.equal(parseSettingsSection("ambientMusic"), "ambientMusic");
  assert.equal(parseSettingsSection("about"), "about");
  assert.equal(parseSettingsSection("unknown"), undefined);
  assert.equal(parseSettingsSection(["modelData"]), undefined);
  assert.deepEqual(parseSettingsSearch({ section: "modelData", ignored: "value" }), {
    section: "modelData",
  });
  assert.deepEqual(parseSettingsSearch({ section: "unknown" }), {});
});

test("parses the Aiden settings deep link", () => {
  assert.deepEqual(parseSettingsSearch({ section: "assistant" }), {
    section: "assistant",
  });
});

test("capability filtering removes Ambient Music from every discovery inventory", () => {
  assert.ok(settingsSectionsForCapabilities({ ambientMusic: true }).includes("ambientMusic"));
  assert.ok(
    settingsDestinationsForCapabilities({ ambientMusic: true }).some(
      (destination) => destination.id === "ambientMusic",
    ),
  );
  assert.doesNotMatch(
    settingsSectionsForCapabilities({ ambientMusic: false }).join(" "),
    /ambientMusic/u,
  );
  assert.doesNotMatch(
    settingsDestinationsForCapabilities({ ambientMusic: false })
      .map(
        (destination) => `${destination.id} ${destination.title} ${destination.keywords.join(" ")}`,
      )
      .join(" "),
    /ambient|music|magenta/u,
  );
});
