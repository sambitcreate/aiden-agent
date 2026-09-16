import assert from "node:assert/strict";
import test from "node:test";
import { experimentalGeminiLiveModel, geminiLiveEnabled } from "./feature-flag.js";

test("Gemini 3.8 Live is default-on with an exact emergency rollback", () => {
  assert.equal(geminiLiveEnabled({}), true);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "true" }), true);
  assert.equal(
    experimentalGeminiLiveModel({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "model" }),
    "gemini-3.8-live-extended-thinking",
  );
  const disabled = { AIDEN_EXPERIMENTAL_GEMINI_LIVE: "0" };
  assert.equal(geminiLiveEnabled(disabled), false);
  assert.equal(experimentalGeminiLiveModel(disabled), null);
  assert.equal(
    experimentalGeminiLiveModel({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "bad model" }),
    "gemini-3.8-live-extended-thinking",
  );
});
