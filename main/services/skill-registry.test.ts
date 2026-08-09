import assert from "node:assert/strict";
import test from "node:test";
import { SkillInvocationError } from "../../renderer/shared/slash-commands.js";
import {
  formatAvailableSkills,
  SkillRegistry,
  type SkillRegistryDependencies,
} from "./skill-registry.js";
import { buildSkillTools } from "./skill-tools.js";
import type { DiscoveredSkill, Skill, Workspace } from "./types.js";

function workspace(id: string, folderPath = `/trusted/${id}`): Workspace {
  return {
    id,
    name: id,
    folderPath,
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
  };
}

function configured(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "configured-one",
    name: "Review",
    description: "Configured review.",
    instructions: "Configured instructions.",
    enabled: true,
    ...overrides,
  };
}

function discovered(
  source: "workspace" | "global",
  overrides: Partial<DiscoveredSkill> = {},
): DiscoveredSkill {
  return {
    id: `${source}:/trusted/${source}/SKILL.md`,
    name: "Review",
    description: `${source} review.`,
    instructions: `${source} instructions.`,
    source,
    path: `/trusted/${source}/SKILL.md`,
    ...overrides,
  };
}

function harness(overrides: Partial<SkillRegistryDependencies> = {}) {
  let now = 100;
  let configuredSkills: Skill[] = [];
  let discoveredSkills: DiscoveredSkill[] = [];
  const workspaces = new Map([["one", workspace("one")]]);
  const roots: Array<string | undefined> = [];
  const registry = new SkillRegistry({
    getWorkspace: async (id) => workspaces.get(id),
    listConfigured: async () => structuredClone(configuredSkills),
    discover: async (root) => {
      roots.push(root);
      return structuredClone(
        root === undefined
          ? discoveredSkills.filter((skill) => skill.source === "global")
          : discoveredSkills,
      );
    },
    now: () => now,
    invocationKey: new Uint8Array(32).fill(7),
    cacheTtlMs: 50,
    cacheLimit: 4,
    ...overrides,
  });
  return {
    registry,
    roots,
    workspaces,
    setNow(value: number) {
      now = value;
    },
    setConfigured(value: Skill[]) {
      configuredSkills = value;
    },
    setDiscovered(value: DiscoveredSkill[]) {
      discoveredSkills = value;
    },
  };
}

test("one snapshot applies configured, workspace, and global collision precedence", async () => {
  const h = harness();
  h.setConfigured([configured()]);
  h.setDiscovered([discovered("global"), discovered("workspace")]);

  const snapshot = await h.registry.snapshot("one");
  assert.equal(snapshot.available.length, 1);
  assert.equal(snapshot.available[0]?.source, "configured");
  assert.equal(snapshot.available[0]?.instructions, "Configured instructions.");
  assert.deepEqual(
    snapshot.catalog.map((entry) => [entry.source, entry.available]),
    [
      ["configured", true],
      ["workspace", false],
      ["global", false],
    ],
  );
  assert.match(snapshot.catalog[1]?.unavailableReason ?? "", /configured skill/u);
  assert.equal(
    await h.registry.resolve("one", snapshot.catalog[0]!.invocationId),
    snapshot.skills[0],
  );
});

test("disabled configured skills do not shadow discovered skills", async () => {
  const h = harness();
  h.setConfigured([configured({ enabled: false })]);
  h.setDiscovered([discovered("global"), discovered("workspace")]);

  const snapshot = await h.registry.snapshot("one");
  assert.equal(snapshot.available.length, 1);
  assert.equal(snapshot.available[0]?.source, "workspace");
  assert.match(
    snapshot.catalog.find((entry) => entry.source === "configured")?.unavailableReason ?? "",
    /Disabled/u,
  );
  assert.match(
    snapshot.catalog.find((entry) => entry.source === "global")?.unavailableReason ?? "",
    /workspace skill/u,
  );
});

test("same-source duplicate winners are stable and duplicate ids fail closed", async () => {
  const h = harness();
  h.setConfigured([
    configured({ id: "z", description: "z" }),
    configured({ id: "a", description: "a" }),
    configured({ id: "duplicate", name: "Other" }),
    configured({ id: "duplicate", name: "Another" }),
  ]);

  const snapshot = await h.registry.snapshot("one");
  assert.equal(
    snapshot.available.find((skill) => skill.name === "Review")?.stableId,
    "configured:a",
  );
  assert.equal(
    snapshot.skills
      .filter((skill) => skill.stableId === "configured:duplicate")
      .every((skill) => !skill.available),
    true,
  );
});

test("cache reuse, explicit invalidation, and expiry mint coherent revisions", async () => {
  const h = harness();
  h.setConfigured([configured()]);
  const first = await h.registry.snapshot("one");
  assert.equal(await h.registry.snapshot("one"), first);
  assert.equal(h.roots.length, 1);

  h.setNow(151);
  const unchanged = await h.registry.snapshot("one");
  assert.equal(unchanged.revision, first.revision);
  assert.equal(unchanged.catalog[0]?.invocationId, first.catalog[0]?.invocationId);

  h.setConfigured([configured({ enabled: false })]);
  h.registry.invalidate("one");
  const invalidated = await h.registry.snapshot("one");
  assert.notEqual(invalidated.revision, first.revision);
  assert.notEqual(invalidated.catalog[0]?.invocationId, first.catalog[0]?.invocationId);
  assert.equal(invalidated.catalog[0]?.available, false);

  h.setNow(202);
  h.setConfigured([configured({ name: "Changed" })]);
  const expired = await h.registry.snapshot("one");
  assert.equal(expired.catalog[0]?.name, "Changed");
  assert.equal(h.roots.length, 4);
});

test("cache eviction cannot expire an unchanged invocation id", async () => {
  const h = harness();
  h.setConfigured([configured()]);
  const first = await h.registry.snapshot("one");
  for (const id of ["two", "three", "four", "five"]) {
    h.workspaces.set(id, workspace(id));
    await h.registry.snapshot(id);
  }
  const reloaded = await h.registry.snapshot("one");
  assert.equal(reloaded.revision, first.revision);
  assert.equal(reloaded.catalog[0]?.invocationId, first.catalog[0]?.invocationId);
});

test("the renderer catalog cap never suppresses internal tools or resolution", async () => {
  const h = harness();
  h.setConfigured(
    Array.from({ length: 500 }, (_, index) =>
      configured({
        id: `disabled-${String(index).padStart(3, "0")}`,
        name: `Disabled ${index}`,
        enabled: false,
      }),
    ),
  );
  h.setDiscovered([discovered("workspace", { name: "Workspace winner" })]);

  const snapshot = await h.registry.snapshot("one");
  assert.equal(snapshot.catalog.length, 500);
  assert.ok(snapshot.catalog.some((entry) => entry.name === "Workspace winner"));
  const winner = snapshot.available.find((skill) => skill.name === "Workspace winner");
  assert.ok(winner);
  assert.ok(buildSkillTools(snapshot).some((tool) => tool.name === winner.toolKey));
  assert.equal(await h.registry.resolve("one", winner.invocationId), winner);
  assert.match(formatAvailableSkills(snapshot) ?? "", /Workspace winner/u);
});

test("workspace ids are resolved authoritatively and path spoof strings are rejected", async () => {
  const h = harness();
  h.setDiscovered([discovered("workspace")]);
  await h.registry.snapshot("one");
  assert.deepEqual(h.roots, ["/trusted/one"]);

  await assert.rejects(
    h.registry.snapshot("/renderer/supplied/path"),
    (error) => error instanceof SkillInvocationError && error.code === "workspace_changed",
  );
  assert.deepEqual(h.roots, ["/trusted/one"]);
});

test("workspace path changes replace the snapshot immediately and expire old ids", async () => {
  const h = harness();
  h.setConfigured([configured()]);
  const first = await h.registry.snapshot("one");
  h.workspaces.set("one", workspace("one", "/trusted/moved"));
  const moved = await h.registry.snapshot("one");
  assert.equal(moved.workspaceRoot, "/trusted/moved");
  assert.notEqual(moved.revision, first.revision);
  await assert.rejects(
    h.registry.resolve("one", first.catalog[0]!.invocationId),
    (error) => error instanceof SkillInvocationError && error.code === "invalid_reference",
  );
});

test("catalog projection and prompt never expose instructions or paths", async () => {
  const h = harness();
  h.setDiscovered([
    discovered("workspace", {
      name: "Review <carefully>",
      description: "Check A & B.",
      instructions: "TOP SECRET INSTRUCTIONS",
      path: "/private/secret/SKILL.md",
    }),
  ]);
  const snapshot = await h.registry.snapshot("one");
  const serialized = JSON.stringify(snapshot.catalog);
  assert.doesNotMatch(serialized, /TOP SECRET|\/private\/secret|toolKey|instructions|path/u);

  const prompt = formatAvailableSkills(snapshot) ?? "";
  assert.match(prompt, /Review &lt;carefully&gt;/u);
  assert.match(prompt, /Check A &amp; B/u);
  assert.doesNotMatch(prompt, /TOP SECRET|\/private\/secret/u);
  assert.match(prompt, new RegExp(snapshot.available[0]!.toolKey, "u"));
  assert.equal(formatAvailableSkills(snapshot, new Set()), undefined);
});

test("unavailable catalog entries resolve to the identical reason", async () => {
  const h = harness();
  h.setConfigured([configured({ enabled: false })]);
  const snapshot = await h.registry.snapshot("one");
  const entry = snapshot.catalog[0]!;
  await assert.rejects(
    h.registry.resolve("one", entry.invocationId),
    (error) =>
      error instanceof SkillInvocationError &&
      error.code === "skill_unavailable" &&
      error.message === entry.unavailableReason,
  );
});

test("No Access does not read workspace skills and does not suppress global skills", async () => {
  const h = harness();
  h.workspaces.set("one", { ...workspace("one"), permission: "none" });
  h.setDiscovered([
    discovered("workspace", { name: "Workspace only" }),
    discovered("global", { name: "Global helper" }),
  ]);

  const snapshot = await h.registry.snapshot("one");
  assert.deepEqual(
    snapshot.available.map((skill) => skill.name),
    ["Global helper"],
  );
  assert.equal(snapshot.catalog.some((entry) => entry.source === "workspace"), false);
  assert.deepEqual(h.roots, [undefined]);
});

test("an effective per-generation No Access override withholds workspace skill tools", async () => {
  const h = harness();
  h.setDiscovered([
    discovered("workspace", { name: "Workspace only" }),
    discovered("global", { name: "Global helper" }),
  ]);
  const snapshot = await h.registry.snapshot("one");
  assert.deepEqual(
    buildSkillTools(snapshot, false).map((tool) => tool.label),
    ["Global helper"],
  );
});

test("tool, prompt, catalog, and explicit resolution share one collision-heavy snapshot", async () => {
  const h = harness();
  h.setConfigured([configured(), configured({ id: "disabled", name: "Disabled", enabled: false })]);
  h.setDiscovered([
    discovered("workspace"),
    discovered("global"),
    discovered("global", { id: "global:other", name: "Other" }),
  ]);
  const snapshot = await h.registry.snapshot("one");
  const tools = buildSkillTools(snapshot);
  const toolNames = new Set(tools.map((tool) => tool.name));
  const prompt = formatAvailableSkills(snapshot, toolNames) ?? "";

  assert.deepEqual(toolNames, new Set(snapshot.available.map((skill) => skill.toolKey)));
  for (const skill of snapshot.available) {
    assert.match(prompt, new RegExp(skill.toolKey, "u"));
    assert.equal(await h.registry.resolve("one", skill.invocationId), skill);
  }
  for (const entry of snapshot.catalog.filter((candidate) => !candidate.available)) {
    await assert.rejects(h.registry.resolve("one", entry.invocationId), SkillInvocationError);
  }
});
