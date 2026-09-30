import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES,
  localVoiceIdleUnloadMs,
  parseDictationPreferencePatch,
  resolveDictationActivationMode,
} from "./dictation-preferences.js";

test("older hold-to-talk settings keep their behavior without an activation mode", () => {
  assert.equal(resolveDictationActivationMode({ dictationHoldToTalk: true }), "hold");
  assert.equal(resolveDictationActivationMode({}), "toggle");
});

test("hybrid applies only when the shortcut can report releases", () => {
  const hybrid = { dictationHoldToTalk: true, dictationActivationMode: "hybrid" };
  assert.equal(resolveDictationActivationMode(hybrid), "hybrid");
  assert.equal(resolveDictationActivationMode(hybrid, false), "toggle");
  assert.equal(
    resolveDictationActivationMode({ dictationHoldToTalk: false, dictationActivationMode: "hybrid" }),
    "toggle",
    "a portal that could not bind a hold shortcut falls back to toggle",
  );
  assert.equal(
    resolveDictationActivationMode({ dictationHoldToTalk: true, dictationActivationMode: "chord" }),
    "hold",
  );
});

test("idle unload uses the default period, honors 'never', and rejects bad values", () => {
  assert.equal(localVoiceIdleUnloadMs(undefined), DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES * 60_000);
  assert.equal(localVoiceIdleUnloadMs(0), null);
  assert.equal(localVoiceIdleUnloadMs(2), 120_000);
  assert.equal(localVoiceIdleUnloadMs(-1), DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES * 60_000);
  assert.equal(localVoiceIdleUnloadMs(1.5), DEFAULT_LOCAL_VOICE_IDLE_UNLOAD_MINUTES * 60_000);
});

test("choosing a mode also decides whether the shortcut must report releases", () => {
  assert.deepEqual(parseDictationPreferencePatch({ dictationActivationMode: "hybrid" }), {
    dictationActivationMode: "hybrid",
    dictationHoldToTalk: true,
  });
  assert.deepEqual(
    parseDictationPreferencePatch({ dictationActivationMode: "toggle", dictationHoldToTalk: true }),
    { dictationActivationMode: "toggle", dictationHoldToTalk: false },
  );
  assert.deepEqual(parseDictationPreferencePatch({ dictationHoldToTalk: true }), {
    dictationHoldToTalk: true,
  });
  assert.deepEqual(parseDictationPreferencePatch({ lastModel: "x" }), {});
});

test("invalid activation or idle values are rejected rather than dropped", () => {
  assert.throws(() => parseDictationPreferencePatch({ dictationActivationMode: "double-tap" }));
  assert.throws(() => parseDictationPreferencePatch({ localVoiceIdleUnloadMinutes: -5 }));
  assert.deepEqual(parseDictationPreferencePatch({ localVoiceIdleUnloadMinutes: 0 }), {
    localVoiceIdleUnloadMinutes: 0,
  });
});
