import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeProviderThinkingPreference,
  normalizeProviderThinkingLevel,
  parseProviderThinkingPreferences,
} from "./provider-thinking.js";

test("provider thinking preferences are bounded, nested, and model-specific", () => {
  const current = { "opencode-go": { "ox-alpha-free": "low" as const } };
  assert.deepEqual(
    mergeProviderThinkingPreference(current, "opencode-go", "ox-alpha-free", "max"),
    { "opencode-go": { "ox-alpha-free": "max" } },
  );
  assert.throws(() => parseProviderThinkingPreferences({ p: { m: "ultra" } }));
});

test("provider thinking normalization prefers medium and stays inside declared levels", () => {
  assert.equal(normalizeProviderThinkingLevel(["low", "high", "max"], "medium"), "high");
  assert.equal(normalizeProviderThinkingLevel(["low", "medium", "high"], undefined), "medium");
  assert.equal(normalizeProviderThinkingLevel(["high", "max"], "max"), "max");
});
