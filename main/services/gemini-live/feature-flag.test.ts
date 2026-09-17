import assert from "node:assert/strict";
import test from "node:test";
import {
  experimentalGeminiLiveModel,
  geminiLiveEnabled,
  geminiLiveScreenEnabled,
} from "./feature-flag.js";

test("Gemini 3.8 Live stays acceptance-gated behind an exact opt-in", () => {
  assert.equal(geminiLiveEnabled({}), false);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "true" }), true);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1" }), true);
  assert.equal(geminiLiveEnabled({ AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE: "1" }), true);
  assert.equal(
    experimentalGeminiLiveModel({
      AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1",
      AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "model",
    }),
    "gemini-3.8-live-extended-thinking",
  );
  const disabled = { AIDEN_EXPERIMENTAL_GEMINI_LIVE: "0" };
  assert.equal(geminiLiveEnabled(disabled), false);
  assert.equal(experimentalGeminiLiveModel(disabled), null);
  assert.equal(
    experimentalGeminiLiveModel({
      AIDEN_EXPERIMENTAL_GEMINI_LIVE: "true",
      AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "bad model",
    }),
    "gemini-3.8-live-extended-thinking",
  );
});

test("screen sharing needs both flags and can never outlive the Live gate", () => {
  const live = { AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1" };
  assert.equal(geminiLiveScreenEnabled({}), false);
  assert.equal(geminiLiveScreenEnabled(live), false);
  assert.equal(
    geminiLiveScreenEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "1" }),
    false,
    "the screen flag alone must not admit capture",
  );
  assert.equal(
    geminiLiveScreenEnabled({ ...live, AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "true" }),
    false,
  );
  assert.equal(
    geminiLiveScreenEnabled({ ...live, AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "1" }),
    true,
  );
});
