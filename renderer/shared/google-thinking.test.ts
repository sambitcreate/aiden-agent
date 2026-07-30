import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GOOGLE_THINKING_LEVEL,
  GOOGLE_THINKING_LEVELS,
  googleThinkingCanDisable,
  googleThinkingLevelsForModel,
  isGoogleThinkingLevel,
  mergeGoogleThinkingPreference,
  normalizeGoogleThinkingLevel,
  parseGoogleThinkingPreferences,
} from "./google-thinking.js";

test("Google thinking levels stay a small explicit request contract", () => {
  assert.deepEqual(GOOGLE_THINKING_LEVELS, ["off", "low", "medium", "high"]);
  assert.equal(DEFAULT_GOOGLE_THINKING_LEVEL, "off");
  for (const level of GOOGLE_THINKING_LEVELS) assert.equal(isGoogleThinkingLevel(level), true);
  for (const value of ["minimal", "xhigh", "dynamic", "", null, 1]) {
    assert.equal(isGoogleThinkingLevel(value), false);
  }
});

test("Google thinking preferences validate model ids, values, and size", () => {
  assert.deepEqual(
    parseGoogleThinkingPreferences({
      "gemini-2.5-pro": "high",
      "gemini-3-flash-preview": "low",
    }),
    {
      "gemini-2.5-pro": "high",
      "gemini-3-flash-preview": "low",
    },
  );
  assert.throws(() => parseGoogleThinkingPreferences(null), /Invalid Google thinking preferences/u);
  assert.throws(
    () => parseGoogleThinkingPreferences({ "gemini-2.5-pro": "dynamic" }),
    /Invalid Google thinking preference/u,
  );
  assert.throws(
    () => parseGoogleThinkingPreferences({ ["x".repeat(257)]: "low" }),
    /Invalid Google thinking preference/u,
  );
  assert.throws(
    () =>
      parseGoogleThinkingPreferences(
        Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`model-${index}`, "off"])),
      ),
    /Too many Google thinking preferences/u,
  );
});

test("Google thinking choices expose only distinct native outcomes", () => {
  assert.deepEqual(googleThinkingLevelsForModel({ reasoning: false }), []);
  assert.deepEqual(googleThinkingLevelsForModel({ reasoning: true }), [
    "off",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(
    googleThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "LOW",
        medium: null,
        high: "HIGH",
      },
    }),
    ["off", "low", "high"],
  );
  assert.deepEqual(
    googleThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "MINIMAL",
        low: null,
        medium: null,
        high: "HIGH",
      },
    }),
    ["off", "high"],
  );
  assert.equal(googleThinkingCanDisable({ reasoning: true }), true);
  assert.equal(
    googleThinkingCanDisable({
      reasoning: true,
      thinkingLevelMap: { off: null },
    }),
    false,
  );
  assert.equal(normalizeGoogleThinkingLevel(["off", "low", "high"], "medium"), "off");
});

test("one preference mutation preserves current and opaque future model values", () => {
  assert.deepEqual(
    mergeGoogleThinkingPreference({ "gemini-2.5-pro": "high" }, "gemini-2.5-flash", "low"),
    {
      "gemini-2.5-pro": "high",
      "gemini-2.5-flash": "low",
    },
  );
  assert.deepEqual(
    mergeGoogleThinkingPreference({ "gemini-2.5-pro": "invalid" }, "gemini-2.5-flash", "low"),
    {
      "gemini-2.5-pro": "invalid",
      "gemini-2.5-flash": "low",
    },
  );
});

test("updating a full preference map preserves every unrelated model", () => {
  const full = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`model-${index}`, "high"]),
  );
  const updated = mergeGoogleThinkingPreference(full, "model-0", "low");

  assert.equal(Object.keys(updated).length, 256);
  assert.equal(updated["model-0"], "low");
  assert.equal(updated["model-255"], "high");
  assert.throws(
    () => mergeGoogleThinkingPreference(full, "model-new", "low"),
    /Too many Google thinking preferences/u,
  );
});
