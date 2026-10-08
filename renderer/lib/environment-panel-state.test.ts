import assert from "node:assert/strict";
import test from "node:test";
import {
  availableEnvironmentPanelTabs,
  reduceEnvironmentSurfaceState,
  parseEnvironmentOpenTabs,
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
    "new-tab", "context", "terminal",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(false, true), [
    "review",
    "files",
    "browser",
    "devices",
    "new-tab", "context", "terminal",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(true, false), [
    "review",
    "subagents",
    "files",
    "browser",
    "new-tab", "context", "terminal",
  ]);
  assert.deepEqual(availableEnvironmentPanelTabs(true), ["review", "subagents", "files", "browser", "new-tab", "context", "terminal"]);
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


test("launcher replaces itself with a tool; repeat opens select a singleton and closing the last tab returns home", () => {
  let state = reduceEnvironmentSurfaceState({ toolsOpen: false, quickViewOpen: true, toolsTab: "review", frontSurface: "quick-view" }, { type: "show-tools" });
  assert.equal(state.toolsTab, "new-tab");
  assert.equal(state.quickViewOpen, true);
  state = reduceEnvironmentSurfaceState(state, { type: "show-tools", tab: "files" });
  assert.deepEqual(state.openTabs, ["review", "files"]);
  state = reduceEnvironmentSurfaceState(state, { type: "show-tools", tab: "files" });
  assert.deepEqual(state.openTabs, ["review", "files"]);
  state = reduceEnvironmentSurfaceState(state, { type: "close-tab", tab: "files" });
  assert.equal(state.toolsTab, "review");
  state = reduceEnvironmentSurfaceState(state, { type: "close-tab", tab: "review" });
  assert.deepEqual(state.openTabs, ["new-tab"]);
  assert.equal(state.toolsTab, "new-tab");
});

test("hide preserves open tabs, and generic reopening returns to the launcher", () => {
  const state = { toolsOpen: true, quickViewOpen: false, toolsTab: "context" as const, openTabs: ["context" as const], frontSurface: "tools" as const };
  const hidden = reduceEnvironmentSurfaceState(state, { type: "close-tools" });
  assert.deepEqual(hidden.openTabs, ["context"]);
  const reopened = reduceEnvironmentSurfaceState(hidden, { type: "toggle-tools", tab: "new-tab" });
  assert.equal(reopened.toolsTab, "new-tab");
  assert.deepEqual(reopened.openTabs, ["context", "new-tab"]);
});

test("tab storage filters unknown and duplicate values and migrates malformed/legacy storage", () => {
  assert.deepEqual(parseEnvironmentOpenTabs('{"version":1,"tabs":["files","files","unknown","context",null]}', "review"), ["files", "context"]);
  assert.deepEqual(parseEnvironmentOpenTabs('{"version":2,"tabs":["context"]}', "files"), ["files"]);
  assert.deepEqual(parseEnvironmentOpenTabs('broken', "review"), ["review"]);
});
