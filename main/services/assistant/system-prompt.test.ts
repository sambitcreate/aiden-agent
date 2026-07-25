import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantSystemPrompt } from "./system-prompt.js";

const base = {
  workspaceNames: ["aiden-agent", "notes"],
  settingsSections: ["providers", "appearance"],
  settingsPermission: "ask" as const,
  unattended: false,
};

test("introduces Aiden as an assistant about the app, not a coding agent", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /You are Aiden/u);
  assert.match(prompt, /Aiden Agent/u);
  assert.match(prompt, /not a coding agent/u);
});

test("grounds the prompt in the user's workspaces and settings sections", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /aiden-agent/u);
  assert.match(prompt, /notes/u);
  assert.match(prompt, /providers/u);
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

test("adds the [SILENT] contract only for unattended runs", () => {
  assert.doesNotMatch(buildAssistantSystemPrompt(base), /\[SILENT\]/u);
  const unattended = buildAssistantSystemPrompt({ ...base, unattended: true });
  assert.match(unattended, /\[SILENT\]/u);
  assert.match(unattended, /nothing else/u);
});

test("handles a user with no workspaces without emitting a dangling list", () => {
  const prompt = buildAssistantSystemPrompt({ ...base, workspaceNames: [] });
  assert.doesNotMatch(prompt, /projects are:\s*\./u);
  assert.match(prompt, /no projects/u);
});
