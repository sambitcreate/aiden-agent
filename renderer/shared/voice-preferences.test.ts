import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoicePreferencePatch, parseVoiceProviderPatch, voiceTrimSilenceEnabled } from "./voice-preferences.js";

test("valid voice preferences pass and invalid shapes are dropped", () => {
  assert.deepEqual(parseVoicePreferencePatch({ voiceLanguage: "de", voiceTranslateToEnglish: true, voiceTrimSilence: false }),
    { voiceLanguage: "de", voiceTranslateToEnglish: true, voiceTrimSilence: false });
  assert.deepEqual(parseVoicePreferencePatch({ voiceLanguage: "klingon!", voiceTranslateToEnglish: "yes", voiceTrimSilence: 0 }), {});
  assert.deepEqual(parseVoicePreferencePatch({ unrelated: 1 }), {});
});

test("trim silence defaults on", () => {
  assert.equal(voiceTrimSilenceEnabled(undefined), true);
  assert.equal(voiceTrimSilenceEnabled(false), false);
});

test("a null voice provider clears the explicit choice; unknown values are ignored", () => {
  assert.deepEqual(parseVoiceProviderPatch({ voiceProvider: "local" }), { voiceProvider: "local" });
  const cleared = parseVoiceProviderPatch({ voiceProvider: null });
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, "voiceProvider"), true);
  assert.equal(cleared.voiceProvider, undefined);
  assert.deepEqual(parseVoiceProviderPatch({ voiceProvider: "whisper" }), {});
  assert.deepEqual(parseVoiceProviderPatch({}), {});
});
