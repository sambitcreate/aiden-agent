import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicThinkingCanDisable,
  anthropicThinkingLevelsForModel,
  mergeAnthropicThinkingPreference,
  normalizeAnthropicThinkingLevel,
  parseAnthropicThinkingPreferences,
} from "./anthropic-thinking.js";

test("exposes only distinct Claude effort choices supported by the model", () => {
  assert.deepEqual(anthropicThinkingLevelsForModel({ reasoning: true }), [
    "off",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(
    anthropicThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }),
    ["off", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(anthropicThinkingLevelsForModel({ reasoning: false }), []);
});

test("uses high by default and treats always-on thinking as hideable", () => {
  const levels = anthropicThinkingLevelsForModel({
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  });
  assert.equal(normalizeAnthropicThinkingLevel(levels, undefined), "high");
  assert.equal(
    anthropicThinkingCanDisable({
      reasoning: true,
      thinkingLevelMap: { off: null },
    }),
    false,
  );
});

test("validates persisted Anthropic choices", () => {
  assert.deepEqual(parseAnthropicThinkingPreferences({ "claude-opus-4-8": "xhigh" }), {
    "claude-opus-4-8": "xhigh",
  });
  assert.throws(
    () => parseAnthropicThinkingPreferences({ "claude-opus-4-8": "minimal" }),
    /Invalid Anthropic thinking preference/u,
  );
});

test("updating a full preference map preserves every unrelated model", () => {
  const full = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`model-${index}`, "high"]),
  );
  const updated = mergeAnthropicThinkingPreference(full, "model-0", "low");

  assert.equal(Object.keys(updated).length, 256);
  assert.equal(updated["model-0"], "low");
  assert.equal(updated["model-255"], "high");
  assert.throws(
    () => mergeAnthropicThinkingPreference(full, "model-new", "low"),
    /Too many Anthropic thinking preferences/u,
  );
});
