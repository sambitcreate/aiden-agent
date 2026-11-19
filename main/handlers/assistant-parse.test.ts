import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ASSISTANT_CONFIG,
  assistantConfigFrom,
} from "./assistant-parse.js";

test("defaults keep background activity off while the Aiden shortcut is available", () => {
  assert.equal(DEFAULT_ASSISTANT_CONFIG.enabled, false);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.hotkeyEnabled, true);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.hotkeyAccelerator, "Command+Alt+A");
  assert.equal(DEFAULT_ASSISTANT_CONFIG.providerId, undefined);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.settingsPermission, "ask");
});

test("fills the complete config for settings that predate Aiden", () => {
  assert.deepEqual(assistantConfigFrom({}), DEFAULT_ASSISTANT_CONFIG);
});

test("normalizes malformed persisted values without breaking settings reads", () => {
  const next = assistantConfigFrom({
    assistant: {
      ...DEFAULT_ASSISTANT_CONFIG,
      hotkeyEnabled: "yes",
      hotkeyAccelerator: "",
      pollIntervalMinutes: Number.NaN,
      quietHoursStart: "25:00",
      settingsPermission: "root",
    },
  } as never);

  assert.equal(next.hotkeyEnabled, true);
  assert.equal(next.hotkeyAccelerator, "Command+Alt+A");
  assert.equal(next.pollIntervalMinutes, 30);
  assert.equal(next.quietHoursStart, "22:00");
  assert.equal(next.settingsPermission, "ask");
});
