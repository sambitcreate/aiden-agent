import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createSettingsApplicationEffects } from "../../../main/services/settings-application-effects-core.js";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { SkillsSettings } from "./skills-settings";
import type { AppSettings, Skill } from "../../lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const WORKSPACE = { id: "workspace-1", name: "Workspace", path: "/tmp/workspace" };

function discoveredSkill(index: number, description = `Helps with task ${index}.`) {
  return {
    available: true,
    description,
    invocationId: `sk1_${String(index).padStart(43, "a")}`,
    name: `skill-${index}`,
    source: "workspace",
  };
}

function mount({
  settings = {},
  skills = [],
  discovered = [],
  saveFails = false,
}: {
  settings?: Partial<AppSettings>;
  skills?: Skill[];
  discovered?: ReturnType<typeof discoveredSkill>[];
  saveFails?: boolean;
} = {}) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      if (saveFails) throw new Error("Could not save");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
    "skills:list": () => skills,
    "skills:catalog": () => discovered,
    "workspaces:list": () => [WORKSPACE],
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <SkillsSettings />
    </QueryClientProvider>,
  );
  return calls;
}

const ownSkill: Skill = {
  id: "skill-own",
  name: "Reviewer",
  description: "Reviews code.",
  instructions: "Review it.",
  enabled: true,
};

test("turning skills off saves the setting, says so and locks each skill's switch", async () => {
  const calls = mount({ skills: [ownSkill] });
  const toggle = await screen.findByRole("switch", { name: "Use skills globally" });
  const row = await screen.findByRole("switch", { name: "Enable Reviewer" });
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.equal(row.hasAttribute("disabled"), false);

  fireEvent.click(toggle);

  await screen.findByText(/Skills are off\./u);
  assert.equal(row.hasAttribute("disabled"), true);
  assert.deepEqual(
    calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]),
    [{ skillsEnabled: false }],
  );
});

test("a failed save leaves skills on", async () => {
  mount({ saveFails: true });
  const toggle = await screen.findByRole("switch", { name: "Use skills globally" });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(screen.queryByText(/Skills are off\./u) === null, true);
});

test("eight discovered skills list without a search field", async () => {
  mount({ discovered: Array.from({ length: 8 }, (_, index) => discoveredSkill(index + 1)) });
  await screen.findByText("skill-8");
  assert.equal(screen.queryByRole("searchbox") === null, true);
  assert.equal(screen.queryByLabelText("Search discovered skills") === null, true);
});

test("past eight discovered skills, search narrows by name and by description", async () => {
  mount({
    discovered: [
      ...Array.from({ length: 8 }, (_, index) => discoveredSkill(index + 1)),
      discoveredSkill(9, "Drafts release notes."),
    ],
  });
  const search = await screen.findByLabelText("Search discovered skills");

  fireEvent.change(search, { target: { value: "skill-3" } });
  await waitFor(() => assert.equal(screen.queryByText("skill-1") === null, true));
  await screen.findByText("skill-3");

  fireEvent.change(search, { target: { value: "release notes" } });
  await screen.findByText("skill-9");
  assert.equal(screen.queryByText("skill-3") === null, true);

  fireEvent.change(search, { target: { value: "no such skill" } });
  await screen.findByText("No skills match “no such skill”.");
  assert.equal(screen.queryByText("skill-9") === null, true);
});

test("the settings boundary revokes cached skill authority before publishing the saved state, leaving running replies alone", async () => {
  const events: string[] = [];
  const effects = createSettingsApplicationEffects({
    invalidateSkills: () => { events.push("invalidate"); }, revokeBotSkills: () => { events.push("revoke"); },
    refreshCommands: async () => { events.push("refresh-commands"); }, reconfigureIdleUnload: async () => { events.push("idle"); },
    preloadLocalVoice: () => { events.push("preload-voice"); },
    publishAppearance: () => { events.push("appearance"); }, publishControls: () => { events.push("publish"); },
    stopCacheWarmers: () => { events.push("stop-warmers"); },
    revokeComputerUseGrants: async () => { events.push("revoke-computer-use"); },
    stopLiveSessions: async () => { events.push("stop-live"); },
  });
  await effects({ skillsEnabled: false }, { skillsEnabled: false });
  assert.deepEqual(events, ["invalidate", "revoke", "refresh-commands", "publish"]);
  events.length = 0;
  await effects({ skillsEnabled: true }, { skillsEnabled: true });
  assert.deepEqual(events, ["invalidate", "revoke", "refresh-commands", "publish"]);
  events.length = 0;
  await effects({ memoryEnabled: false }, { memoryEnabled: false });
  assert.deepEqual(events, ["publish"]);
  events.length = 0;
  // Turning a feature off stops the work it owns; turning it on starts nothing.
  await effects({}, { cacheWarmingEnabled: false, computerUseAlwaysAllow: false, aidenLiveEnabled: false });
  assert.deepEqual(events, ["stop-warmers", "revoke-computer-use", "stop-live", "publish"]);
  events.length = 0;
  await effects({}, { cacheWarmingEnabled: true, computerUseAlwaysAllow: true, aidenLiveEnabled: true });
  assert.deepEqual(events, ["publish"]);
});


test("a skill attachment prepared before disabling is checked again before prompt injection", () => {
  const runtime = readFileSync(new URL("../../../main/services/llm-client.ts", import.meta.url), "utf8");
  assert.match(runtime, /initialization\.skillPrompt[\s\S]*getSettings\(\)\)\.skillsEnabled === false[\s\S]*contentOverrides\.set\(currentUser\.id, initialization\.skillPrompt\)/u);
});
