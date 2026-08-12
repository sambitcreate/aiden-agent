import assert from "node:assert/strict";
import test from "node:test";
import { experimentalGeminiLiveModel, geminiLiveEnabled } from "./feature-flag.js";

test("Gemini Live capability and model fail closed behind exact experimental flags", () => {
  assert.equal(geminiLiveEnabled({}), false);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "true" }), false);
  assert.equal(experimentalGeminiLiveModel({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "model" }), null);
  const enabled = {
    AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1",
    AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "gemini-live-test",
  };
  assert.equal(geminiLiveEnabled(enabled), true);
  assert.equal(experimentalGeminiLiveModel(enabled), "gemini-live-test");
  assert.equal(experimentalGeminiLiveModel({ ...enabled, AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "bad model" }), null);
});
