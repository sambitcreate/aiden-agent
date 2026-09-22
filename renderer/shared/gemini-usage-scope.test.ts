import assert from "node:assert/strict";
import test from "node:test";

import {
  canUseGeminiChatModel,
  defaultGeminiUsageScope,
  hiddenModelsForGeminiScope,
  isGeminiUsageScope,
} from "./gemini-usage-scope.js";
import { isModelHidden } from "./model-visibility.js";

test("existing configured Gemini users keep model access while fresh voice setup is narrow", () => {
  assert.equal(defaultGeminiUsageScope(undefined, true), "models_and_transcription");
  assert.equal(defaultGeminiUsageScope(undefined, false), "transcription_only");
  assert.equal(defaultGeminiUsageScope("transcription_only", true), "transcription_only");
  assert.equal(isGeminiUsageScope("models_and_transcription"), true);
  assert.equal(isGeminiUsageScope("future"), false);
});

test("transcription-only hides current and future Google models without losing explicit choices", () => {
  const hidden = hiddenModelsForGeminiScope(
    { google: ["gemini-legacy"], anthropic: ["claude-old"] },
    "google",
    "transcription_only",
  );
  assert.deepEqual(hidden, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-old"] },
    google: {
      defaultVisibility: "shown",
      exceptions: ["gemini-legacy"],
      policyHidden: true,
    },
  });
  assert.equal(isModelHidden(hidden, "google", "gemini-future"), true);
  assert.equal(isModelHidden(hidden, "anthropic", "claude-new"), false);

  const restored = hiddenModelsForGeminiScope(hidden, "google", "models_and_transcription");
  assert.deepEqual(restored, {
    anthropic: { defaultVisibility: "shown", exceptions: ["claude-old"] },
    google: { defaultVisibility: "shown", exceptions: ["gemini-legacy"] },
  });
});

test("transcription-only blocks new Google chat work but preserves an existing pinned chat", () => {
  assert.equal(canUseGeminiChatModel("transcription_only", "google"), false);
  assert.equal(canUseGeminiChatModel("transcription_only", "google", true), true);
  assert.equal(canUseGeminiChatModel("models_and_transcription", "google"), true);
  assert.equal(canUseGeminiChatModel("transcription_only", "anthropic"), true);
});
