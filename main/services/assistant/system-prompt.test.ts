import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantSystemPrompt } from "./system-prompt.js";

const base = {
  settingsSections: ["providers", "appearance"],
  settingsPermission: "ask" as const,
  availableTools: ["get_settings", "set_setting", "list_projects"],
  unattended: false,
};

test("introduces Aiden as an assistant about the app, not a coding agent", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /You are Aiden/u);
  assert.match(prompt, /Aiden Agent/u);
  assert.match(prompt, /not a coding agent/u);
});

test("grounds the prompt in settings sections without disclosing workspace inventory", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /providers/u);
  assert.doesNotMatch(prompt, /The user's projects are:/u);
});

test("states the approval posture for settings mutations", () => {
  assert.match(buildAssistantSystemPrompt(base), /must approve/u);
  assert.match(
    buildAssistantSystemPrompt({ ...base, settingsPermission: "full" }),
    /without asking/u,
  );
  assert.match(
    buildAssistantSystemPrompt({ ...base, settingsPermission: "none" }),
    /cannot change settings/u,
  );
});

test("without live-state tools it is told not to claim live state", () => {
  const prompt = buildAssistantSystemPrompt({ ...base, availableTools: [] });
  assert.match(prompt, /cannot read the user's current settings/u);
  assert.match(prompt, /Never state what a setting is currently set to/u);
  // The instruction to consult tools must not survive without the tools.
  assert.doesNotMatch(prompt, /read settings before describing them/u);
  // And an approval posture is meaningless with no tool to approve.
  assert.doesNotMatch(prompt, /must approve/u);
});

test("with tools it is told to consult them instead of guessing", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /read settings before describing them/u);
  assert.match(prompt, /check project status before reporting on it/u);
  assert.doesNotMatch(prompt, /cannot read the user's current settings/u);
});

test("each grounding clause tracks its own tool", () => {
  const settingsOnly = buildAssistantSystemPrompt({
    ...base,
    availableTools: ["get_settings"],
  });
  assert.match(settingsOnly, /read settings before describing them/u);
  assert.doesNotMatch(settingsOnly, /check project status/u);

  const projectsOnly = buildAssistantSystemPrompt({
    ...base,
    availableTools: ["list_projects"],
  });
  assert.match(projectsOnly, /check project status before reporting on it/u);
  assert.doesNotMatch(projectsOnly, /read settings before describing them/u);
});

test("adds the [SILENT] contract only for unattended runs", () => {
  assert.doesNotMatch(buildAssistantSystemPrompt(base), /\[SILENT\]/u);
  const unattended = buildAssistantSystemPrompt({ ...base, unattended: true });
  assert.match(unattended, /\[SILENT\]/u);
  assert.match(unattended, /nothing else/u);
});

test("an unrecognised settings permission falls back to requiring approval", () => {
  // settings.json is not schema-validated, so this value can be anything. A bare
  // record lookup failed open (no instruction at all) and reached Object
  // prototype keys like "toString".
  for (const bogus of ["bogus", "toString", "constructor", "__proto__"]) {
    const prompt = buildAssistantSystemPrompt({
      ...base,
      settingsPermission: bogus as "ask",
    });
    assert.match(prompt, /must approve/u, bogus);
    assert.doesNotMatch(prompt, /native code/u, bogus);
    assert.doesNotMatch(prompt, /\[object Object\]/u, bogus);
  }
});
