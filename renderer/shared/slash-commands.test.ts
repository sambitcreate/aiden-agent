import assert from "node:assert/strict";
import test from "node:test";
import {
  SLASH_COMMANDS,
  SLASH_LIMITS,
  SkillInvocationError,
  parseSkillCatalog,
  parseSkillInvocationV1,
  skillProvenance,
} from "./slash-commands.js";

const invocationId = (character = "a") => `sk1_${character.repeat(43)}`;

test("curated slash catalog freezes unique command names, aliases, and required adapters", () => {
  assert.equal(SLASH_COMMANDS.length, 19);
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
      "resume",
      "login",
      "providers",
      "assistant",
      "terminal",
      "environment",
      "review",
      "sidebar",
      "editor",
      "access",
      "mcp",
      "skills",
      "theme",
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
