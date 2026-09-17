import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./auto-router-settings.tsx", import.meta.url), "utf8");

test("Auto Router settings defines all three optimization presets", () => {
  assert.match(source, /value:\s*"balanced"/u);
  assert.match(source, /title:\s*"Balanced"/u);
  assert.match(source, /value:\s*"cost"/u);
  assert.match(source, /title:\s*"Cost Saver"/u);
  assert.match(source, /value:\s*"capability"/u);
  assert.match(source, /title:\s*"Max Coding Capability"/u);
  assert.match(source, /RadioGroup/u);
  assert.match(source, /RadioGroupItem/u);
});

test("Auto Router settings complies with docs/settings-design-system.md for radio cards", () => {
  // Do not put decorative borders or outlines around radio-button choice cards.
  // Selection communicated with the radio control and background-state tokens.
  assert.match(source, /isSelected\s*&&\s*"bg-control"/u);
  assert.doesNotMatch(source, /border-accent/u);
  assert.doesNotMatch(source, /outline-accent/u);
});

test("Auto Router settings owns the OpenRouter benchmark key flow securely", () => {
  assert.match(source, /type="password"/u);
  assert.match(source, /autoComplete="off"/u);
  assert.match(source, /spellCheck=\{false\}/u);
  assert.match(source, /modelInsightsApi\.connect/u);
  assert.match(source, /modelInsightsApi\.disconnect/u);
  assert.match(source, /modelInsightsApi\.refresh/u);
  assert.match(source, /Isolated key/u);
  assert.match(source, /Manual fetch/u);
  assert.match(source, /Offline cache/u);
  assert.doesNotMatch(source, /value=\{status\?\.(?:key|apiKey)/u);
});

test("Auto Router settings renders Personal Model Pad inventory with benchmark and cost indicators", () => {
  assert.match(source, /Personal Model Pad inventory/u);
  assert.match(source, /Coding/u);
  assert.match(source, /Intel/u);
  assert.match(source, /Agentic/u);
  assert.match(source, /formatCostSummary/u);
  assert.match(source, /Switch/u);
  assert.match(source, /handleToggleExclusion/u);
  assert.match(source, /excludedModels:\s*Array\.from\(nextExcluded\)/u);
});

test("Auto Router settings handles empty Model Pad state with actionable CTA", () => {
  assert.match(source, /padModels\.length === 0/u);
  assert.match(source, /Your Model Pad is empty/u);
  assert.match(source, /Configure Model Pad/u);
  assert.match(source, /section:\s*"modelData"/u);
});

test("Auto Router settings persistence normalizes settings documents safely", async () => {
  const { normalizeSettingsShape, runtimeSettingsFrom } = await import(
    "../../../main/services/portable-config-core.js"
  );

  // 1. Valid settings document round-trips
  const valid = normalizeSettingsShape({
    settings: {
      autoRouter: {
        preset: "cost",
        excludedModels: ["anthropic::claude-3-7-sonnet", "openai::gpt-4o"],
      },
    },
  });
  assert.deepEqual(valid.settings.autoRouter, {
    preset: "cost",
    excludedModels: ["anthropic::claude-3-7-sonnet", "openai::gpt-4o"],
  });

  const projected = runtimeSettingsFrom(valid.settings);
  assert.deepEqual(projected.autoRouter, {
    preset: "cost",
    excludedModels: ["anthropic::claude-3-7-sonnet", "openai::gpt-4o"],
  });

  // 2. Malformed non-object autoRouter is dropped safely
  const malformedString = normalizeSettingsShape({
    settings: { autoRouter: "invalid-primitive" },
  });
  assert.equal(malformedString.settings.autoRouter, undefined);
  assert.equal(runtimeSettingsFrom({ autoRouter: "bad" as never }).autoRouter, undefined);

  // 3. Unknown preset normalizes to "balanced"
  const invalidPreset = normalizeSettingsShape({
    settings: { autoRouter: { preset: "ultra-fast", excludedModels: ["p::m"] } },
  });
  assert.equal(invalidPreset.settings.autoRouter?.preset, "balanced");

  // 4. Non-string elements in excludedModels are pruned
  const mixedExclusions = normalizeSettingsShape({
    settings: { autoRouter: { preset: "capability", excludedModels: ["valid::model", 123, null] } },
  });
  assert.deepEqual(mixedExclusions.settings.autoRouter?.excludedModels, ["valid::model"]);
});

test("Auto Router IPC handler validation enforces payload contracts", async () => {
  const { parseAutoRouterSetting } = await import("../../../main/services/auto-router-core.js");

  // Valid payloads
  assert.deepEqual(parseAutoRouterSetting({ preset: "cost" }), { preset: "cost" });
  assert.deepEqual(parseAutoRouterSetting({ preset: "capability", excludedModels: ["a::b"] }), {
    preset: "capability",
    excludedModels: ["a::b"],
  });
  assert.deepEqual(parseAutoRouterSetting({ preset: "balanced" }), { preset: "balanced" });

  // Unknown preset falls back to balanced
  assert.deepEqual(parseAutoRouterSetting({ preset: "magic" }), { preset: "balanced" });

  // Non-strings in excludedModels are filtered out
  assert.deepEqual(
    parseAutoRouterSetting({ preset: "cost", excludedModels: ["a::b", 42, false] }),
    { preset: "cost", excludedModels: ["a::b"] },
  );

  // Invalid non-objects throw
  assert.throws(() => parseAutoRouterSetting(null), /Invalid autoRouter setting/u);
  assert.throws(() => parseAutoRouterSetting("not-an-object"), /Invalid autoRouter setting/u);
  assert.throws(() => parseAutoRouterSetting(123), /Invalid autoRouter setting/u);
});
