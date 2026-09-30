import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generationGitContext } from "./generation-git-context.js";
import { GitService, GitServiceError } from "./git.js";

const signal = () => new AbortController().signal;

test("optional Git failure does not abort prompt preparation", async () => {
  for (const error of [new Error("spawn git ENOENT"), new GitServiceError("command_failed", "xcode-select: note: No developer tools were found, requesting install."), new GitServiceError("timeout", "Git timed out")]) {
    assert.deepEqual(await generationGitContext("/workspace", signal(), async () => { throw error; }), { isRepo: false });
  }
});

test("no authorized folder skips lookup; available metadata is preserved with cancellation signal", async () => {
  assert.deepEqual(await generationGitContext(undefined, signal(), async () => { assert.fail("must not probe"); }), { isRepo: false });
  const activeSignal = signal();
  const info = { isRepo: true, branch: "main", uncommitted: 2 };
  assert.equal(await generationGitContext("/workspace", activeSignal, async (folder, passedSignal) => {
    assert.equal(folder, "/workspace");
    assert.equal(passedSignal, activeSignal);
    return info;
  }), info);
});

test("cancellation is never swallowed before, during, or after lookup", async () => {
  const controller = new AbortController();
  await assert.rejects(generationGitContext("/workspace", controller.signal, async () => {
    controller.abort();
    return { isRepo: false };
  }), { name: "AbortError" });
  await assert.rejects(generationGitContext(undefined, controller.signal), { name: "AbortError" });
  await assert.rejects(generationGitContext("/workspace", signal(), async () => {
    throw new GitServiceError("aborted", "cancelled");
  }), { code: "aborted" });
});

test("real subprocess failure is optional only for generation, not explicit Git operations", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fixture");
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-no-xcode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "git");
  await writeFile(binary, '#!/bin/sh\necho "xcode-select: note: No developer tools were found, requesting install." >&2\nexit 1\n', { mode: 0o755 });
  const git = new GitService({ gitBinary: binary });
  await assert.rejects(git.info(root), /No developer tools were found/);
  assert.deepEqual(await generationGitContext(root, signal(), (folder, abort) => git.info(folder, abort)), { isRepo: false });
  await assert.rejects(git.branches(root), /No developer tools were found/);
});
