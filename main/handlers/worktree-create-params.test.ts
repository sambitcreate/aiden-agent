import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WORKTREE_BRANCH_CHARS,
  parseWorktreeCreateParams,
} from "./worktree-create-params.js";

test("worktree creation selectors are bounded and branch-safe before Git", () => {
  assert.deepEqual(parseWorktreeCreateParams("workspace", "feature/phase-four"), {
    workspaceId: "workspace",
    branch: "feature/phase-four",
  });
  assert.equal(
    parseWorktreeCreateParams("workspace", "界".repeat(MAX_WORKTREE_BRANCH_CHARS)).branch.length,
    MAX_WORKTREE_BRANCH_CHARS,
  );
  for (const invalid of [
    "",
    " x",
    "feature bad",
    "../escape",
    "feature//bad",
    "-option",
    "x".repeat(MAX_WORKTREE_BRANCH_CHARS + 1),
    "😀".repeat(MAX_WORKTREE_BRANCH_CHARS),
    "x".repeat(2 * 1024 * 1024),
  ]) {
    assert.throws(() => parseWorktreeCreateParams("workspace", invalid));
  }
  assert.throws(() => parseWorktreeCreateParams("w".repeat(2 * 1024 * 1024), "feature/x"));
});
