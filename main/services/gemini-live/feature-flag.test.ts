import assert from "node:assert/strict";
import test from "node:test";
import { experimentalGeminiLiveModel, geminiLiveEnabled } from "./feature-flag.js";

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
