import assert from "node:assert/strict";
import test from "node:test";
import { aidenLivePreferences, parseAidenLiveSettingsPatch } from "./aiden-live-settings.js";

test("omitted Live settings read as the defaults: Puck, normal speed, Spectrum, everything on", () => {
  assert.deepEqual(aidenLivePreferences({}), {
    voice: "Puck",
    speed: 1,
    ribbonColors: "spectrum",
    chatAccess: true,
    chatAccessNoticeShown: false,
    voiceApprovals: true,
    appControl: true,
  });
  assert.deepEqual(aidenLivePreferences(null), aidenLivePreferences({}));
});

test("a stored value outside the offered choices falls back for that field only", () => {
  const preferences = aidenLivePreferences({
    aidenLiveVoice: "NotAVoice",
    aidenLiveSpeed: 3,
    aidenLiveRibbonColors: "accent",
    aidenLiveChatAccess: false,
  });
  assert.equal(preferences.voice, "Puck");
  assert.equal(preferences.speed, 1);
  assert.equal(preferences.ribbonColors, "accent");
  assert.equal(preferences.chatAccess, false);
});

test("a settings patch keeps valid Live fields and refuses wrong ones", () => {
  assert.deepEqual(
    parseAidenLiveSettingsPatch({ aidenLiveVoice: "Kore", aidenLiveSpeed: 1.5, aidenLiveAppControl: false, other: 1 }),
    { aidenLiveVoice: "Kore", aidenLiveSpeed: 1.5, aidenLiveAppControl: false },
  );
  assert.deepEqual(parseAidenLiveSettingsPatch({}), {});
  for (const patch of [
    { aidenLiveVoice: "kore" },
    { aidenLiveSpeed: 1.1 },
    { aidenLiveSpeed: "1.5" },
    { aidenLiveRibbonColors: "rainbow" },
    { aidenLiveChatAccess: "yes" },
  ]) assert.throws(() => parseAidenLiveSettingsPatch(patch), /Aiden Live/u);
});
