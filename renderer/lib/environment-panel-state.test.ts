import assert from "node:assert/strict";
import test from "node:test";
import {
  availableEnvironmentPanelTabs,
  normalizeEnvironmentPanelTab,
  parseEnvironmentPanelTab,
  storedEnvironmentPanelTab,
} from "./environment-panel-state.js";

const storage = (value: string | null) => ({ getItem: () => value, setItem: () => undefined });

test("Simulator tab sits after Browser only when the devices capability is on", () => {
  assert.deepEqual(availableEnvironmentPanelTabs(true, true), [
    "review",
    "subagents",
    "files",
    "browser",
    "devices",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(false, true), [
    "review",
    "files",
    "browser",
    "devices",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(true, false), [
    "review",
    "subagents",
    "files",
    "browser",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(true), ["review", "subagents", "files", "browser"]);
});

test("a disabled Simulator tab normalizes to Review without rewriting storage", () => {
  assert.equal(normalizeEnvironmentPanelTab("devices", true, false), "review");
  assert.equal(normalizeEnvironmentPanelTab("devices", true), "review");
  assert.equal(normalizeEnvironmentPanelTab("devices", false, true), "devices");
  let writes = 0;
  const tracked = { getItem: () => "devices", setItem: () => void writes++ };
  assert.equal(storedEnvironmentPanelTab(tracked, "tab", true, false), "review");
  assert.equal(storedEnvironmentPanelTab(tracked, "tab", true, true), "devices");
  assert.equal(writes, 0);
});

test("stored tab parsing accepts every known tab and rejects anything else", () => {
  for (const tab of ["review", "subagents", "files", "browser", "devices"] as const) {
    assert.equal(parseEnvironmentPanelTab(tab), tab);
  }
  assert.equal(parseEnvironmentPanelTab("overview"), null);
  assert.equal(parseEnvironmentPanelTab("Devices"), null);
  assert.equal(parseEnvironmentPanelTab(""), null);
  assert.equal(parseEnvironmentPanelTab(null), null);
  assert.equal(storedEnvironmentPanelTab(storage("bogus"), "tab", true, true), "review");
  assert.equal(storedEnvironmentPanelTab(storage(null), "tab", true, true), "review");
});
