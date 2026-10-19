import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BROWSER_SETTINGS } from "../../../renderer/shared/browser.js";
import { parseBrowserPreferences } from "./preferences.js";

test("one unreadable profile skips only itself", () => {
  const parsed = parseBrowserPreferences({
    profiles: [
      { id: "profile-work", name: "Work" },
      { id: "profile-long", name: "x".repeat(49) },
      null,
      { id: "profile-blank", name: "   " },
      { id: "profile-home", name: " Home " },
    ],
    defaults: { profileId: "profile-home", appearance: "dark" },
    workspaceAccess: { "ws-1": "off" },
  });

  assert.deepEqual(
    parsed.profiles.map(({ id, name }) => [id, name]),
    [
      ["profile-work", "Work"],
      ["profile-home", "Home"],
    ],
  );
  assert.equal(parsed.defaults.profileId, "profile-home");
  assert.equal(parsed.defaults.appearance, "dark");
  assert.equal(parsed.workspaceAccess.get("ws-1"), "off");
});

test("an invalid default field keeps its default and the valid fields survive", () => {
  const parsed = parseBrowserPreferences({
    profiles: [],
    defaults: {
      profileId: "profile-deleted",
      zoom: 99,
      viewport: { mode: "responsive", width: 100_000, height: 720 },
      appearance: "light",
      recordingFps: 24,
      autoShow: false,
      linkOpening: "browser",
    },
    workspaceAccess: { "ws-1": "allow", "ws-2": "off", "ws-3": "sometimes" },
  });

  assert.deepEqual(parsed.defaults, {
    ...DEFAULT_BROWSER_SETTINGS,
    appearance: "light",
    recordingFps: 24,
    autoShow: false,
    linkOpening: "browser",
  });
  assert.deepEqual([...parsed.workspaceAccess], [
    ["ws-1", "allow"],
    ["ws-2", "off"],
  ]);
});

test("a legacy link target still migrates beside other saved defaults", () => {
  const parsed = parseBrowserPreferences({
    defaults: { linkTarget: "external", zoom: 1.5, agentAccess: "off" },
  });

  assert.equal(parsed.defaults.linkOpening, "external");
  assert.equal(parsed.defaults.zoom, 1.5);
  assert.equal(parsed.defaults.agentAccess, "off");
  assert.equal("linkTarget" in parsed.defaults, false);
});

test("a non-object preference document yields the built-in defaults", () => {
  for (const saved of [null, [], "state", 7]) {
    const parsed = parseBrowserPreferences(saved);
    assert.deepEqual(parsed.profiles, []);
    assert.deepEqual(parsed.defaults, DEFAULT_BROWSER_SETTINGS);
    assert.equal(parsed.workspaceAccess.size, 0);
  }
});
