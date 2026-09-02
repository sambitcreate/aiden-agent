import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import {
  SLASH_COMMANDS,
  SLASH_LIMITS,
  SkillInvocationError,
  parseSkillCatalog,
  parseSkillInvocationV1,
  parseSkillProvenanceV1,
  skillProvenance,
} from "./slash-commands.js";

const source = fs.readFileSync(new URL("./slash-commands.ts", import.meta.url), "utf8");

const invocationId = (character = "a") => `sk1_${character.repeat(43)}`;

test("curated slash catalog freezes unique command names, aliases, and required adapters", () => {
  assert.equal(SLASH_COMMANDS.length, 29);
  const tokens = SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]);
  assert.equal(new Set(tokens).size, tokens.length);
  assert.deepEqual(
    SLASH_COMMANDS.map((command) => command.name),
    [
      "new",
      "model",
      "settings",
      "hotkeys",
      "name",
      "copy",
      "fork",
      "clone",
      "export",
      "compact",
      "session",
      "resume",
      "login",
      "logout",
      "providers",
      "assistant",
      "terminal",
      "environment",
      "quick-view",
      "review",
      "sidebar",
      "editor",
      "worktree",
      "access",
      "mcp",
      "skills",
      "theme",
      "btw",
      "visualize",
    ],
  );
  assert.ok(SLASH_COMMANDS.every((command) => command.behavior && command.availability));
  assert.ok(
    SLASH_COMMANDS.every(
      (command) =>
        Object.isFrozen(command) &&
        Object.isFrozen(command.aliases) &&
        Object.isFrozen(command.keywords) &&
        Object.isFrozen(command.action),
    ),
  );
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "hotkeys")?.action, {
    kind: "settings",
    section: "shortcut",
  });
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "access")?.action, {
    kind: "composer-control",
    control: "access",
  });
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "providers")?.action, {
    kind: "settings",
    section: "providers",
  });
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "theme")?.action, {
    kind: "command",
    commandId: "settings.search",
  });
  for (const name of ["fork", "clone", "export", "session", "logout", "worktree"]) {
    assert.equal(SLASH_COMMANDS.find((entry) => entry.name === name)?.action.kind, "session");
  }
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "visualize")?.action, {
    kind: "composer-instruction",
    instruction: "visualize",
  });
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "btw")?.action, {
    kind: "composer-instruction",
    instruction: "btw",
  });
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "visualize")?.aliases, [
    "generative-ui",
    "generative_ui",
  ]);
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "mcp")?.aliases, ["plugins"]);
  assert.equal(SLASH_COMMANDS.find((command) => command.name === "mcp")?.action.kind, "settings");
  assert.deepEqual(
    SLASH_COMMANDS.find((command) => command.name === "environment"),
    {
      name: "environment",
      aliases: [],
      title: "Toggle Environment",
      description: "Show or hide Review, Subagents, and Files.",
      keywords: ["review", "subagents", "files", "git"],
      icon: "environment",
      action: { kind: "command", commandId: "environment.toggle" },
      behavior: "immediate",
      availability: "workspace-environment",
      argument: "none",
      draftPolicy: "preserve",
    },
  );
  assert.deepEqual(SLASH_COMMANDS.find((command) => command.name === "quick-view"), {
    name: "quick-view",
    aliases: [],
    title: "Toggle Quick View",
    description: "Show or hide the compact workspace summary.",
    keywords: ["summary", "preview", "status", "git"],
    icon: "environment",
    action: { kind: "command", commandId: "quick-view.toggle" },
    behavior: "immediate",
    availability: "workspace-environment",
    argument: "none",
    draftPolicy: "preserve",
  });

  assert.equal(SLASH_LIMITS.queryCharacters, 256);
  assert.equal(SLASH_LIMITS.catalogEntries, 500);
  assert.equal(SLASH_LIMITS.visibleResults, 100);
});

test("skill invocation parser requires an exact opaque reference", () => {
  const valid = {
    version: 1,
    invocationId: invocationId(),
    displayName: "Review",
    source: "workspace",
  };
  assert.deepEqual(parseSkillInvocationV1(valid), valid);
  for (const value of [
    null,
    { ...valid, version: 2 },
    { ...valid, path: "/private" },
    { ...valid, invocationId: ` ${invocationId()} ` },
    { ...valid, invocationId: "/Users/private/SKILL.md" },
    { ...valid, invocationId: `${invocationId()}\n` },
    { ...valid, displayName: "Review\u202esecret" },
    { ...valid, displayName: "re\u00adview" },
    { ...valid, displayName: "review\u061c" },
    { ...valid, displayName: "review\ufe0f" },
    { ...valid, source: "remote" },
  ]) {
    assert.throws(() => parseSkillInvocationV1(value), SkillInvocationError);
  }
});

test("skill invocation exact-key checks do not join attacker-controlled field names", () => {
  const hugeKey = "x".repeat(2 * 1024 * 1024);
  assert.throws(
    () =>
      parseSkillInvocationV1({
        version: 1,
        invocationId: `sk1_${"a".repeat(43)}`,
        displayName: "Review",
        source: "global",
        [hugeKey]: true,
      }),
    (error: unknown) => error instanceof Error && error.message.length < 100,
  );
  assert.doesNotMatch(source, /Object\.keys\(value\)\.sort\(\)\.join/u);
});

test("skill invocation rejects huge display hints before normalization", () => {
  assert.throws(
    () =>
      parseSkillInvocationV1({
        version: 1,
        invocationId: invocationId(),
        displayName: "x".repeat(1_000_000),
        source: "workspace",
      }),
    (error: unknown) => error instanceof SkillInvocationError && error.code === "invalid_reference",
  );
});

test("catalog parser is exact, bounded, unique, and strips no hidden internal object", () => {
  const entry = {
    invocationId: invocationId(),
    name: "Review",
    description: "Review changes",
    source: "configured",
    available: true,
  } as const;
  assert.deepEqual(parseSkillCatalog([entry]), [entry]);
  assert.throws(() => parseSkillCatalog([{ ...entry, instructions: "private" }]));
  assert.throws(() => parseSkillCatalog([{ ...entry, path: "/private" }]));
  assert.throws(() => parseSkillCatalog([entry, entry]), /Duplicate/u);
  assert.throws(() => parseSkillCatalog(Array.from({ length: 501 }, () => entry)));
  assert.throws(() => parseSkillCatalog([{ ...entry, available: false }]));
  assert.throws(() => parseSkillCatalog([{ ...entry, unavailableReason: "should not exist" }]));
});

test("persisted skill provenance contains display metadata only", () => {
  const provenance = skillProvenance("Review", "configured");
  assert.deepEqual(provenance, { version: 1, name: "Review", source: "configured" });
  const serialized = JSON.stringify(provenance);
  assert.doesNotMatch(serialized, /invocationId|instructions|path|tool|secret/u);
});

test("persisted skill provenance is exact, bounded, and fail-closed", () => {
  const provenance = { version: 1 as const, name: "Review", source: "workspace" as const };
  assert.deepEqual(parseSkillProvenanceV1(provenance), provenance);
  assert.equal(parseSkillProvenanceV1({ ...provenance, invocationId: "private" }), undefined);
  assert.equal(parseSkillProvenanceV1({ ...provenance, name: "bad\u202e" }), undefined);
  assert.equal(
    parseSkillProvenanceV1({
      ...provenance,
      name: "x".repeat(SLASH_LIMITS.safeNameCharacters + 1),
    }),
    undefined,
  );
});
