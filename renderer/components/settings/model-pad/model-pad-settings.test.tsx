import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./model-pad-data-rows.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("./model-pad-settings.tsx", import.meta.url), "utf8");
const modelDataSource = readFileSync(new URL("../model-data-settings.tsx", import.meta.url), "utf8");

test("Model Pad owns the OpenRouter benchmark-key flow and explains catalog isolation", () => {
  assert.match(source, /label="OpenRouter key for Model Pad"/u);
  assert.match(source, /modelInsightsApi\.connect\(key\)/u);
  assert.match(source, /modelInsightsApi\.disconnect\(\)/u);
  assert.match(source, /This key is separate from OpenRouter chat providers/u);
  assert.match(source, /will not add OpenRouter’s 500\+ models to your model list/u);
  assert.match(source, /fixed OpenRouter benchmark endpoint/u);
  assert.doesNotMatch(source, /section: "providers"/u);
});

test("Model Pad never renders a saved API key back into its password field", () => {
  assert.match(source, /type="password"/u);
  assert.match(source, /autoComplete="off"/u);
  assert.match(source, /setKeyDraft\(""\)/u);
  assert.doesNotMatch(source, /value=\{status\?\.(?:key|apiKey)/u);
});

test("legacy direct Artificial Analysis settings are retired", () => {
  assert.match(modelDataSource, /<ModelPadSettings \/>/u);
  assert.doesNotMatch(modelDataSource, /AdvisorSettings/u);
  assert.match(modelDataSource, /Advisor selection happens at the point of consultation/u);
  assert.doesNotMatch(modelDataSource, /artificialAnalysisApi/u);
  assert.doesNotMatch(modelDataSource, /Legacy direct benchmark source/u);
  assert.doesNotMatch(editorSource, /useArtificialAnalysisStatus/u);
});
