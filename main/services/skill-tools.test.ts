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

  const tool = makeSkillTool({
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
  });

  await fs.rename(original, moved);
  await fs.symlink(outside, original);
  const result = await tool.execute("test", {});
  const text = result.content.find((block) => block.type === "text")?.text ?? "";
  assert.match(text, /snapshotted instructions/u);
  assert.doesNotMatch(text, /CANARY_SECRET_NAME/u);
});

test("a skill tool created before global disable refuses to return its instructions", async () => {
  let enabled = true;
  const tool = makeSkillTool(
    {
      stableId: "configured:one",
      name: "Review",
      description: "Review code",
      instructions: "PRIVATE_SKILL_INSTRUCTIONS",
      source: "configured",
      enabled: true,
      available: true,
      invocationId: `sk1_${"a".repeat(43)}`,
      toolKey: "skill_review",
    },
    async () => enabled,
  );
  assert.match(JSON.stringify(await tool.execute("first", {})), /PRIVATE_SKILL_INSTRUCTIONS/u);
  enabled = false;
  await assert.rejects(tool.execute("second", {}), /Skills are disabled/u);
});
