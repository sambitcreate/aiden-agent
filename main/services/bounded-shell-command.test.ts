// runBoundedShellCommand against a real shell: a command finishes when its
// shell exits, even when something it backgrounded still holds the output.

import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedShellCommand, type BoundedShellCommandOptions } from "./bounded-shell-command.js";

const posixOnly = { skip: process.platform === "win32" ? "process groups are POSIX-only" : false };

function run(command: string, overrides: Partial<BoundedShellCommandOptions> = {}) {
  return runBoundedShellCommand({
    command,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    timeoutMs: 20_000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

test("a backgrounded child holding the output does not hold the command to its deadline", posixOnly, async () => {
  const started = Date.now();
  const result = await run("sleep 30 & echo hi");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `finished in ${elapsed}ms`);
  assert.equal(result.stdout, "hi\n");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("what the command left running on its output is stopped once the command is done, and says so", posixOnly, async () => {
  const result = await run("sleep 30 & echo $!");
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, result.stdout);
  assert.equal(result.backgroundStopped, true);
  assert.ok(await waitUntil(() => !alive(pid), 3_000), "the background sleep is gone");
});

test("a background process that redirected its output away keeps running", posixOnly, async (t) => {
  const result = await run("nohup sleep 30 >/dev/null 2>&1 & echo $!");
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, result.stdout);
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.backgroundStopped, undefined);
  // Past the drain and the SIGKILL grace period, it is still running.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(alive(pid), true, "the detached server is still running");
});

test("output written just before exit is kept in full, with the exit code", posixOnly, async () => {
  const result = await run("head -c 300000 /dev/zero | tr '\\0' a; echo done >&2; exit 3");
  assert.equal(result.stdout.length, 300_000);
  assert.equal(result.stderr, "done\n");
  assert.equal(result.exitCode, 3);
});

test("the deadline still stops a command that never exits", posixOnly, async () => {
  const started = Date.now();
  const result = await run("sleep 30", { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
});
