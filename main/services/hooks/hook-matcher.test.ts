import assert from "node:assert/strict";
import test from "node:test";
import { compileHookMatcher, hookMatcherMatches, matcherMatchesValue } from "./hook-matcher.js";

test("empty and * match every tool", () => {
  for (const matcher of [undefined, "", "  ", "*"]) {
    assert.equal(hookMatcherMatches(matcher, "run_command"), true);
    assert.equal(hookMatcherMatches(matcher, "github__create_issue"), true);
  }
});

test("a plain list matches exact names in either spelling", () => {
  assert.equal(hookMatcherMatches("Bash", "run_command"), true);
  assert.equal(hookMatcherMatches("run_command", "run_command"), true);
  assert.equal(hookMatcherMatches("Write|Edit", "edit_file"), true);
  assert.equal(hookMatcherMatches("Write, Edit", "write_file"), true);
  assert.equal(hookMatcherMatches("MultiEdit", "edit_file"), true);
  assert.equal(hookMatcherMatches("Write|Edit", "read_file"), false);
  // A list is exact, not a prefix or substring match.
  assert.equal(hookMatcherMatches("Bas", "run_command"), false);
  assert.equal(hookMatcherMatches("Edit", "edit_file_extra"), false);
});

test("anything else is a regular expression anchored to the whole name", () => {
  assert.equal(hookMatcherMatches("mcp__github__.*", "github__create_issue"), true);
  assert.equal(hookMatcherMatches("mcp__github__.*", "gitlab__create_issue"), false);
  assert.equal(hookMatcherMatches("Web.*", "web_fetch"), true);
  assert.equal(hookMatcherMatches("Web.*", "run_command"), false);
  assert.equal(hookMatcherMatches("Ba.h", "run_command"), true);
  assert.equal(hookMatcherMatches("a.h", "run_command"), false, "anchored, so it can not match inside Bash");
});

test("an invalid regular expression is rejected and matches nothing", () => {
  const compiled = compileHookMatcher("(");
  assert.equal(compiled.ok, false);
  assert.equal(hookMatcherMatches("(", "run_command"), false);
  assert.equal(compileHookMatcher("x".repeat(600)).ok, false);
});

test("value matchers select SessionStart sources and similar fields", () => {
  const compiled = compileHookMatcher("startup|resume");
  assert.ok(compiled.ok);
  assert.equal(matcherMatchesValue(compiled.matcher, "startup"), true);
  assert.equal(matcherMatchesValue(compiled.matcher, "compact"), false);
  assert.equal(matcherMatchesValue(compiled.matcher, undefined), false);
});
