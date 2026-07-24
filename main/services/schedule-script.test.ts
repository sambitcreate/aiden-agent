import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveScheduledScript, runScheduledScript } from "./schedule-script.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-schedule-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await Promise.all([
    fs.mkdir(path.join(workspace, ".aiden", "scripts"), { recursive: true }),
    fs.mkdir(path.join(home, ".aiden", "scripts"), { recursive: true }),
  ]);
  return {
    root,
    workspace,
    home,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("workspace scripts win over global scripts and traversal is rejected", async () => {
  const files = await fixture();
  try {
    const workspaceScript = path.join(files.workspace, ".aiden", "scripts", "report.sh");
    const globalScript = path.join(files.home, ".aiden", "scripts", "report.sh");
    await Promise.all([
      fs.writeFile(workspaceScript, "#!/bin/bash\nprintf workspace", "utf-8"),
      fs.writeFile(globalScript, "#!/bin/bash\nprintf global", "utf-8"),
    ]);
    const resolved = await resolveScheduledScript({
        script: "report.sh",
        workspaceRoot: files.workspace,
        homeDirectory: files.home,
      });
    assert.equal(resolved, await fs.realpath(workspaceScript));
    await assert.rejects(
      resolveScheduledScript({
        script: "../report.sh",
        workspaceRoot: files.workspace,
        homeDirectory: files.home,
      }),
      /single file name/iu,
    );
  } finally {
    await files.cleanup();
  }
});

test("script resolution rejects a symlink that escapes an allowed root", async () => {
  const files = await fixture();
  try {
    const outside = path.join(files.root, "outside.sh");
    const link = path.join(files.workspace, ".aiden", "scripts", "linked.sh");
    await fs.writeFile(outside, "#!/bin/bash\nprintf outside", "utf-8");
    await fs.symlink(outside, link);
    await assert.rejects(
      resolveScheduledScript({
        script: "linked.sh",
        workspaceRoot: files.workspace,
        homeDirectory: files.home,
      }),
      /resolves outside/iu,
    );
  } finally {
    await files.cleanup();
  }
});

test("script runner maps stdout, nonzero exit, timeout, and output bounds", async () => {
  const files = await fixture();
  try {
    const ok = path.join(files.root, "ok.sh");
    const fail = path.join(files.root, "fail.sh");
    const slow = path.join(files.root, "slow.sh");
    const noisy = path.join(files.root, "noisy.sh");
    await Promise.all([
      fs.writeFile(ok, "#!/bin/bash\nprintf 'hello'", { mode: 0o755 }),
      fs.writeFile(fail, "#!/bin/bash\nprintf 'bad' >&2\nexit 7", { mode: 0o755 }),
      fs.writeFile(slow, "#!/bin/bash\nsleep 2", { mode: 0o755 }),
      fs.writeFile(noisy, "#!/bin/bash\nprintf '1234567890'", { mode: 0o755 }),
    ]);
    const success = await runScheduledScript(ok, { cwd: files.root });
    assert.equal(success.stdout, "hello");
    assert.equal(success.exitCode, 0);
    const failure = await runScheduledScript(fail, { cwd: files.root });
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.stderr, "bad");
    const timeout = await runScheduledScript(slow, { cwd: files.root, timeoutMs: 25 });
    assert.equal(timeout.timedOut, true);
    const bounded = await runScheduledScript(noisy, { cwd: files.root, outputLimit: 5 });
    assert.equal(bounded.outputLimitExceeded, true);
    assert.equal(bounded.stdout, "12345");
  } finally {
    await files.cleanup();
  }
});
