import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./skills-settings.tsx", import.meta.url), "utf8");
const handlers = readFileSync(
  new URL("../../../main/handlers/providers.ts", import.meta.url),
  "utf8",
);

test("Skills exposes a persisted global switch with a right-side control and failure recovery", () => {
  assert.match(source, /label="Use skills globally"[\s\S]*orientation="horizontal"/u);
  assert.match(source, /settingsApi\.set\(\{ skillsEnabled: enabled \}\)/u);
  assert.match(source, /disabled=\{globalSaving \|\| !settings.data\}/u);
  assert.match(source, /setQueryData<AppSettings>\(queryKeys.settings, saved\)/u);
  assert.match(source, /toast\.error/u);
  assert.match(source, /Visible chat history stays available/u);
  assert.match(source, /disabled=\{!globallyEnabled\}/u);
});

test("the settings boundary invalidates cached Bot and chat skills and stops old active replies", () => {
  assert.match(handlers, /typeof p.skillsEnabled !== "boolean"/u);
  assert.match(handlers, /skillRegistry\.invalidate\(\)/u);
  assert.match(handlers, /invalidateBotRuntimeInventoryAuthority\("skill_configuration"\)/u);
  assert.match(handlers, /llmClient\.cancelForSkillsDisabled\(\)/u);
});


test("a skill attachment prepared before disabling is checked again before prompt injection", () => {
  const runtime = readFileSync(new URL("../../../main/services/llm-client.ts", import.meta.url), "utf8");
  assert.match(runtime, /initialization\.skillPrompt[\s\S]*getSettings\(\)\)\.skillsEnabled === false[\s\S]*contentOverrides\.set\(currentUser\.id, initialization\.skillPrompt\)/u);
});
