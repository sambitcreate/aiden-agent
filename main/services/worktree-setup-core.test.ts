import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveWorktreeSetupScript,
  runWorktreeSetupScript,
  WorktreeSetupError,
} from "./worktree-setup-core.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-setup-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeScript(
  worktree: string,
  body: string,
  mode = 0o755,
): Promise<string> {
  const script = path.join(worktree, ".aiden", "worktree-setup.sh");
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, body, { mode });
  return script;
}

test("resolveWorktreeSetupScript requires an executable regular file", async (t) => {
  const worktree = await temporaryDirectory(t);
  assert.equal(await resolveWorktreeSetupScript(worktree), null);

  const script = await writeScript(worktree, "#!/bin/sh\nexit 0\n", 0o644);
  assert.equal(await resolveWorktreeSetupScript(worktree), null);
  await fs.chmod(script, 0o755);
  assert.equal(await resolveWorktreeSetupScript(worktree), script);
  await fs.rm(script);

  const outside = await temporaryDirectory(t);
  const target = path.join(outside, "setup.sh");
  await fs.writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.symlink(target, script);
  assert.equal(await resolveWorktreeSetupScript(worktree), null);
});

test("runWorktreeSetupScript runs with a sanitized environment in the worktree", async (t) => {
  const worktree = await temporaryDirectory(t);
  const source = await temporaryDirectory(t);
  process.env.AIDEN_TEST_SECRET_SENTINEL = "top-secret-value";
  t.after(() => {
    delete process.env.AIDEN_TEST_SECRET_SENTINEL;
  });
  const script = await writeScript(
    worktree,
    [
      "#!/bin/sh",
      'printf "%s" "$AIDEN_WORKTREE_PATH" > "$PWD/result.worktree"',
      'printf "%s" "$AIDEN_SOURCE_TREE_PATH" > "$PWD/result.source"',
      'printf "%s" "${AIDEN_TEST_SECRET_SENTINEL:-missing}" > "$PWD/result.secret"',
      'printf "%s" "$PWD" > "$PWD/result.cwd"',
    ].join("\n"),
  );
  await runWorktreeSetupScript(script, worktree, source);
  assert.equal(await fs.readFile(path.join(worktree, "result.worktree"), "utf8"), worktree);
  assert.equal(await fs.readFile(path.join(worktree, "result.source"), "utf8"), source);
  assert.equal(await fs.readFile(path.join(worktree, "result.secret"), "utf8"), "missing");
  assert.equal(await fs.readFile(path.join(worktree, "result.cwd"), "utf8"), worktree);
});

test("runWorktreeSetupScript rejects non-zero exits, timeouts, and flooding output", async (t) => {
  const worktree = await temporaryDirectory(t);
  const source = await temporaryDirectory(t);

  const failing = await writeScript(worktree, "#!/bin/sh\nexit 3\n");
  await assert.rejects(
    runWorktreeSetupScript(failing, worktree, source),
    (error: unknown) => error instanceof WorktreeSetupError && error.failure === "failed",
  );

  const slow = await writeScript(worktree, "#!/bin/sh\nsleep 30\n");
  await assert.rejects(
    runWorktreeSetupScript(slow, worktree, source, undefined, { timeoutMs: 250 }),
    (error: unknown) => error instanceof WorktreeSetupError && error.failure === "timeout",
  );

  const loud = await writeScript(
    worktree,
    "#!/bin/sh\nyes spam-spam-spam\n",
  );
  await assert.rejects(
    runWorktreeSetupScript(loud, worktree, source, undefined, {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    }),
    (error: unknown) => error instanceof WorktreeSetupError,
  );
});
