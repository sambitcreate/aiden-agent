import assert from "node:assert/strict";
import test from "node:test";
import type { SkillCatalogEntry } from "../shared/slash-commands.js";
import {
  consumeSlashToken,
  deriveSlashSession,
  dismissSlashSession,
  rankSlashResults,
  updateSlashSessionTracker,
} from "./slash-command-core.js";

const invocationId = (index: number) => `sk1_${index.toString(36).padStart(43, "0")}`;
const input = (draft: string, caret = draft.length) => ({
  draft,
  selectionStart: caret,
  selectionEnd: caret,
  composing: false,
  tracker: updateSlashSessionTracker(undefined, draft),
});

test("slash trigger requires the first non-whitespace token and a collapsed caret inside it", () => {
  assert.equal(deriveSlashSession(input("hello /model")), null);
  assert.equal(deriveSlashSession({ ...input("/model"), composing: true }), null);
  assert.equal(
    deriveSlashSession({ ...input("/model"), selectionStart: 1, selectionEnd: 2 }),
    null,
  );
  assert.equal(deriveSlashSession(input("/model later", 9)), null);
  assert.deepEqual(deriveSlashSession(input("  /model task", 5)), {
    tokenStart: 2,
    tokenEnd: 8,
    token: "/model",
    query: "model",
    argument: " task",
    sessionKey: "1:/model",
  });
  assert.ok(deriveSlashSession(input("\n\t/Users/private")));
  assert.equal(deriveSlashSession(input("ordinary prose")), null);
});

test("escape remains sticky through caret and leading-space changes but a changed or retyped token resets it", () => {
  let tracker = updateSlashSessionTracker(undefined, "/mod");
  tracker = dismissSlashSession(tracker);
  assert.equal(deriveSlashSession({ ...input("/mod"), tracker }), null);

  tracker = updateSlashSessionTracker(tracker, "  /mod");
  assert.equal(deriveSlashSession({ ...input("  /mod", 4), tracker }), null);

  tracker = updateSlashSessionTracker(tracker, "/mode");
  assert.ok(deriveSlashSession({ ...input("/mode"), tracker }));
  tracker = dismissSlashSession(tracker);
  tracker = updateSlashSessionTracker(tracker, "");
  tracker = updateSlashSessionTracker(tracker, "/mode");
  assert.ok(deriveSlashSession({ ...input("/mode"), tracker }));
});

test("token consumption preserves exact whitespace, newlines, and indentation", () => {
  const draft = "  /skills\n\n    Keep indentation";
  const session = deriveSlashSession(input(draft, 5));
  assert.ok(session);
  assert.equal(session.argument, "\n\n    Keep indentation");
  assert.equal(consumeSlashToken(draft, session), "  \n\n    Keep indentation");
  assert.equal(consumeSlashToken("changed", session), "changed");
});

test("ranking prefers exact aliases, then prefixes, words, and fuzzy matches", () => {
  const skills: SkillCatalogEntry[] = [
    {
      invocationId: invocationId(1),
      name: "Model auditor",
      description: "Review model metadata",
      source: "workspace",
      available: true,
    },
  ];
  assert.equal(rankSlashResults("models", skills).results[0]?.id, "slash-option-command-model");
  assert.equal(rankSlashResults("rev", skills).results[0]?.id, "slash-option-command-review");
  assert.equal(
    rankSlashResults("auditor", skills).results[0]?.id,
    `slash-option-skill-${invocationId(1)}`,
  );
  assert.ok(rankSlashResults("mdl", skills).results.length > 0);
  const astral: SkillCatalogEntry = {
    invocationId: invocationId(2),
    name: "😀 alpha xray",
    description: "",
    source: "workspace",
    available: true,
  };
  assert.equal(
    rankSlashResults("😀x", [astral]).results[0]?.id,
    `slash-option-skill-${invocationId(2)}`,
  );
});

test("ranking is deterministic, DOM-safe, source ordered, and capped after all 500 entries", () => {
  const skills: SkillCatalogEntry[] = Array.from({ length: 500 }, (_, index) => ({
    invocationId: invocationId(index),
    name: index === 499 ? "Exact last match" : `Skill ${String(index).padStart(3, "0")}`,
    description: "",
    source: index % 3 === 0 ? "configured" : index % 2 ? "global" : "workspace",
    available: true,
  }));
  const ranked = rankSlashResults("", [...skills].reverse());
  const reranked = rankSlashResults("", skills);
  assert.deepEqual(
    ranked.results.map((result) => result.id),
    reranked.results.map((result) => result.id),
  );
  assert.equal(ranked.results.length, 100);
  assert.equal(ranked.truncated, true);
  assert.ok(ranked.results.every((result) => /^slash-option-[A-Za-z0-9_-]+$/u.test(result.id)));
  assert.equal(
    rankSlashResults("Exact last match", skills).results[0]?.id,
    `slash-option-skill-${invocationId(499)}`,
  );
  assert.throws(() => rankSlashResults("", [...skills, skills[0]!]));
});

test("oversized Unicode queries do not open or rank", () => {
  assert.equal(deriveSlashSession(input(`/${"😀".repeat(257)}`)), null);
  assert.throws(() => rankSlashResults("😀".repeat(257), []));
});
