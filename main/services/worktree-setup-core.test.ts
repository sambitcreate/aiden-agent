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
  // Canonical path: macOS reaches the temp directory through `/var` ->
  // `/private/var`, while resolution and the child's `$PWD` are canonical.
  return fs.realpath(directory);
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

test("runWorktreeSetupScript kills background descendants before it settles", async (t) => {
  const worktree = await temporaryDirectory(t);
  const source = await temporaryDirectory(t);

  // A descendant that outlives a successful script must not keep running (or
  // hold the output pipes open) once setup reports completion.
  const detached = await writeScript(
    worktree,
    '#!/bin/sh\n(sleep 1; echo late > "$PWD/late.success") &\nexit 0\n',
  );
  const startedAt = Date.now();
  await runWorktreeSetupScript(detached, worktree, source);
  assert.ok(Date.now() - startedAt < 900, "setup waited on its background descendant");

  // A timed-out script's whole process group dies with it, so rollback never
  // races a descendant that is still writing into the checkout.
  const slow = await writeScript(
    worktree,
    '#!/bin/sh\n(sleep 1; echo late > "$PWD/late.timeout") &\nsleep 30\n',
  );
  await assert.rejects(
    runWorktreeSetupScript(slow, worktree, source, undefined, { timeoutMs: 200 }),
    (error: unknown) => error instanceof WorktreeSetupError && error.failure === "timeout",
  );

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await assert.rejects(fs.stat(path.join(worktree, "late.success")));
  await assert.rejects(fs.stat(path.join(worktree, "late.timeout")));
});

test("runWorktreeSetupScript reports an aborted setup and stops the script", async (t) => {
  const worktree = await temporaryDirectory(t);
  const source = await temporaryDirectory(t);
  const slow = await writeScript(worktree, "#!/bin/sh\nsleep 30\n");
  const controller = new AbortController();
  const running = runWorktreeSetupScript(slow, worktree, source, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    running,
    (error: unknown) => error instanceof WorktreeSetupError && error.failure === "io",
  );
});
