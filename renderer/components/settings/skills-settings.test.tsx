import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSettingsApplicationEffects } from "../../../main/services/settings-application-effects-core.js";

const source = readFileSync(new URL("./skills-settings.tsx", import.meta.url), "utf8");

test("Skills exposes a persisted global switch with a right-side control and failure recovery", () => {
  assert.match(source, /label="Use skills globally"[\s\S]*orientation="horizontal"/u);
  assert.match(source, /settingsApi\.set\(\{ skillsEnabled: enabled \}\)/u);
  assert.match(source, /disabled=\{globalSaving \|\| !settings.data\}/u);
  assert.match(source, /setQueryData<AppSettings>\(queryKeys.settings, saved\)/u);
  assert.match(source, /toast\.error/u);
  assert.match(source, /Visible chat history stays available/u);
  assert.match(source, /disabled=\{!globallyEnabled\}/u);
});

test("the settings boundary revokes cached skill authority and settles active work before publishing the saved state", async () => {
  const events: string[] = [];
  const effects = createSettingsApplicationEffects({
    invalidateSkills: () => { events.push("invalidate"); }, revokeBotSkills: () => { events.push("revoke"); },
    cancelSkillWork: async () => { await Promise.resolve(); events.push("cancel-active-work"); },
    refreshCommands: async () => { events.push("refresh-commands"); }, reconfigureIdleUnload: async () => { events.push("idle"); },
    publishAppearance: () => { events.push("appearance"); }, publishControls: () => { events.push("publish"); },
  });
  await effects({ skillsEnabled: false }, { skillsEnabled: false });
  assert.deepEqual(events, ["invalidate", "revoke", "cancel-active-work", "refresh-commands", "publish"]);
  events.length = 0;
  await effects({ skillsEnabled: true }, { skillsEnabled: true });
  assert.deepEqual(events, ["invalidate", "revoke", "refresh-commands", "publish"]);
  events.length = 0;
  await effects({ memoryEnabled: false }, { memoryEnabled: false });
  assert.deepEqual(events, ["publish"]);
});


test("a skill attachment prepared before disabling is checked again before prompt injection", () => {
  const runtime = readFileSync(new URL("../../../main/services/llm-client.ts", import.meta.url), "utf8");
  assert.match(runtime, /initialization\.skillPrompt[\s\S]*getSettings\(\)\)\.skillsEnabled === false[\s\S]*contentOverrides\.set\(currentUser\.id, initialization\.skillPrompt\)/u);
});
