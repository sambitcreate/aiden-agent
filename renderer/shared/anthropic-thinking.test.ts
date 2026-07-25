import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicThinkingCanDisable,
  anthropicThinkingLevelsForModel,
  normalizeAnthropicThinkingLevel,
  parseAnthropicThinkingPreferences,
} from "./anthropic-thinking.js";

test("exposes only distinct Claude effort choices supported by the model", () => {
  assert.deepEqual(
    anthropicThinkingLevelsForModel({ reasoning: true }),
    ["off", "low", "medium", "high"],
  );
  assert.deepEqual(
    anthropicThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }),
    ["off", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    anthropicThinkingLevelsForModel({ reasoning: false }),
    [],
  );
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
  assert.deepEqual(
    parseAnthropicThinkingPreferences({ "claude-opus-4-8": "xhigh" }),
    { "claude-opus-4-8": "xhigh" },
  );
  assert.throws(
    () => parseAnthropicThinkingPreferences({ "claude-opus-4-8": "minimal" }),
    /Invalid Anthropic thinking preference/u,
  );
});
