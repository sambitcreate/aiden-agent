import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./provider-model-visibility.tsx", import.meta.url), "utf8");

test("provider visibility keeps bulk state visible and discloses individual controls accessibly", () => {
  const disclosure = source.indexOf("aria-expanded={expanded}");
  const conditionalControls = source.indexOf("{expanded && !policyHidden ? (");

  assert.match(source, /"Hide all"/u);
  assert.match(source, /"Show all"/u);
  assert.match(source, /Manage individual models/u);
  assert.match(source, /aria-controls=\{`model-visibility-controls-\$\{provider\.id\}`\}/u);
  assert.ok(disclosure > 0 && conditionalControls > disclosure);
  assert.match(source, /All models are hidden from new model selections/u);
});

test("bulk visibility is atomic and disables every competing mutation while pending", () => {
  assert.match(source, /settingsApi\.hideAllProviderModels\(provider\.id\)/u);
  assert.match(source, /settingsApi\.showAllProviderModels\(provider\.id\)/u);
  assert.match(source, /disabled=\{pending !== undefined\}/u);
  assert.match(source, /pending\?\.kind === "hide-all" \? "Hiding…"/u);
  assert.match(source, /pending\?\.kind === "show-all" \? "Showing…"/u);
});

test("transcription-only policy explains the gate instead of exposing no-op controls", () => {
  assert.match(source, /policyHidden/u);
  assert.match(source, /hidden by transcription-only access/u);
  assert.match(source, /Change Gemini access to Full\s+models/u);
  assert.match(source, /expanded && !policyHidden/u);
});
