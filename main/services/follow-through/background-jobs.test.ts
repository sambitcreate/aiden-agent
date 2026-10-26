// Background jobs run real shell commands here: the claims are about process
// groups, exits and logs, which a fake process would only restate.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BackgroundJobs, defaultProcessStartTime, describeJobEnd, type BackgroundJobEnded } from "./background-jobs.js";

const skip = process.platform === "win32" ? "background jobs run on macOS and Linux" : false;

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aiden-jobs-"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

function harness(dir: string, options: Partial<ConstructorParameters<typeof BackgroundJobs>[0]> = {}) {
  const ended: BackgroundJobEnded[] = [];
  const jobs = new BackgroundJobs({
    logDir: path.join(dir, "logs"),
    onEnded: (event) => ended.push(event),
    stopGraceMs: 500,
    ...options,
  });
  const start = (command: string, chatId = "chat-1", extra: { description?: string } = {}) =>
    jobs.start({ chatId, workspaceId: "ws-1", cwd: dir, command, env: process.env, ...extra });
  return { jobs, ended, start };
}

test("a job runs in the workspace folder and the chat hears how it ended, with its output", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, ended, start } = harness(dir);
  const job = start('pwd; echo "build broke" >&2; exit 3', "chat-1", { description: "Run the\nbuild" });
  assert.equal(job.state, "running");
  assert.equal(job.description, "Run the build", "the label is one line");
  await eventually(() => ended.length === 1, "the job to end");
  const [event] = ended;
  assert.equal(event!.job.state, "failed");
  assert.equal(event!.job.exitCode, 3);
  assert.equal(describeJobEnd(event!.job), "exited with code 3");
  const real = await fs.realpath(dir);
  assert.ok(event!.tail.includes(real) || event!.tail.includes(dir), "the command ran in the workspace folder");
  assert.match(event!.tail, /build broke/u, "stderr is captured with stdout");
  const read = jobs.read("chat-1", job.id);
  assert.equal(read.job.state, "failed");
  assert.match(read.output, /build broke/u);
  // The log file holds the same output.
  const log = await fs.readFile(path.join(dir, "logs", `${job.id}.log`), "utf8");
  assert.match(log, /build broke/u);
});

test("jobs belong to their chat: another chat cannot list, read or stop them", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir);
  const job = start("sleep 30");
  t.after(async () => {
    await jobs.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(jobs.list("chat-2"), []);
  assert.throws(() => jobs.read("chat-2", job.id), /no background job/u);
  await assert.rejects(jobs.stop("chat-2", job.id, "person"), /no background job/u);
  assert.equal(jobs.get("chat-1", job.id)?.state, "running");
});

test("stopping a job ends everything it started and is not reported as ending by itself", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, ended, start } = harness(dir);
  const pidFile = path.join(dir, "grandchild.pid");
  const job = start(`sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`);
  await eventually(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).trim().length > 0, "the grandchild pid");
  const grandchild = Number((await fs.readFile(pidFile, "utf8")).trim());
  assert.ok(alive(grandchild));

  const stopped = await jobs.stop("chat-1", job.id, "person");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.endReason, "person");
  await eventually(() => !alive(grandchild), "the grandchild to end");
  assert.deepEqual(ended, [], "a stop someone asked for is not news for the chat");
});

test("a job that ignores the polite stop is forced after the grace period", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, start } = harness(dir, { stopGraceMs: 200 });
  const job = start("trap '' TERM; echo ready; while true; do sleep 0.1; done");
  await eventually(() => jobs.read("chat-1", job.id).output.includes("ready"), "the trap to be set");
  const began = Date.now();
  const stopped = await jobs.stop("chat-1", job.id, "agent");
  assert.equal(stopped.state, "stopped");
  assert.ok(Date.now() - began >= 150, "the forced stop waited for the grace period");
});

test("a start that the caller watches reports its own quick end instead of a chat notice", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, ended, start } = harness(dir);
  const job = start("echo done");
  const settled = await jobs.settle("chat-1", job.id, 5_000);
  assert.equal(settled.state, "exited");
  assert.equal(ended.length, 0, "the tool result already told the agent");

  const slow = start("sleep 0.3; exit 1");
  const stillRunning = await jobs.settle("chat-1", slow.id, 20);
  assert.equal(stillRunning.state, "running");
  await eventually(() => ended.length === 1, "the slow job to be reported");
  assert.equal(ended[0]!.job.id, slow.id, "once nobody waits, the end is news again");
});

test("a job whose output passes the size limit is stopped and the chat hears why", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { ended, start } = harness(dir, { maxLogBytes: 64 * 1024 });
  start("while true; do echo 0123456789012345678901234567890123456789; done");
  await eventually(() => ended.length === 1, "the output limit to stop the job");
  assert.equal(ended[0]!.job.state, "stopped");
  assert.equal(ended[0]!.job.endReason, "output-limit");
  assert.match(ended[0]!.tail, /output passed/u);
  assert.equal(describeJobEnd(ended[0]!.job), "stopped: its output passed the size limit");
});

test("reads keep the newest output and say when older output was left out", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, ended, start } = harness(dir);
  const job = start("for i in $(seq 1 2000); do echo line-$i; done");
  await eventually(() => ended.length === 1, "the job to end");
  const read = jobs.read("chat-1", job.id, 500);
  assert.equal(read.truncated, true);
  assert.ok(read.output.length <= 500);
  assert.match(read.output, /line-2000\n$/u);
  assert.doesNotMatch(read.output, /line-1\n/u);
});

test("a chat can run at most its share of jobs at once", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir, { maxRunningPerChat: 2, maxRunning: 3 });
  t.after(async () => {
    await jobs.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
  start("sleep 30");
  start("sleep 30");
  assert.throws(() => start("sleep 30"), /already has 2 background jobs running/u);
  start("sleep 30", "chat-2");
  assert.throws(() => start("sleep 30", "chat-3"), /Aiden already has 3 background jobs running/u);
  assert.equal(jobs.runningCount(), 3);
});

test("stopping a chat's jobs for deletion forgets them and their logs", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, start } = harness(dir);
  const job = start("sleep 30");
  await jobs.stopChat("chat-1", "chat-deleted", true);
  assert.deepEqual(jobs.list("chat-1"), []);
  await assert.rejects(fs.access(path.join(dir, "logs", `${job.id}.log`)));
});

test("after quitting, no new job starts", { skip }, async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { jobs, ended, start } = harness(dir);
  const job = start("sleep 30");
  await jobs.shutdown();
  assert.equal(jobs.get("chat-1", job.id)?.endReason, "app-quit");
  assert.deepEqual(ended, []);
  assert.throws(() => start("echo hi"), /closing/u);
});

test("the next launch stops a job a crash left running, but never a reused pid", { skip }, async (t) => {
  const dir = await tempDir();
  const logDir = path.join(dir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const leftover = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const bystander = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  leftover.unref();
  bystander.unref();
  t.after(async () => {
    for (const child of [leftover, bystander]) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const leftoverStart = await defaultProcessStartTime(leftover.pid!);
  assert.ok(leftoverStart, "ps reports a start time");
  await fs.writeFile(path.join(logDir, "job_0000aaaa.log"), "old output");
  await fs.writeFile(
    path.join(logDir, "running.json"),
    JSON.stringify({
      version: 1,
      jobs: [
        { id: "job_0000aaaa", pid: leftover.pid, processStart: leftoverStart },
        // This pid now names a process that started at another time: not one of ours.
        { id: "job_0000bbbb", pid: bystander.pid, processStart: "Thu Jan  1 00:00:00 1970" },
      ],
    }),
  );
  const jobs = new BackgroundJobs({ logDir, stopGraceMs: 500 });
  assert.equal(await jobs.reapPreviousLaunch(), 1);
  await eventually(() => !alive(leftover.pid!), "the leftover job to end");
  assert.ok(alive(bystander.pid!), "a process that only shares the pid number is left alone");
  assert.deepEqual(await fs.readdir(logDir), [], "old logs and the record are cleared");
});
