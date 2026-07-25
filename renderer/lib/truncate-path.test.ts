import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PATH_TRUNCATE_LENGTH, truncatePathMiddle } from "./truncate-path.js";

test("returns short paths unchanged", () => {
  assert.equal(truncatePathMiddle("/Users/me/project"), "/Users/me/project");
  assert.equal(truncatePathMiddle("relative/path"), "relative/path");
});

test("keeps the path root and leaf with a middle ellipsis", () => {
  const path = "/Users/sambitbiswas/projects/aiden-macos/.worktrees/origin-main";
  const truncated = truncatePathMiddle(path, DEFAULT_PATH_TRUNCATE_LENGTH);

  assert.ok(truncated.length <= DEFAULT_PATH_TRUNCATE_LENGTH);
  assert.match(truncated, /^\/Users\//u);
  assert.match(truncated, /origin-main$/u);
  assert.ok(truncated.includes("…"));
  assert.notEqual(truncated, path);
});

test("shows beginning and end instead of end-only truncation", () => {
  const path = "/Users/sambitbiswas/projects/aiden-macos";
  const truncated = truncatePathMiddle(path, 28);

  assert.equal(truncated, "/Users/…/aiden-macos");
  assert.equal(truncated.endsWith("…"), false);
  assert.match(truncated, /^\/Users\//u);
  assert.match(truncated, /aiden-macos$/u);
  assert.ok(truncated.includes("…"));
});

test("falls back to character middle truncation for separator-less strings", () => {
  assert.equal(truncatePathMiddle("abcdefghijklmnopqrstuvwxyz", 11), "abcde…vwxyz");
});

test("handles tiny budgets and empty input", () => {
  assert.equal(truncatePathMiddle("/Users/long/path", 0), "");
  assert.equal(truncatePathMiddle("/Users/long/path", 1), "…");
  assert.equal(truncatePathMiddle("   ", 10), "");
});

test("supports Windows-style separators", () => {
  const path = "C:\\Users\\sambitbiswas\\projects\\aiden-macos\\.worktrees\\origin-main";
  const truncated = truncatePathMiddle(path, 40);
  assert.ok(truncated.length <= 40);
  assert.match(truncated, /^C:\\Users\\/u);
  assert.match(truncated, /origin-main$/u);
  assert.ok(truncated.includes("…"));
});
