import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync(
  new URL("./gemini-voice-setup-dialog.tsx", import.meta.url),
  "utf8",
);
const providerSource = readFileSync(new URL("./providers-settings.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(
  new URL("./builtin-provider-editor.tsx", import.meta.url),
  "utf8",
);

test("Gemini setup offers accessible borderless radio cards and a concrete privacy disclosure", () => {
  assert.match(dialogSource, /Transcription only/u);
  assert.match(dialogSource, /Models \+ transcription/u);
  assert.match(dialogSource, /streams[\s\S]*?your recording to Google/u);
  assert.match(dialogSource, /only after you approve a retry/u);
  assert.match(dialogSource, /another Gemini charge/u);
  assert.match(dialogSource, /Stored encrypted on[\s\S]*?this device/u);
  assert.match(dialogSource, /existing chats keep their pinned model/u);
  assert.match(dialogSource, /Accessibility is optional/u);
  assert.match(dialogSource, /Gemini does not need Screen Recording/u);
  assert.match(dialogSource, /<RadioGroup[\s\S]*?aria-label="Gemini access"/u);
  assert.match(dialogSource, /onValueChange=\{\(value\) => onScopeChange/u);
  assert.match(dialogSource, /<RadioGroupItem[\s\S]*?value=\{choice\.scope\}/u);
  assert.match(dialogSource, /selected \? "bg-list-selection"/u);
  assert.doesNotMatch(dialogSource, /border-accent|has-\[:focus-visible\]/u);
  assert.doesNotMatch(dialogSource, /className="sr-only"[\s\S]*?type="radio"/u);
});

// Voice-page Gemini deferral (disclosure before any settings write, the keyless
// path through the voice-only key editor, and Privacy & access) is covered
// behaviorally in voice-settings.test.tsx: "choosing Gemini waits for the privacy
// disclosure…" and "Gemini without a key collects one…".

test("Providers routes Google through the same purpose dialog and voice-only auth readiness", () => {
  assert.match(providerSource, /provider\.id !== GOOGLE_PROVIDER_ID/u);
  assert.match(providerSource, /<GeminiVoiceSetupDialog/u);
  assert.match(providerSource, /provider=\{list\.find\(\(provider\) => provider\.id === GOOGLE_PROVIDER_ID\)\}/u);
  assert.match(providerSource, /activatesVoice=\{false\}/u);
  assert.match(providerSource, /settingsApi\.setGeminiUsageScope\(geminiScope\)/u);
  assert.doesNotMatch(providerSource, /settingsApi\.setGeminiVoiceSetup/u);
  assert.match(providerSource, /Transcription only · chat models hidden/u);
  assert.match(providerSource, /requireChatModel=\{settingUp\.id !== GOOGLE_PROVIDER_ID\}/u);
  assert.match(editorSource, /requireChatModel && refreshed\.models\.length === 0/u);
  assert.match(editorSource, /await onSaved\(\)/u);
  assert.match(dialogSource, /<ProviderModelVisibility provider=\{provider\} policyHidden=\{false\}/u);
  assert.match(dialogSource, /scope === "models_and_transcription"/u);
});
