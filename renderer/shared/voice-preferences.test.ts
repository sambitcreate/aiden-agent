import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoicePreferencePatch, voiceTrimSilenceEnabled } from "./voice-preferences.js";

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
