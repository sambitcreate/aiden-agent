import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync(
  new URL("./gemini-voice-setup-dialog.tsx", import.meta.url),
  "utf8",
);
const voiceSource = readFileSync(new URL("./voice-settings.tsx", import.meta.url), "utf8");
const providerSource = readFileSync(new URL("./providers-settings.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(
  new URL("./builtin-provider-editor.tsx", import.meta.url),
  "utf8",
);

test("Gemini setup offers separate scopes and a concrete privacy disclosure", () => {
  assert.match(dialogSource, /Transcription only/u);
  assert.match(dialogSource, /Models \+ transcription/u);
  assert.match(dialogSource, /streams[\s\S]*?your recording to Google/u);
  assert.match(dialogSource, /only after you approve a retry/u);
  assert.match(dialogSource, /another Gemini charge/u);
  assert.match(dialogSource, /Stored encrypted on[\s\S]*?this Mac/u);
  assert.match(dialogSource, /existing chats keep their pinned model/u);
  assert.match(dialogSource, /Accessibility is optional/u);
  assert.match(dialogSource, /Gemini does not need Screen Recording/u);
  assert.match(dialogSource, /role="radiogroup"/u);
  assert.match(dialogSource, /type="radio"/u);
  assert.match(dialogSource, /checked=\{selected\}/u);
});

test("Voice defers Gemini selection until disclosure and managed auth complete", () => {
  const changeProvider = voiceSource.slice(
    voiceSource.indexOf("const changeProvider"),
    voiceSource.indexOf("  return ("),
  );
  assert.match(changeProvider, /if \(p === "gemini"\)[\s\S]*?openGeminiSetup\(\);[\s\S]*?return;/u);
  assert.match(voiceSource, /settingsApi\.setGeminiVoiceSetup/u);
  assert.match(voiceSource, /<BuiltinProviderEditor[\s\S]*?requireChatModel=\{false\}/u);
  assert.match(voiceSource, /Privacy & access/u);
  assert.doesNotMatch(changeProvider, /voiceProvider: cloudProvider[\s\S]*?gemini/u);
});

test("Providers routes Google through the same purpose dialog and voice-only auth readiness", () => {
  assert.match(providerSource, /provider\.id !== GOOGLE_PROVIDER_ID/u);
  assert.match(providerSource, /<GeminiVoiceSetupDialog/u);
  assert.match(providerSource, /activatesVoice=\{false\}/u);
  assert.match(providerSource, /settingsApi\.setGeminiUsageScope\(geminiScope\)/u);
  assert.doesNotMatch(providerSource, /settingsApi\.setGeminiVoiceSetup/u);
  assert.match(providerSource, /Transcription only · chat models hidden/u);
  assert.match(providerSource, /requireChatModel=\{settingUp\.id !== GOOGLE_PROVIDER_ID\}/u);
  assert.match(editorSource, /requireChatModel && refreshed\.models\.length === 0/u);
  assert.match(editorSource, /await onSaved\(\)/u);
});
