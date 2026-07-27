import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ASSISTANT_CONFIG,
  assistantConfigFrom,
  parseAssistantConfigPatch,
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

test("applies a shortcut patch without dropping the future config fields", () => {
  const next = parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, {
    hotkeyEnabled: false,
    hotkeyAccelerator: "Command+Shift+J",
    ignored: "value",
  });

  assert.equal(next.hotkeyEnabled, false);
  assert.equal(next.hotkeyAccelerator, "Command+Shift+J");
  assert.equal(next.watchUncommitted, true);
  assert.equal("ignored" in next, false);
});

test("clamps bounded numeric settings for the future background engine", () => {
  const next = parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, {
    pollIntervalMinutes: 1,
    untouchedThresholdDays: 0,
    maxNudgesPerDay: 500,
    urgencyThreshold: 42,
  });

  assert.equal(next.pollIntervalMinutes, 5);
  assert.equal(next.untouchedThresholdDays, 1);
  assert.equal(next.maxNudgesPerDay, 50);
  assert.equal(next.urgencyThreshold, 10);
});

test("rejects invalid known fields instead of persisting ambiguous state", () => {
  assert.throws(
    () => parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, { hotkeyEnabled: "yes" }),
    /true or false/iu,
  );
  assert.throws(
    () => parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, { quietHoursStart: "25:00" }),
    /HH:MM/iu,
  );
  assert.throws(
    () => parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, { settingsPermission: "root" }),
    /permission/iu,
  );
});

test("an explicit empty model selection clears the future background pin", () => {
  const pinned = parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, {
    providerId: "anthropic",
    model: "claude-sonnet",
  });
  const cleared = parseAssistantConfigPatch(pinned, { providerId: "", model: "" });

  assert.equal(cleared.providerId, undefined);
  assert.equal(cleared.model, undefined);
});
