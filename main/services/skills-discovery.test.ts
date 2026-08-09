import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SLASH_LIMITS } from "../../renderer/shared/slash-commands.js";
import {
  discoverSkillCandidates,
  discoverSkills,
  SKILL_DISCOVERY_LIMITS,
} from "./skills-discovery.js";

async function writeSkill(dir: string, name: string, body: string) {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf-8");
}

test("discovers legacy global .agents skills", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".agents"),
    "legacy-global",
    `---\nname: legacy-global\ndescription: Legacy layout skill.\n---\n# Instructions\n`,
  );

  const skills = await discoverSkills(undefined, home);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "legacy-global");
  assert.equal(skills[0]?.source, "global");
});

test("discovers nested global .agents/skills skills", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".agents", "skills"),
    "nested-global",
    `---\nname: nested-global\ndescription: Nested layout skill.\n---\n# Instructions\n`,
  );

  const skills = await discoverSkills(undefined, home);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "nested-global");
  assert.equal(skills[0]?.source, "global");
});

test("discovers global .claude/skills skills", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".claude", "skills"),
    "claude-skill",
    `---\nname: claude-skill\ndescription: Claude layout skill.\n---\n# Instructions\n`,
  );

  const skills = await discoverSkills(undefined, home);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "claude-skill");
});

test("discovers global .aiden/{skill,skills} skills", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".aiden", "skill"),
    "aiden-skill-one",
    `---\nname: aiden-skill-one\ndescription: Aiden skill layout.\n---\n# Instructions\n`,
  );
  await writeSkill(
    path.join(home, ".aiden", "skills"),
    "aiden-skill-two",
    `---\nname: aiden-skill-two\ndescription: Aiden skills layout.\n---\n# Instructions\n`,
  );

  const skills = await discoverSkills(undefined, home);
  assert.equal(skills.length, 2);
  assert.ok(skills.some((s) => s.name === "aiden-skill-one"));
  assert.ok(skills.some((s) => s.name === "aiden-skill-two"));
});

test("discovers workspace skills", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-workspace-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  await writeSkill(
    path.join(workspace, ".agents", "skills"),
    "workspace-skill",
    `---\nname: workspace-skill\ndescription: Workspace skill.\n---\n# Instructions\n`,
  );

  const skills = await discoverSkills(workspace, home);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "workspace-skill");
  assert.equal(skills[0]?.source, "workspace");
});

test("workspace skills override global skills by name", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-workspace-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  await writeSkill(
    path.join(home, ".agents", "skills"),
    "shared",
    `---\nname: shared\ndescription: Global version.\n---\nGlobal instructions\n`,
  );
  await writeSkill(
    path.join(workspace, ".agents", "skills"),
    "shared",
    `---\nname: shared\ndescription: Workspace version.\n---\nWorkspace instructions\n`,
  );

  const skills = await discoverSkills(workspace, home);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.description, "Workspace version.");
  assert.equal(skills[0]?.source, "workspace");
});

test("authoritative discovery retains colliding candidates for registry resolution", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-workspace-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  await writeSkill(
    path.join(home, ".agents", "skills"),
    "shared",
    "---\nname: shared\n---\nGlobal instructions\n",
  );
  await writeSkill(
    path.join(workspace, ".agents", "skills"),
    "shared",
    "---\nname: shared\n---\nWorkspace instructions\n",
  );

  const candidates = await discoverSkillCandidates(workspace, home);
  assert.deepEqual(candidates.map((skill) => skill.source).sort(), ["global", "workspace"]);
});

test("native, Claude, and Agents roots retain their documented precedence", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".agents", "skills"),
    "shared",
    "---\nname: shared\n---\nAgents\n",
  );
  await writeSkill(
    path.join(home, ".claude", "skills"),
    "shared",
    "---\nname: shared\n---\nClaude\n",
  );
  await writeSkill(
    path.join(home, ".aiden", "skills"),
    "shared",
    "---\nname: shared\n---\nAiden\n",
  );

  const legacy = await discoverSkills(undefined, home);
  assert.equal(legacy[0]?.instructions, "Aiden");
  const candidates = await discoverSkillCandidates(undefined, home);
  assert.deepEqual(
    candidates.map((skill) => skill.instructions),
    ["Aiden", "Claude", "Agents"],
  );
});

test("filesystem discovery enforces an aggregate candidate and traversal budget", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-workspace-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const root = path.join(workspace, ".aiden", "skills");
  await fs.mkdir(root, { recursive: true });
  await writeSkill(path.join(home, ".aiden", "skills"), "global-survivor", "global");

  const total = SKILL_DISCOVERY_LIMITS.candidatesPerSource + 25;
  for (let start = 0; start < total; start += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, total - start) }, async (_, offset) => {
        const index = start + offset;
        await writeSkill(root, `skill-${String(index).padStart(4, "0")}`, `instructions ${index}`);
      }),
    );
  }

  const candidates = await discoverSkillCandidates(workspace, home);
  assert.equal(candidates.length, SKILL_DISCOVERY_LIMITS.candidatesPerSource + 1);
  assert.equal(candidates.filter((skill) => skill.source === "workspace").length, 1_000);
  assert.ok(candidates.some((skill) => skill.name === "global-survivor"));
});

test("skips skills without instructions", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(path.join(home, ".agents", "skills"), "empty", `---\nname: empty\n---\n`);

  const skills = await discoverSkills(undefined, home);
  assert.equal(skills.length, 0);
});

test("skips an oversized skill without reading beyond the bounded contract", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".agents", "skills"),
    "oversized",
    `---\nname: oversized\n---\n${"x".repeat(SLASH_LIMITS.instructionBytes + 1)}`,
  );

  assert.deepEqual(await discoverSkills(undefined, home), []);
});

test("rejects skill files and directories that escape through symbolic links", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-outside-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const fileTarget = path.join(outside, "private.md");
  await fs.writeFile(fileTarget, "CANARY_PRIVATE_KEY_MATERIAL", "utf8");
  const fileSkill = path.join(home, ".agents", "skills", "file-link");
  await fs.mkdir(fileSkill, { recursive: true });
  await fs.symlink(fileTarget, path.join(fileSkill, "SKILL.md"));

  const directoryTarget = path.join(outside, "directory-link");
  await writeSkill(
    path.join(directoryTarget, "skills"),
    "nested",
    "---\nname: escaped\n---\nPRIVATE_DIRECTORY",
  );
  await fs.symlink(directoryTarget, path.join(home, ".claude"));

  assert.deepEqual(await discoverSkills(undefined, home), []);
});

test("rejects an ancestor symlink replacement between validation and open", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-outside-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const skillsRoot = path.join(home, ".agents", "skills");
  const original = path.join(skillsRoot, "raced");
  const parked = path.join(skillsRoot, "raced-original");
  await writeSkill(skillsRoot, "raced", "SAFE_INSTRUCTIONS");
  await writeSkill(outside, "replacement", "CANARY_PRIVATE_INSTRUCTIONS");

  let replaced = false;
  const candidates = await discoverSkillCandidates(undefined, home, {
    beforeSkillFileOpen: async () => {
      if (replaced) return;
      replaced = true;
      await fs.rename(original, parked);
      await fs.symlink(path.join(outside, "replacement"), original);
    },
  });

  assert.equal(replaced, true);
  assert.deepEqual(candidates, []);
});

test("rejects a skill root replacement before its canonical identity is trusted", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-outside-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const root = path.join(home, ".agents");
  const parked = path.join(home, ".agents-original");
  await writeSkill(path.join(root, "skills"), "safe", "SAFE_INSTRUCTIONS");
  await writeSkill(path.join(outside, "skills"), "escaped", "CANARY_PRIVATE_INSTRUCTIONS");

  let replaced = false;
  const candidates = await discoverSkillCandidates(undefined, home, {
    beforeSkillRootRealpath: async (candidateRoot) => {
      if (replaced || candidateRoot !== root) return;
      replaced = true;
      await fs.rename(root, parked);
      await fs.symlink(outside, root);
    },
  });

  assert.equal(replaced, true);
  assert.deepEqual(candidates, []);
});

test("caches repeated discovery for the same roots", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  await writeSkill(
    path.join(home, ".agents", "skills"),
    "first",
    `---\nname: first\ndescription: First skill.\n---\n# Instructions\n`,
  );

  const initial = await discoverSkills(undefined, home);
  assert.equal(initial.length, 1);

  // Written after the first scan; the cached result is returned within the TTL.
  await writeSkill(
    path.join(home, ".agents", "skills"),
    "second",
    `---\nname: second\ndescription: Second skill.\n---\n# Instructions\n`,
  );

  const cached = await discoverSkills(undefined, home);
  assert.equal(cached.length, 1);
  assert.equal(cached[0]?.name, "first");
});

test("returns empty array when no skill directories exist", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skills-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const skills = await discoverSkills(undefined, home);
  assert.equal(skills.length, 0);
});
