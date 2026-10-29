import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProcessGroupTerminator,
  decodeCappedUtf8,
  processGroupExists,
  waitForChildExit,
} from "./process-group.js";

const posix = process.platform !== "win32";

function spawnGroup(script: string): ChildProcess {
  return spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

async function firstLine(child: ChildProcess): Promise<string> {
  let text = "";
  for await (const chunk of child.stdout!) {
    text += String(chunk);
    if (text.includes("\n")) return text.split("\n")[0]!;
  }
  return text;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test("termination keeps escalating after the leader closes until a SIGTERM-ignoring descendant is gone", { skip: !posix }, async (t) => {
  // The descendant ignores SIGTERM and does not hold the leader's pipes, so the
  // leader closes on SIGTERM while the descendant survives it.
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-process-group-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ready = path.join(dir, "ready");
  const child = spawnGroup(
    `sh -c 'trap "" TERM; : > "${ready}"; while :; do sleep 0.05; done' >/dev/null 2>&1 &\necho $!\nwait`,
  );
  const descendant = Number(await firstLine(child));
  t.after(() => { try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(await eventually(() => existsSync(ready)), true);
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 300 });
  const closed = once(child, "close");
  terminator.terminate();
  await closed;
  assert.equal(alive(descendant), true, "the descendant must outlive SIGTERM for this test to mean anything");
  await terminator.finished();
  assert.equal(await eventually(() => !alive(descendant)), true, "SIGKILL must still reach the group after the leader closed");
  assert.equal(processGroupExists(child.pid), false);
});

test("termination finishes as soon as the group exits instead of waiting out the grace period", { skip: !posix }, async () => {
  const child = spawnGroup("sleep 30");
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 10_000 });
  const started = Date.now();
  terminator.terminate();
  terminator.terminate();
  await terminator.finished();
  assert.ok(Date.now() - started < 2_000);
  assert.equal(terminator.requested, true);
});

test("an unrequested termination is already finished and signals nothing", { skip: !posix }, async () => {
  const child = spawnGroup("echo done");
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 10_000 });
  await terminator.finished();
  const completion = await waitForChildExit(child, { drainMs: 5_000 });
  assert.deepEqual(completion, { code: 0, signal: null, pipesHeld: false });
  assert.equal(terminator.requested, false);
});

test("a leader whose background job keeps stdout open settles after the drain window", { skip: !posix }, async (t) => {
  const child = spawnGroup("sleep 30 &\necho $!\nexit 3");
  const background = Number(await firstLine(child));
  t.after(() => { try { process.kill(background, "SIGKILL"); } catch { /* gone */ } });
  const terminator = createProcessGroupTerminator(child, { killGraceMs: 500 });
  const started = Date.now();
  const completion = await waitForChildExit(child, { drainMs: 200, onPipesHeld: () => terminator.terminate() });
  assert.deepEqual(completion, { code: 3, signal: null, pipesHeld: true });
  assert.ok(Date.now() - started < 5_000, "settling must not wait for the 30 s background job");
  await terminator.finished();
  assert.equal(await eventually(() => !alive(background)), true, "the job holding the pipe is stopped with its group");
});

test("a spawn failure rejects the exit wait", async () => {
  const child = spawn("/nonexistent/aiden-binary", [], { stdio: ["ignore", "pipe", "pipe"] });
  await assert.rejects(waitForChildExit(child, { drainMs: 1_000 }), { code: "ENOENT" });
});

test("capped output drops a cut trailing character instead of showing U+FFFD", () => {
  const full = Buffer.from("héllo €", "utf8");
  const cut = full.subarray(0, full.length - 1);
  assert.equal(decodeCappedUtf8(cut, true), "héllo ");
  assert.equal(decodeCappedUtf8(full, true), "héllo €");
  assert.equal(decodeCappedUtf8(full, false), "héllo €");
});
