import assert from "node:assert/strict";
import test from "node:test";
import { resolveBotCapabilitySkills, resolveBotRuntimeSkillBindings } from "./bot-skill-inventory.js";

test("Bot skills resolve configured, global, and only the selected Bot home without paths", async () => {
  const discoveredRoots: Array<string | undefined> = [];
  const skills = await resolveBotCapabilitySkills({
    loadIdentityKey: async () => Buffer.alloc(32, 7),
    listConfigured: async () => [
      { id: "configured", name: "Configured", description: "Configured skill", instructions: "Do configured work", enabled: true },
    ],
    botId: "bot:a",
    loadBotHomePath: async () => "/private/bot-a",
    discover: async (workspaceRoot) => {
      discoveredRoots.push(workspaceRoot);
      return workspaceRoot
        ? [{ id: `workspace:${workspaceRoot}/.aiden/skills/home/SKILL.md`, name: "Home A", description: "Home skill", instructions: "Do home work", source: "workspace", path: `${workspaceRoot}/.aiden/skills/home/SKILL.md` }]
        : [{ id: "global:/private/.agents/global/SKILL.md", name: "Global", description: "Global skill", instructions: "Do global work", source: "global", path: "/private/.agents/global/SKILL.md" }];
    },
  });
  assert.deepEqual(skills.map(({ label }) => label).sort(), ["Configured", "Global", "Home A"]);
  assert.deepEqual(discoveredRoots, [undefined, "/private/bot-a"]);
  const serialized = JSON.stringify(skills);
  assert.doesNotMatch(serialized, /private|SKILL\.md/u);
  assert(skills.every(({ sourceId }) => /^skill:[A-Za-z0-9_-]{43}$/u.test(sourceId)));
});

test("create-Bot skill inventory never discovers a managed Bot home", async () => {
  const discoveredRoots: Array<string | undefined> = [];
  const skills = await resolveBotCapabilitySkills({
    loadIdentityKey: async () => Buffer.alloc(32, 8),
    listConfigured: async () => [],
    discover: async (workspaceRoot) => {
      discoveredRoots.push(workspaceRoot);
      return workspaceRoot === undefined
        ? [{ id: "global:one", name: "Global", description: "Global", instructions: "Global", source: "global", path: "/hidden/global/SKILL.md" }]
        : [{ id: "workspace:private", name: "Private", description: "Private", instructions: "Private", source: "workspace", path: "/hidden/bot/SKILL.md" }];
    },
  });
  assert.deepEqual(discoveredRoots, [undefined]);
  assert.deepEqual(skills.map(({ label }) => label), ["Global"]);
});


test("global disable withholds Bot catalogs and runtime bindings without reading skill content", async () => {
  const unexpectedRead = async (): Promise<never> => { throw new Error("Skill storage must not be read"); };
  const dependencies = {
    isEnabled: async () => false,
    loadIdentityKey: unexpectedRead,
    listConfigured: unexpectedRead,
    loadBotHomePath: unexpectedRead,
    discover: unexpectedRead,
  };
  assert.deepEqual(await resolveBotCapabilitySkills(dependencies), []);
  assert.deepEqual(await resolveBotRuntimeSkillBindings(dependencies), []);
});
