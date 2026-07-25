import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_THINKING_LEVELS,
  DEFAULT_CODEX_THINKING_LEVEL,
  codexThinkingLevelsForModel,
  isCodexThinkingLevel,
  mergeCodexThinkingPreference,
  normalizeCodexThinkingLevel,
  parseCodexThinkingPreferences,
} from "./codex-thinking.js";

test("Codex thinking levels stay a small explicit request contract", () => {
  assert.deepEqual(CODEX_THINKING_LEVELS, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(DEFAULT_CODEX_THINKING_LEVEL, "medium");
  for (const level of CODEX_THINKING_LEVELS)
    assert.equal(isCodexThinkingLevel(level), true);
  for (const value of ["off", "minimal", "dynamic", "", null, 1]) {
    assert.equal(isCodexThinkingLevel(value), false);
  }
});

test("Codex choices expose only distinct native outcomes", () => {
  assert.deepEqual(codexThinkingLevelsForModel({ reasoning: false }), []);
  assert.deepEqual(
    codexThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
    }),
    ["low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    codexThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: {
        minimal: "low",
        medium: null,
        xhigh: "xhigh",
        max: "max",
      },
    }),
    ["low", "high", "xhigh", "max"],
  );
  assert.equal(
    normalizeCodexThinkingLevel(["low", "medium", "high"], undefined),
    "medium",
  );
  assert.equal(normalizeCodexThinkingLevel(["low", "high"], "medium"), "low");
});

test("Codex thinking preferences validate and merge bounded model entries", () => {
  assert.deepEqual(
    parseCodexThinkingPreferences({
      "gpt-5.4": "xhigh",
      "gpt-5.6-sol": "max",
    }),
    {
      "gpt-5.4": "xhigh",
      "gpt-5.6-sol": "max",
    },
  );
  assert.throws(
    () => parseCodexThinkingPreferences({ "gpt-5.4": "minimal" }),
    /Invalid Codex thinking preference/u,
  );
  assert.throws(
    () => parseCodexThinkingPreferences({ ["x".repeat(257)]: "low" }),
    /Invalid Codex thinking preference/u,
  );
  assert.throws(
    () =>
      parseCodexThinkingPreferences(
        Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [
            `model-${index}`,
            "medium",
          ]),
        ),
      ),
    /Too many Codex thinking preferences/u,
  );
  assert.deepEqual(
    mergeCodexThinkingPreference({ "gpt-5.4": "high" }, "gpt-5.6-sol", "max"),
    {
      "gpt-5.4": "high",
      "gpt-5.6-sol": "max",
    },
  );
  assert.deepEqual(
    mergeCodexThinkingPreference(
      { "gpt-5.4": "minimal" },
      "gpt-5.6-sol",
      "medium",
    ),
    { "gpt-5.6-sol": "medium" },
  );
});
