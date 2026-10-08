import assert from "node:assert/strict";
import test from "node:test";
import {
  experimentalGeminiLiveModel,
  geminiLiveEnabled,
  geminiLiveScreenEnabled,
} from "./feature-flag.js";

test("voice-only Gemini 3.8 Live ships on with an explicit kill switch", () => {
  assert.equal(geminiLiveEnabled({}), true);
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
  const disabledByName = { AIDEN_EXPERIMENTAL_GEMINI_LIVE: " false " };
  assert.equal(geminiLiveEnabled(disabledByName), false);
  assert.equal(experimentalGeminiLiveModel(disabledByName), null);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "" }), false);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "   " }), false);
  assert.equal(geminiLiveEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "enabled" }), false);
  assert.equal(
    experimentalGeminiLiveModel({
      AIDEN_EXPERIMENTAL_GEMINI_LIVE: "true",
      AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: "bad model",
    }),
    "gemini-3.8-live-extended-thinking",
  );
});

test("screen sharing ships on with its own kill switch and cannot outlive the Live gate", () => {
  const live = { AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1" };
  assert.equal(geminiLiveScreenEnabled({}), true);
  assert.equal(geminiLiveScreenEnabled(live), true);
  assert.equal(
    geminiLiveScreenEnabled({ ...live, AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: " TRUE " }),
    true,
  );
  assert.equal(geminiLiveScreenEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "0" }), false);
  assert.equal(geminiLiveScreenEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "" }), false);
  assert.equal(
    geminiLiveScreenEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "enabled" }),
    false,
  );
  assert.equal(
    geminiLiveScreenEnabled({ AIDEN_EXPERIMENTAL_GEMINI_LIVE: "0" }),
    false,
    "the screen gate follows the Live incident kill switch",
  );
  assert.equal(
    geminiLiveScreenEnabled({
      AIDEN_EXPERIMENTAL_GEMINI_LIVE: "0",
      AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN: "1",
    }),
    false,
    "the screen gate cannot override the Live incident kill switch",
  );
});
