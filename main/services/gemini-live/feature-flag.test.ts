import assert from "node:assert/strict";
import test from "node:test";
import { experimentalGeminiLiveModel, geminiLiveEnabled } from "./feature-flag.js";

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
