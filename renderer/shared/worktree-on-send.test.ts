import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  autoWorktreeBranchName,
  isValidBranchName,
  parseFirstMessageWorktreeRequest,
  uniqueBranchName,
  worktreeBranchSlug,
} from "./worktree-on-send";

test("branch names follow git check-ref-format --branch", () => {
  const cases = [
    "main", "aiden/fix-login", "feature/a/b", "v1.2", "naïve", "a-b_c",
    "", "-lead", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b",
    "/lead", "trail/", "a//b", "a/.hidden", ".hidden", "trail.", "x.lock", "a/x.lock/b",
    "a@{1}", "tab\tname", "del\u007fname",
  ];
  for (const name of cases) {
    // Git itself is the oracle.
    const git = spawnSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8" });
    assert.equal(isValidBranchName(name), git.status === 0, JSON.stringify(name));
  }
  // `--branch` expands `@` to the current branch instead of judging it; as a
  // new branch name it is refused (`git branch @`).
  assert.equal(isValidBranchName("@"), false);
});

test("the auto name is a short ascii slug of the first message", () => {
  const cases: Array<[string, string]> = [
    ["Fix the Login bug!", "aiden/fix-the-login-bug"],
    ["  Refactor   parser.ts (again) ", "aiden/refactor-parser-ts-again"],
    ["Café déjà vu", "aiden/cafe-deja-vu"],
    ["日本語だけ", "aiden/new-chat"],
    ["", "aiden/new-chat"],
    ["!!!", "aiden/new-chat"],
    // Whole words up to 40 characters; later words are dropped, not cut.
    ["Investigate why the nightly build fails on the release branch", "aiden/investigate-why-the-nightly-build-fails"],
    ["a".repeat(60), `aiden/${"a".repeat(40)}`],
  ];
  for (const [seed, expected] of cases) {
    assert.equal(autoWorktreeBranchName(seed), expected, seed);
    assert.ok(worktreeBranchSlug(seed).length <= 40);
    assert.ok(isValidBranchName(expected));
  }
});

test("unique names add -2, -3… past equal, case-folded, and folder-conflicting branches", () => {
  assert.equal(uniqueBranchName("aiden/fix", []), "aiden/fix");
  assert.equal(uniqueBranchName("aiden/fix", ["main", "aiden/fix"]), "aiden/fix-2");
  assert.equal(uniqueBranchName("aiden/fix", ["aiden/fix", "aiden/fix-2"]), "aiden/fix-3");
  assert.equal(uniqueBranchName("aiden/fix", ["Aiden/Fix"]), "aiden/fix-2");
  // `aiden/fix/sub` makes `aiden/fix` a folder; it cannot also be a branch.
  assert.equal(uniqueBranchName("aiden/fix", ["aiden/fix/sub"]), "aiden/fix-2");
  // A branch named `aiden` blocks every `aiden/…` name.
  assert.equal(uniqueBranchName("aiden/fix", ["aiden"]), undefined);
  assert.equal(uniqueBranchName("aiden/fix", ["aiden/fix", "aiden/fix-2"], 2), undefined);
});

test("the worktree request parser accepts only a complete, valid request", () => {
  const key = "0b8f3c3e-6a4f-4c1e-9d2a-5b7e1f0c2d3a";
  const valid = { sourceWorkspaceId: "ws-1", baseRef: "origin/main", fromOrigin: false, idempotencyKey: key.toUpperCase() };
  assert.deepEqual(parseFirstMessageWorktreeRequest(valid), { ...valid, idempotencyKey: key });
  assert.equal(parseFirstMessageWorktreeRequest({ ...valid, baseRef: "HEAD" }).baseRef, "HEAD");
  assert.equal(parseFirstMessageWorktreeRequest({ ...valid, branchName: "aiden/x" }).branchName, "aiden/x");
  for (const bad of [
    null, [], "x",
    { ...valid, idempotencyKey: "draft-1" },
    { ...valid, sourceWorkspaceId: "../ws" },
    { ...valid, baseRef: "" },
    { ...valid, baseRef: "-x" },
    { ...valid, fromOrigin: 1 },
    { ...valid, branchName: "" },
    { ...valid, branchName: "a..b" },
    { ...valid, extra: true },
  ]) {
    assert.throws(() => parseFirstMessageWorktreeRequest(bad), Error, JSON.stringify(bad));
  }
});
