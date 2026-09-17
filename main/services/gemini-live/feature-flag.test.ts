import assert from "node:assert/strict";
import test from "node:test";
import {
  experimentalGeminiLiveModel,
  geminiLiveEnabled,
  geminiLiveScreenEnabled,
} from "./feature-flag.js";

test("Gemini 3.8 Live stays behind the exact experimental feature flag", () => {
  assert.equal(geminiLiveEnabled({}), false);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "true" }), false);
  assert.equal(
    experimentalGeminiLiveModel({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "model" }),
    null,
  );
  const enabled = { AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1" };
  assert.equal(geminiLiveEnabled(enabled), true);
  assert.equal(experimentalGeminiLiveModel(enabled), "gemini-3.8-live");
  assert.equal(
    experimentalGeminiLiveModel({ ...enabled, AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "bad model" }),
    "gemini-3.8-live",
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
