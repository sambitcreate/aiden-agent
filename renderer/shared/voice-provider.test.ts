import { test } from "node:test";
import assert from "node:assert/strict";
import { automaticVoiceCaption, resolveVoiceProvider, voiceSetupMessage, type VoiceProviderInputs } from "./voice-provider.js";

const base: VoiceProviderInputs = { explicit: undefined, localModelId: undefined, installedLocalModels: [], engineReady: true, hasOpenAIKey: false, hasGeminiVoice: false };

test("automatic prefers an installed on-device model", () => {
  assert.deepEqual(resolveVoiceProvider({ ...base, installedLocalModels: ["parakeet-v3", "whisper-turbo"], hasOpenAIKey: true }),
    { kind: "ready", provider: "local", modelId: "parakeet-v3", automatic: true });
});
test("automatic honors the chosen local model when installed, else the first installed", () => {
  assert.equal((resolveVoiceProvider({ ...base, localModelId: "whisper-turbo", installedLocalModels: ["parakeet-v3", "whisper-turbo"] }) as { modelId: string }).modelId, "whisper-turbo");
  assert.equal((resolveVoiceProvider({ ...base, localModelId: "gone", installedLocalModels: ["sense-voice"] }) as { modelId: string }).modelId, "sense-voice");
});
test("automatic falls back to OpenAI, then Gemini, then setup", () => {
  assert.deepEqual(resolveVoiceProvider({ ...base, hasOpenAIKey: true, hasGeminiVoice: true }), { kind: "ready", provider: "openai", automatic: true });
  assert.deepEqual(resolveVoiceProvider({ ...base, hasGeminiVoice: true }), { kind: "ready", provider: "gemini", automatic: true });
  assert.deepEqual(resolveVoiceProvider(base), { kind: "needs-setup", reason: "no-provider" });
  assert.deepEqual(resolveVoiceProvider({ ...base, installedLocalModels: ["parakeet-v3"], engineReady: false, hasOpenAIKey: true }), { kind: "ready", provider: "openai", automatic: true });
});
test("an explicit choice always wins", () => {
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "gemini", installedLocalModels: ["parakeet-v3"] }), { kind: "ready", provider: "gemini", automatic: false });
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "openai" }), { kind: "ready", provider: "openai", automatic: false });
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "local", hasOpenAIKey: true }), { kind: "needs-setup", reason: "no-local-model" });
  assert.deepEqual(resolveVoiceProvider({ ...base, explicit: "local", installedLocalModels: ["parakeet-v3"], engineReady: false }), { kind: "needs-setup", reason: "local-engine-unavailable" });
});
test("setup messages point to Settings → Voice", () => {
  assert.equal(voiceSetupMessage("no-local-model"), "Download a voice model in Settings → Voice.");
  assert.match(voiceSetupMessage("local-engine-unavailable"), /Restart Aiden/);
});
test("the Automatic caption names what dictation will use", () => {
  const names = (id: string) => (id === "parakeet-v3" ? "Parakeet TDT 0.6B v3" : undefined);
  assert.equal(automaticVoiceCaption(resolveVoiceProvider({ ...base, installedLocalModels: ["parakeet-v3"] }), names), "Automatic — using On-device (Parakeet TDT 0.6B v3)");
  assert.equal(automaticVoiceCaption(resolveVoiceProvider({ ...base, hasGeminiVoice: true }), names), "Automatic — using Gemini");
  assert.equal(automaticVoiceCaption(resolveVoiceProvider({ ...base, hasOpenAIKey: true }), names), "Automatic — using OpenAI");
  // Settings → Voice phrases setup for the page the user is already on.
  assert.equal(
    automaticVoiceCaption(resolveVoiceProvider(base), names),
    "No voice provider yet. Download an on-device model below or add an OpenAI or Gemini key.",
  );
  assert.equal(
    automaticVoiceCaption({ kind: "needs-setup", reason: "no-local-model" }, names),
    "Download an on-device model below.",
  );
  assert.equal(voiceSetupMessage("no-provider"), "Set up a voice provider in Settings → Voice.");
});
