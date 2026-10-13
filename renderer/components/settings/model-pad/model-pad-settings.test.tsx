import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The benchmark-key flow (connect, replace, disconnect, key never shown back)
// is covered behaviorally in model-pad-data-rows.test.tsx.
const editorSource = readFileSync(new URL("./model-pad-settings.tsx", import.meta.url), "utf8");
const modelDataSource = readFileSync(new URL("../model-data-settings.tsx", import.meta.url), "utf8");

test("legacy direct Artificial Analysis settings are retired", () => {
  assert.match(modelDataSource, /<ModelPadSettings \/>/u);
  assert.doesNotMatch(modelDataSource, /AdvisorSettings/u);
  assert.match(modelDataSource, /Advisor selection happens at the point of consultation/u);
  assert.doesNotMatch(modelDataSource, /artificialAnalysisApi/u);
  assert.doesNotMatch(modelDataSource, /Legacy direct benchmark source/u);
  assert.doesNotMatch(editorSource, /useArtificialAnalysisStatus/u);
});
