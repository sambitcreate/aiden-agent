import assert from "node:assert/strict";
import test from "node:test";
import { SLASH_LIMITS } from "../../renderer/shared/slash-commands.js";
import {
  canonicalSkillIdentity,
  mintSkillInvocationId,
  projectSkillCatalog,
  projectSkillCatalogEntry,
  resolveSkillCandidates,
  skillToolKey,
  type SkillCatalogProjectionContext,
  type SkillRegistryCandidate,
} from "./skill-registry-core.js";

const candidate = (
  stableId: string,
  source: SkillRegistryCandidate["source"],
  enabled = true,
  name = "Review",
): SkillRegistryCandidate => ({
  stableId,
  name,
  description: "Review changes",
  instructions: "Do the work",
  source,
  enabled,
});

const context = (
  workspaceId = "workspace-1",
  registryRevision = "revision-1",
): SkillCatalogProjectionContext => ({
  workspaceId,
  registryRevision,
  invocationKey: new Uint8Array(32).fill(7),
});

test("configured, workspace, and global collisions use one deterministic precedence", () => {
  const resolved = resolveSkillCandidates([
    candidate("global-z", "global"),
    candidate("workspace-z", "workspace"),
    candidate("configured-z", "configured"),
  ]);
  assert.equal(resolved.find((entry) => entry.available)?.stableId, "configured-z");
  assert.match(
    resolved.find((entry) => entry.stableId === "workspace-z")?.unavailableReason ?? "",
    /configured/u,
  );
});

test("same-source collisions are stable and duplicate internal identities fail closed", () => {
  const resolved = resolveSkillCandidates([
    candidate("configured-z", "configured"),
    candidate("configured-a", "configured"),
    candidate("configured-0", "configured", false),
    candidate("duplicate", "configured"),
    candidate("duplicate", "global"),
  ]);
  assert.equal(resolved.find((entry) => entry.available)?.stableId, "configured-a");
  assert.equal(
    resolved.filter((entry) => entry.stableId === "duplicate" && entry.available).length,
    0,
  );
  assert.match(
    resolved.find((entry) => entry.stableId === "configured-0")?.unavailableReason ?? "",
    /Disabled/u,
  );
});

test("collision identity is Unicode-normalized and locale independent", () => {
  assert.equal(canonicalSkillIdentity("ＲＥＶＩＥＷ"), "review");
  assert.equal(canonicalSkillIdentity("e\u0301"), canonicalSkillIdentity("é"));
  assert.equal(canonicalSkillIdentity("I"), "i");
  assert.throws(() => canonicalSkillIdentity("review\u202esecret"));
  const resolved = resolveSkillCandidates([
    candidate("one", "workspace", true, "e\u0301"),
    candidate("two", "global", true, "é"),
  ]);
  assert.equal(resolved.filter((entry) => entry.available).length, 1);
});

test("non-ASCII skill names receive distinct stable model tool keys", () => {
  const first = skillToolKey(candidate("workspace:one", "workspace", true, "审查"));
  const second = skillToolKey(candidate("workspace:two", "workspace", true, "测试"));
  assert.match(first, /^skill_unnamed_[a-f0-9]{12}$/u);
  assert.notEqual(first, second);
});

test("oversized instructions fail closed", () => {
  const resolved = resolveSkillCandidates([
    {
      ...candidate("huge", "configured"),
      instructions: "x".repeat(SLASH_LIMITS.instructionBytes + 1),
    },
  ]);
  assert.equal(resolved[0]?.available, false);
  assert.match(resolved[0]?.unavailableReason ?? "", /safety limit/u);
});

test("unsafe or oversized descriptions fail closed for every registry consumer", () => {
  for (const description of [
    "review\u061c",
    "x".repeat(SLASH_LIMITS.safeDescriptionCharacters + 1),
  ]) {
    const resolved = resolveSkillCandidates([{ ...candidate("bad", "configured"), description }]);
    assert.equal(resolved[0]?.available, false);
    assert.equal(projectSkillCatalog(resolved, context())[0]?.available, false);
  }
});

test("opaque invocation IDs bind workspace, revision, source, and stable identity", () => {
  const item = candidate("configured-a", "configured");
  const first = mintSkillInvocationId(context(), item);
  assert.match(first, /^sk1_[A-Za-z0-9_-]{43}$/u);
  assert.equal(first, mintSkillInvocationId(context(), item));
  assert.notEqual(first, mintSkillInvocationId(context("workspace-2"), item));
  assert.notEqual(first, mintSkillInvocationId(context("workspace-1", "revision-2"), item));
  assert.notEqual(first, mintSkillInvocationId(context(), { ...item, source: "workspace" }));
  assert.throws(() =>
    mintSkillInvocationId({ ...context(), invocationKey: new Uint8Array(8) }, item),
  );
});

test("catalog projection is exact and cannot leak internal fields", () => {
  const resolved = resolveSkillCandidates([
    {
      ...candidate("configured-a", "configured"),
      path: "/Users/private/.aiden/skills/review/SKILL.md",
      secret: "do-not-leak",
      toolKey: "skill_review",
    } as SkillRegistryCandidate,
  ]);
  const entry = projectSkillCatalogEntry(resolved[0]!, context());
  assert.deepEqual(Object.keys(entry).sort(), [
    "available",
    "description",
    "invocationId",
    "name",
    "source",
  ]);
  assert.doesNotMatch(JSON.stringify(entry), /instructions|private|secret|toolKey|do-not-leak/u);
  assert.deepEqual(projectSkillCatalog(resolved, context()), [entry]);
});

test("duplicate rejected identities cannot invalidate the renderer catalog", () => {
  const duplicates = [
    { ...candidate("duplicate", "configured"), description: "Zulu" },
    { ...candidate("duplicate", "configured"), description: "Alpha" },
  ];
  const catalog = projectSkillCatalog(resolveSkillCandidates(duplicates), context());
  const reversed = projectSkillCatalog(
    resolveSkillCandidates([...duplicates].reverse()),
    context(),
  );
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.available, false);
  assert.match(catalog[0]?.unavailableReason ?? "", /Duplicate/u);
  assert.deepEqual(catalog, reversed);
  assert.equal(catalog[0]?.description, "Alpha");
});
