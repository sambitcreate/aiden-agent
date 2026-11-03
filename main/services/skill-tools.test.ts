import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { makeSkillTool } from "./skill-tools.js";

test("skill tool execution does not traverse a directory replaced after discovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skill-tool-"));
  const original = path.join(root, "skill");
  const moved = path.join(root, "skill-moved");
  const outside = path.join(root, "outside");
  await fs.mkdir(original);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "CANARY_SECRET_NAME.txt"), "secret", "utf8");
  const skillMd = path.join(original, "SKILL.md");
  await fs.writeFile(skillMd, "snapshotted", "utf8");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const tool = makeSkillTool([{
    stableId: "workspace:skill",
    name: "Safe skill",
    description: "Safe.",
    instructions: "snapshotted instructions",
    source: "workspace",
    enabled: true,
    path: skillMd,
    available: true,
    invocationId: `sk1_${"a".repeat(43)}`,
    toolKey: "skill_safe_skill",
  }]);

  await fs.rename(original, moved);
  await fs.symlink(outside, original);
  const result = await tool.execute("test", { name: "Safe skill" });
  const text = result.content.find((block) => block.type === "text")?.text ?? "";
  assert.match(text, /snapshotted instructions/u);
  assert.doesNotMatch(text, /CANARY_SECRET_NAME/u);
});

test("a skill tool created before global disable refuses to return its instructions", async () => {
  let enabled = true;
  const tool = makeSkillTool(
    [{
      stableId: "configured:one",
      name: "Review",
      description: "Review code",
      instructions: "PRIVATE_SKILL_INSTRUCTIONS",
      source: "configured",
      enabled: true,
      available: true,
      invocationId: `sk1_${"a".repeat(43)}`,
      toolKey: "skill_review",
    }],
    async () => enabled,
  );
  assert.match(JSON.stringify(await tool.execute("first", { name: "Review" })), /PRIVATE_SKILL_INSTRUCTIONS/u);
  enabled = false;
  await assert.rejects(tool.execute("second", { name: "Review" }), /Skills are disabled/u);
});

test("direct model execution cannot load a user-only skill body", async () => {
  const tool = makeSkillTool([{
    stableId: "global:user-only", name: "User only", description: "Explicit only",
    instructions: "SECRET_BODY", source: "global", enabled: true, available: true,
    invocationId: `sk1_${"a".repeat(43)}`, toolKey: "skill_user_only", modelInvocable: false,
  }]);
  assert.doesNotMatch(tool.description, /SECRET_BODY/u);
  await assert.rejects(tool.execute("forged", { name: "User only" }), /does not allow model invocation/u);
});

test("the skill tool loads a listed skill by its name in any case, and nothing it was not built with", async () => {
  const skill = (name: string, instructions: string) => ({
    stableId: `global:${name}`, name, description: `${name} help`, instructions, source: "global" as const,
    enabled: true, available: true, invocationId: `sk1_${"a".repeat(43)}`, toolKey: `skill_${name.toLowerCase()}`,
  });
  // A Bot granted only "Notes" gets a tool built from that one skill.
  const tool = makeSkillTool([skill("Notes", "NOTES_BODY")]);
  assert.match(JSON.stringify(await tool.execute("a", { name: "notes" })), /NOTES_BODY/u);
  assert.match(JSON.stringify(await tool.execute("b", { name: " Notes " })), /NOTES_BODY/u);
  await assert.rejects(tool.execute("c", { name: "Mail" }), /No skill named "Mail" is available here\. Available: Notes\./u);
  await assert.rejects(tool.execute("d", {}), /No skill named ""/u);
  // A listed name wins over another skill's internal key, whatever the order.
  const shadow = { ...skill("skill_notes", "SHADOW_BODY"), toolKey: "skill_skill_notes" };
  for (const skills of [[skill("Notes", "NOTES_BODY"), shadow], [shadow, skill("Notes", "NOTES_BODY")]]) {
    assert.match(JSON.stringify(await makeSkillTool(skills).execute("e", { name: "skill_notes" })), /SHADOW_BODY/u);
  }
});
