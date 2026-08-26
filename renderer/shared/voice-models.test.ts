import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_VOICE_MODELS,
  GEMINI_LIVE_TRANSCRIPTION_MODEL,
  GEMINI_TRANSCRIPTION_MODEL,
  resolveCloudVoiceModel,
  shouldUseGeminiLiveTranscription,
} from "./voice-models.js";

test("Gemini voice exposes only the dedicated 3.5 transcription models", () => {
  assert.deepEqual(CLOUD_VOICE_MODELS.gemini, [
    "gemini-3.5-transcribe-live",
    "gemini-3.5-transcribe",
  ]);
  assert.equal(GEMINI_LIVE_TRANSCRIPTION_MODEL, "gemini-3.5-transcribe-live");
  assert.equal(GEMINI_TRANSCRIPTION_MODEL, "gemini-3.5-transcribe");
});

test("legacy Gemini voice selections upgrade to Gemini 3.5 Transcribe", () => {
  for (const legacy of ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"]) {
    assert.equal(resolveCloudVoiceModel("gemini", legacy), GEMINI_LIVE_TRANSCRIPTION_MODEL);
  }
  assert.equal(
    resolveCloudVoiceModel("gemini", GEMINI_TRANSCRIPTION_MODEL),
    GEMINI_TRANSCRIPTION_MODEL,
  );
  assert.equal(resolveCloudVoiceModel("openai", "gpt-4o-transcribe"), "gpt-4o-transcribe");
});

test("legacy Gemini selections start Live capture at the recording boundary", () => {
  assert.equal(shouldUseGeminiLiveTranscription("gemini", "gemini-2.5-flash"), true);
  assert.equal(shouldUseGeminiLiveTranscription("gemini", "gemini-1.5-flash"), true);
  assert.equal(shouldUseGeminiLiveTranscription("gemini", GEMINI_TRANSCRIPTION_MODEL), false);
  assert.equal(shouldUseGeminiLiveTranscription("openai", "gemini-2.5-flash"), false);
});
