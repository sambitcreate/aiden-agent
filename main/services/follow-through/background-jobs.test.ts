// Background jobs run real shell commands here: the claims are about process
// groups, exits and logs, which a fake process would only restate.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  BackgroundJobLimitError,
  BackgroundJobs,
  defaultProcessGroupMembers,
  defaultProcessStartTime,
  describeJobEnd,
  MAX_RUNNING_DESIGN_JOBS,
  newBackgroundJobId,
  type BackgroundJobEnded,
  type DesignJobView,
} from "./background-jobs.js";
import { ChatSettlement } from "./chat-settlement.js";
import { GoalCheckRunner } from "./done-when.js";
import { runBoundedShellCommand } from "../bounded-shell-command.js";

const skip = process.platform === "win32" ? "background jobs run on macOS and Linux" : false;

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aiden-jobs-"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // An ended process stays a zombie until something reaps it, which a
  // container's init may never do; it has still ended.
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
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

/** Stop what is left and wait for the job record to be saved before removing the folder. */
async function cleanUp(jobs: BackgroundJobs, dir: string): Promise<void> {
  await jobs.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
}

function harness(dir: string, options: Partial<ConstructorParameters<typeof BackgroundJobs>[0]> = {}) {
  const ended: BackgroundJobEnded[] = [];
  const jobs = new BackgroundJobs({
    logDir: path.join(dir, "logs"),
    onEnded: (event) => ended.push(event),
    stopGraceMs: 500,
    ...options,
  });
  const start = (command: string, chatId = "chat-1", extra: { description?: string; stopWhenChatSettles?: boolean } = {}) =>
    jobs.start({ chatId, workspaceId: "ws-1", cwd: dir, command, env: process.env, ...extra });
  return { jobs, ended, start };
}

test("a job runs in the workspace folder and the chat hears how it ended, with its output", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
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
  const { jobs, ended, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
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

test("a job whose shell exits while something it started holds the output ends, and takes that with it", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, start } = harness(dir, { stopGraceMs: 200 });
  t.after(async () => {
    await jobs.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const job = start("sleep 30 & echo $!; sleep 0.2; exit 0");
  await eventually(() => jobs.get("chat-1", job.id)?.state !== "running", "the job to end");
  const leftBehind = Number(jobs.read("chat-1", job.id).output.trim().split("\n")[0]);
  assert.ok(leftBehind > 1);
  assert.equal(jobs.get("chat-1", job.id)?.state, "exited");
  assert.equal(ended.length, 1, "the chat hears that it ended");
  await eventually(() => !alive(leftBehind), "what it left running to end");
});

test("a job that ignores the polite stop is forced after the grace period", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir, { stopGraceMs: 200 });
  t.after(() => cleanUp(jobs, dir));
  const job = start("trap '' TERM; echo ready; while true; do sleep 0.1; done");
  await eventually(() => jobs.read("chat-1", job.id).output.includes("ready"), "the trap to be set");
  const began = Date.now();
  const stopped = await jobs.stop("chat-1", job.id, "agent");
  assert.equal(stopped.state, "stopped");
  assert.ok(Date.now() - began >= 150, "the forced stop waited for the grace period");
});

test("a start that the caller watches reports its own quick end instead of a chat notice", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
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
  const { jobs, ended, start } = harness(dir, { maxLogBytes: 64 * 1024 });
  t.after(() => cleanUp(jobs, dir));
  start("while true; do echo 0123456789012345678901234567890123456789; done");
  await eventually(() => ended.length === 1, "the output limit to stop the job");
  assert.equal(ended[0]!.job.state, "stopped");
  assert.equal(ended[0]!.job.endReason, "output-limit");
  assert.match(ended[0]!.tail, /output passed/u);
  assert.equal(describeJobEnd(ended[0]!.job), "stopped: its output passed the size limit");
});

test("reads keep the newest output and say when older output was left out", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
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

test("finished jobs across many chats are capped, oldest first, and their logs go too", { skip }, async (t) => {
  const dir = await tempDir();
  let clock = 1_000;
  const changed: string[] = [];
  const { jobs, start } = harness(dir, { maxFinished: 3, now: () => (clock += 1), onChange: (chatId) => changed.push(chatId) });
  t.after(() => cleanUp(jobs, dir));
  let changesBeforeCap = 0;
  for (const chatId of ["chat-1", "chat-2", "chat-3", "chat-4", "chat-5"]) {
    if (chatId === "chat-4") changesBeforeCap = changed.length;
    const job = start("true", chatId);
    await eventually(() => jobs.get(chatId, job.id)?.state === "exited", `${chatId}'s job to end`);
  }
  assert.deepEqual(jobs.list("chat-1"), []);
  assert.deepEqual(jobs.list("chat-2"), []);
  assert.deepEqual(
    ["chat-3", "chat-4", "chat-5"].map((chatId) => jobs.list(chatId).length),
    [1, 1, 1],
  );
  await eventually(
    async () => (await fs.readdir(path.join(dir, "logs"))).filter((name) => name.endsWith(".log")).length === 3,
    "the forgotten jobs' logs to be removed",
  );
  assert.ok(
    changed.slice(changesBeforeCap).includes("chat-1"),
    "a chat whose finished job was dropped hears about it",
  );
});

test("over the global cap, the busiest chat gives up a finished job before a quiet chat loses its only one", { skip }, async (t) => {
  const dir = await tempDir();
  let clock = 1_000;
  const { jobs, start } = harness(dir, { maxFinished: 3, now: () => (clock += 1) });
  t.after(() => cleanUp(jobs, dir));
  const quiet = start("true", "chat-quiet");
  await eventually(() => jobs.get("chat-quiet", quiet.id)?.state === "exited", "the quiet chat's job to end");
  const busy: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const job = start("true", "chat-busy");
    busy.push(job.id);
    await eventually(() => jobs.get("chat-busy", job.id)?.state === "exited", `busy job ${index} to end`);
  }
  assert.deepEqual(jobs.list("chat-quiet").map((job) => job.id), [quiet.id]);
  assert.deepEqual(new Set(jobs.list("chat-busy").map((job) => job.id)), new Set(busy.slice(1)));
});

test("stopping a chat's jobs for deletion forgets them and their logs", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
  const job = start("sleep 30");
  await jobs.stopChat("chat-1", "chat-deleted", true);
  assert.deepEqual(jobs.list("chat-1"), []);
  await assert.rejects(fs.access(path.join(dir, "logs", `${job.id}.log`)));
});

test("once a quiet chat's window runs out, only its jobs that asked for it stop, and the chat is not told", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
  const settlement = new ChatSettlement({
    hasStoppableJobs: (chatId) => jobs.hasSettleStoppable(chatId),
    isChatBusy: () => false,
    stopSettled: (chatId) => jobs.stopSettled(chatId),
    quietMs: 150,
  });
  t.after(() => settlement.shutdown());
  const preview = start("sleep 60", "chat-1", { description: "Run the preview", stopWhenChatSettles: true });
  const kept = start("sleep 60", "chat-1", { description: "Run the server the person wants" });
  const elsewhere = start("sleep 60", "chat-2", { stopWhenChatSettles: true });
  assert.equal(preview.stopWhenChatSettles, true);
  assert.equal(kept.stopWhenChatSettles, undefined);

  settlement.runStarted("chat-1", "run-1");
  settlement.runEnded("chat-1", "run-1");
  await eventually(() => jobs.get("chat-1", preview.id)?.state === "stopped", "the opted-in job to stop");
  const stopped = jobs.get("chat-1", preview.id)!;
  assert.equal(stopped.endReason, "chat-settled");
  assert.equal(describeJobEnd(stopped), "stopped after the chat went quiet");
  assert.equal(jobs.get("chat-1", kept.id)?.state, "running", "a job that did not opt in keeps running");
  assert.equal(jobs.get("chat-2", elsewhere.id)?.state, "running", "another chat's job waits for its own chat");
  assert.equal(settlement.isArmed("chat-1"), false, "nothing is left to stop in that chat");
  assert.deepEqual(ended, [], "a stop for being quiet is not news for the chat");
});

test("quitting stops an opted-in job like any other, and the next launch has nothing to stop for being quiet", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
  const job = start("sleep 60", "chat-1", { stopWhenChatSettles: true });
  assert.equal(jobs.hasSettleStoppable("chat-1"), true);
  await jobs.shutdown();
  assert.equal(jobs.get("chat-1", job.id)?.endReason, "app-quit");
  const relaunched = new BackgroundJobs({ logDir: path.join(dir, "logs"), stopGraceMs: 500 });
  t.after(() => relaunched.shutdown());
  await relaunched.reapPreviousLaunch();
  assert.equal(relaunched.hasSettleStoppable("chat-1"), false);
  assert.deepEqual(relaunched.list("chat-1"), [], "jobs do not come back after a restart");
});

test("after quitting, no new job starts", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
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

test("after a crash, what an ended shell left in its group is stopped only when it carries that job's marker", { skip }, async (t) => {
  const dir = await tempDir();
  const logDir = path.join(dir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  // Each shell exits at once and leaves a process in its group, as a job can after Aiden crashed.
  const leaveBehind = async (marker: string, command: string) => {
    const pidFile = path.join(dir, `${marker}.pid`);
    const shell = spawn("/bin/sh", ["-c", `${command} & echo $! > ${JSON.stringify(pidFile)}`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AIDEN_BACKGROUND_JOB: marker },
    });
    await new Promise((resolve) => shell.once("exit", resolve));
    await eventually(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).trim().length > 0, "the leftover pid");
    return { group: shell.pid!, leftover: Number((await fs.readFile(pidFile, "utf8")).trim()) };
  };
  // macOS hides Apple platform binaries' environments from ps, including sh
  // and sleep. Use Node descendants so the real ownership marker is observable;
  // never put the marker in argv, where ps would find it without reading env.
  const quote = (value: string) => "'" + value.replace(/'/gu, () => "'\\''") + "'";
  const lateFile = path.join(dir, "late.pid");
  const readyFile = path.join(dir, "ready");
  const waiter = path.join(dir, "waiter.cjs");
  await fs.writeFile(waiter, "setInterval(() => {}, 1_000);\n");
  // This job's leftover starts another process as it is asked to end.
  const ending = path.join(dir, "ending.cjs");
  await fs.writeFile(ending, `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  const child = spawn(process.execPath, [${JSON.stringify(waiter)}], { stdio: "ignore" });
  child.unref();
  writeFileSync(${JSON.stringify(lateFile)}, String(child.pid));
  process.exit(0);
});
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1_000);
`);
  const ours = await leaveBehind("job_0000aaaa", `${quote(process.execPath)} ${quote(ending)}`);
  const another = await leaveBehind("job_0000bbbb", `${quote(process.execPath)} ${quote(waiter)}`);
  const latePid = async () => Number((await fs.readFile(lateFile, "utf8").catch(() => "")).trim()) || undefined;
  t.after(async () => {
    for (const pid of [ours.leftover, another.leftover, (await latePid()) ?? 0]) {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await eventually(async () => (await fs.readFile(readyFile, "utf8").catch(() => "")) === "ready", "the TERM handler to be ready");
  await fs.writeFile(
    path.join(logDir, "running.json"),
    JSON.stringify({
      version: 1,
      jobs: [
        { id: "job_0000aaaa", pid: ours.group, processStart: "Thu Jan  1 00:00:00 1970" },
        // The same group number now holds processes of some other job: not this record's.
        { id: "job_0000cccc", pid: another.group, processStart: "Thu Jan  1 00:00:00 1970" },
      ],
    }),
  );
  const jobs = new BackgroundJobs({ logDir, stopGraceMs: 500 });
  assert.equal(await jobs.reapPreviousLaunch(), 1);
  const late = await latePid();
  assert.ok(late, "the leftover started a process while it ended");
  assert.ok(!alive(ours.leftover), "what the ended shell left behind has ended");
  assert.ok(!alive(late), "and so has what it started while ending");
  assert.ok(alive(another.leftover), "processes without this job's marker are left alone");
  await assert.rejects(fs.access(path.join(logDir, "running.json")), "nothing is left to recover");
});

test("a job whose marked processes outlive cleanup stays in the record for the next launch", { skip }, async (t) => {
  const dir = await tempDir();
  const logDir = path.join(dir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const group = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  group.unref();
  // A pid above every platform's limit: signalling it never ends it, so it stands in for a process that won't stop.
  const unstoppable = 2 ** 22 + 1;
  const { jobs, start } = harness(dir, {
    processGroupMembers: async (pgid) => (pgid === group.pid ? [unstoppable] : []),
    processHasEnvironment: async (pid, entry) => pid === unstoppable && entry === "AIDEN_BACKGROUND_JOB=job_0000dddd",
  });
  t.after(async () => {
    group.kill("SIGKILL");
    await cleanUp(jobs, dir);
  });
  const leftover = { id: "job_0000dddd", pid: group.pid!, processStart: "Thu Jan  1 00:00:00 1970" };
  await fs.writeFile(path.join(logDir, "running.json"), JSON.stringify({ version: 1, jobs: [leftover] }));
  assert.equal(await jobs.reapPreviousLaunch(), 0, "a job still running is not reported as stopped");
  const record = async () => JSON.parse(await fs.readFile(path.join(logDir, "running.json"), "utf8")) as { jobs: Array<{ id: string }> };
  assert.deepEqual((await record()).jobs, [leftover]);
  const job = start("sleep 30");
  await eventually(async () => (await record()).jobs.some((entry) => entry.id === job.id), "the new job in the record");
  assert.deepEqual((await record()).jobs.map((entry) => entry.id), ["job_0000dddd", job.id], "saving this launch's jobs keeps it");
});

// ── What run_command leaves running ──────────────────────────────────────────

async function leaveServerRunning(dir: string, marker: string, script: string) {
  const file = path.join(dir, `${marker}.cjs`);
  await fs.writeFile(file, script);
  const quote = (value: string) => "'" + value.replace(/'/gu, () => "'\\''") + "'";
  const result = await runBoundedShellCommand({
    command: `${quote(process.execPath)} ${quote(file)} > /dev/null 2>&1 &`,
    cwd: dir,
    env: { ...process.env, AIDEN_BACKGROUND_JOB: marker },
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
  });
  assert.equal(result.exitCode, 0);
  return result;
}

const server = (portFile: string) => `
const { writeFileSync } = require("node:fs");
const listener = require("node:net").createServer().listen(0, "127.0.0.1", () => {
  writeFileSync(${JSON.stringify(portFile)}, String(listener.address().port));
});
`;

test("a server a command left running becomes a job of the chat that shows its port and stops with Stop", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended } = harness(dir, { listeningPorts: undefined });
  t.after(() => cleanUp(jobs, dir));
  const id = newBackgroundJobId();
  const portFile = path.join(dir, "port");
  const result = await leaveServerRunning(dir, id, server(portFile));
  assert.ok(result.leftoverProcessGroup, "the shell exited and left its server in the group");
  await eventually(async () => (await fs.readFile(portFile, "utf8").catch(() => "")).length > 0, "the server to listen");
  const port = Number(await fs.readFile(portFile, "utf8"));

  const adopted = await jobs.adopt({
    id,
    chatId: "chat-1",
    workspaceId: "ws-1",
    cwd: dir,
    command: "node server.cjs &",
    description: "Start the API",
    processGroup: result.leftoverProcessGroup!,
  });
  assert.equal(adopted?.origin, "command");
  assert.equal(jobs.runningCount("chat-1"), 1);
  assert.match(jobs.read("chat-1", id).output, /does not see its output/u);

  if (process.platform === "linux" || process.platform === "darwin") {
    await eventually(async () => {
      await jobs.scanPorts();
      return jobs.get("chat-1", id)?.ports?.includes(port) === true;
    }, "the server's port to be listed");
  }

  const stopped = await jobs.stop("chat-1", id, "person");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.ports, undefined, "a stopped job lists no address");
  assert.equal(describeJobEnd(stopped), "stopped");
  await eventually(async () => {
    try {
      process.kill(-result.leftoverProcessGroup!, 0);
      return false;
    } catch {
      return true;
    }
  }, "the server's group to end");
  assert.equal(ended.length, 0, "a stop someone asked for is not announced");
});

test("a command's leftovers are adopted only under the marker that command carried", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs } = harness(dir, { listeningPorts: null });
  const result = await leaveServerRunning(dir, "job_0000cccc", "setInterval(() => {}, 1_000);\n");
  t.after(async () => {
    try {
      process.kill(-result.leftoverProcessGroup!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await cleanUp(jobs, dir);
  });
  const adopted = await jobs.adopt({
    id: "job_0000dddd",
    chatId: "chat-1",
    workspaceId: "ws-1",
    cwd: dir,
    command: "sleep &",
    processGroup: result.leftoverProcessGroup!,
  });
  assert.equal(adopted, undefined);
  assert.deepEqual(jobs.list("chat-1"), []);
});

test("an adopted job that ends by itself reads as ended, and the chat is not told", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended } = harness(dir, { listeningPorts: null, adoptedPollMs: 50 });
  t.after(() => cleanUp(jobs, dir));
  const id = newBackgroundJobId();
  const result = await leaveServerRunning(dir, id, "setTimeout(() => {}, 1_000);\n");
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
  await eventually(() => jobs.get("chat-1", id)?.state === "exited", "the adopted job to end");
  assert.equal(describeJobEnd(jobs.get("chat-1", id)!), "ended");
  assert.equal(ended.length, 0);
});

test("an adopted job ends when its own processes do, even while an unmarked helper keeps the group", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs } = harness(dir, { listeningPorts: null, adoptedPollMs: 50 });
  const id = newBackgroundJobId();
  const pidFile = path.join(dir, "helper.pid");
  // The marked server starts an unmarked helper in its own group, then ends.
  const result = await leaveServerRunning(
    dir,
    id,
    `const { spawn } = require("node:child_process");
const env = { ...process.env };
delete env.AIDEN_BACKGROUND_JOB;
const helper = spawn("sleep", ["60"], { env, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
setTimeout(() => process.exit(0), 1_000);
`,
  );
  let helper = 0;
  t.after(async () => {
    if (helper) process.kill(helper, "SIGKILL");
    await cleanUp(jobs, dir);
  });
  await eventually(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).length > 0, "the helper to start");
  helper = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
  await eventually(() => jobs.get("chat-1", id)?.state === "exited", "the adopted job to end");
  assert.ok(alive(helper), "the unmarked helper was never the job's, and is left alone");
  assert.equal(jobs.runningCount("chat-1"), 0, "an ended job no longer takes a place");
});

test("deleting a chat whose job could not be confirmed stopped keeps owning that job", { skip }, async (t) => {
  const dir = await tempDir();
  let lookupsFail = false;
  const { jobs, start } = harness(dir, {
    listeningPorts: null,
    processGroupMembers: async (pgid) => {
      if (lookupsFail) throw new Error("ps timed out");
      return defaultProcessGroupMembers(pgid);
    },
  });
  const id = newBackgroundJobId();
  const result = await leaveServerRunning(dir, id, "setInterval(() => {}, 1_000);\n");
  const group = result.leftoverProcessGroup!;
  t.after(async () => {
    lookupsFail = false;
    await cleanUp(jobs, dir);
  });
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: group }));
  lookupsFail = true;
  await assert.rejects(jobs.stopWorkspace("ws-1", "access-changed"), /confirm.*stopped/u);
  await jobs.stopChat("chat-1", "chat-deleted", true);
  const groupRuns = () => {
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(groupRuns(), "the server still runs");
  assert.equal(jobs.runningCount("chat-1"), 1, "Aiden still owns it, so quitting will stop it");
  // The next save (another chat's job starting) still keeps it, so the next
  // launch can stop it after a crash.
  const other = start("sleep 30", "chat-2");
  const saved = () => fs.readFile(path.join(dir, "logs", "running.json"), "utf8").catch(() => "");
  await eventually(async () => (await saved()).includes(other.id), "the record to be saved again");
  assert.ok((await saved()).includes(id));
  lookupsFail = false;
  await jobs.shutdown();
  assert.equal(jobs.get("chat-1", id)?.state, "stopped", "quitting stopped it");
});

test("quitting stops what commands left running, like any job", { skip }, async () => {
  const dir = await tempDir();
  const { jobs } = harness(dir, { listeningPorts: null });
  const id = newBackgroundJobId();
  const result = await leaveServerRunning(dir, id, "setInterval(() => {}, 1_000);\n");
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
  await cleanUp(jobs, dir);
  assert.equal(jobs.get("chat-1", id)?.state, "stopped");
  assert.equal(jobs.get("chat-1", id)?.endReason, "app-quit");
});

test("Stop on a job a command left running ends only the processes carrying its marker", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs } = harness(dir, { listeningPorts: null });
  const id = newBackgroundJobId();
  const pidFile = path.join(dir, "unmarked.pid");
  // The server starts a helper in its own process group without the marker.
  const result = await leaveServerRunning(
    dir,
    id,
    `const { spawn } = require("node:child_process");
const env = { ...process.env };
delete env.AIDEN_BACKGROUND_JOB;
const helper = spawn("sleep", ["60"], { env, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
setInterval(() => {}, 1_000);
`,
  );
  let unmarked = 0;
  t.after(async () => {
    if (unmarked) process.kill(unmarked, "SIGKILL");
    await cleanUp(jobs, dir);
  });
  await eventually(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).length > 0, "the helper to start");
  unmarked = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
  const stopped = await jobs.stop("chat-1", id, "person");
  assert.equal(stopped.state, "stopped");
  assert.ok(alive(unmarked), "a process in the group without the marker is left alone");
});

test("a Stop that cannot see the processes leaves the job running, and a later Stop ends it", { skip }, async (t) => {
  const dir = await tempDir();
  let lookupsFail = false;
  const { jobs } = harness(dir, {
    listeningPorts: null,
    processGroupMembers: async (pgid) => {
      if (lookupsFail) throw new Error("ps timed out");
      return defaultProcessGroupMembers(pgid);
    },
  });
  t.after(() => cleanUp(jobs, dir));
  const id = newBackgroundJobId();
  const result = await leaveServerRunning(dir, id, "setInterval(() => {}, 1_000);\n");
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
  lookupsFail = true;
  const unconfirmed = await jobs.stop("chat-1", id, "person");
  assert.equal(unconfirmed.state, "running", "it is not shown as stopped while it may still run");
  assert.equal(jobs.runningCount("chat-1"), 1);
  lookupsFail = false;
  assert.equal((await jobs.stop("chat-1", id, "person")).state, "stopped");
});

test("after a Stop that could not see the processes, a job that then ends by itself reads as ended", { skip }, async (t) => {
  const dir = await tempDir();
  let lookupsFail = false;
  const { jobs } = harness(dir, {
    listeningPorts: null,
    processGroupMembers: async (pgid) => {
      if (lookupsFail) throw new Error("ps timed out");
      return defaultProcessGroupMembers(pgid);
    },
  });
  t.after(() => cleanUp(jobs, dir));
  const id = newBackgroundJobId();
  const quit = path.join(dir, "quit");
  const result = await leaveServerRunning(
    dir,
    id,
    `setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(quit)})) process.exit(0); }, 25);\n`,
  );
  assert.ok(await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
  lookupsFail = true;
  assert.equal((await jobs.stop("chat-1", id, "person")).state, "running");
  lookupsFail = false;
  // The Stop never reached it; it ends on its own later.
  await fs.writeFile(quit, "");
  await eventually(() => jobs.list("chat-1")[0]?.state !== "running", "the job to end by itself");
  const ended = jobs.list("chat-1")[0]!;
  assert.equal(ended.state, "exited", "not shown as stopped by the person");
  assert.equal(ended.endReason, undefined);
});

test("what a command leaves running is not taken over past the chat's job limit", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir, { listeningPorts: null, maxRunningPerChat: 1 });
  const id = newBackgroundJobId();
  const result = await leaveServerRunning(dir, id, "setInterval(() => {}, 1_000);\n");
  t.after(async () => {
    try {
      process.kill(-result.leftoverProcessGroup!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await cleanUp(jobs, dir);
  });
  start("sleep 30");
  await assert.rejects(
    jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }),
    BackgroundJobLimitError,
  );
  assert.equal(jobs.list("chat-1").length, 1, "only the job that was already running is listed");
  // Another chat still has room.
  assert.ok(await jobs.adopt({ id, chatId: "chat-2", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }));
});

test("a straggler that exits right after the command is not listed as a job", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs } = harness(dir, { listeningPorts: null, adoptSettleMs: 400 });
  t.after(() => cleanUp(jobs, dir));
  const id = newBackgroundJobId();
  const result = await leaveServerRunning(dir, id, "setTimeout(() => {}, 100);\n");
  assert.equal(
    await jobs.adopt({ id, chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "x &", processGroup: result.leftoverProcessGroup! }),
    undefined,
  );
  assert.deepEqual(jobs.list("chat-1"), []);
});

function checkHarness(dir: string, jobs: BackgroundJobs) {
  let group = 0;
  const checks = new GoalCheckRunner({
    run: async (input, signal) => {
      const id = newBackgroundJobId();
      const result = await runBoundedShellCommand({
        command: input.command, signal, cwd: dir, env: { ...process.env, AIDEN_BACKGROUND_JOB: id },
        timeoutMs: 10_000, maxOutputBytes: 1024,
        recordGroup: (pid) => {
          group = pid;
          return jobs.recordCheckGroup(id, pid, input.workspaceId, input.chatId);
        },
      });
      return { ...result, output: result.stdout };
    },
  });
  const check = (command: string) => checks.run({ command, workspaceId: "ws-1", chatId: "chat-1" }, new AbortController().signal);
  return { checks, check, get group() { return group; } };
}

test("a check whose recovery record cannot be saved waits without running or waking the agent", { skip }, async (t) => {
  const dir = await tempDir();
  const logDir = path.join(dir, "ledger");
  const jobs = new BackgroundJobs({ logDir });
  t.after(() => cleanUp(jobs, dir));
  const run = checkHarness(dir, jobs);
  // A file at the ledger directory path forces the actual persistence step to fail.
  await fs.writeFile(logDir, "original");
  const refused = await run.check("touch executed");
  // Stopped, not failed: the goal pauses with the reason instead of starting a round.
  assert.equal(refused.kind, "stopped");
  assert.doesNotMatch(refused.summary, /EEXIST|mkdir/u);
  assert.ok(run.group > 1 && !alive(run.group), "the gated shell exited");
  await assert.rejects(fs.access(path.join(dir, "executed")), { code: "ENOENT" });
  assert.equal(await fs.readFile(logDir, "utf8"), "original");
  await jobs.stopWorkspace("ws-1", "access-changed");

  await fs.unlink(logDir);
  const retried = await run.check("touch executed");
  assert.equal(retried.kind === "finished" && retried.passed, true);
  await fs.access(path.join(dir, "executed"));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(logDir, "running.json"), "utf8")).jobs, []);
});

test("a release write failure after verified exit preserves the command result and allows removal", { skip }, async (t) => {
  const dir = await tempDir();
  const errors: unknown[] = [];
  const { jobs } = harness(dir, { log: (_message, error) => errors.push(error) });
  t.after(() => cleanUp(jobs, dir));
  const run = checkHarness(dir, jobs);
  // The admitted command moves its ledger aside and leaves a regular file
  // in its place. The last committed ledger remains available for relaunch.
  const completed = await run.check("mv logs saved-ledger && touch logs");
  assert.equal(completed.kind === "finished" && completed.passed, true);
  assert.ok(errors.some((error) => (error as NodeJS.ErrnoException)?.code === "EEXIST"));
  const previous = JSON.parse(await fs.readFile(path.join(dir, "saved-ledger", "running.json"), "utf8"));
  assert.equal(previous.jobs[0]?.pid, run.group);
  assert.equal(alive(run.group), false);
  await jobs.stopWorkspace("ws-1", "access-changed");
  await fs.unlink(path.join(dir, "logs"));
  await fs.rename(path.join(dir, "saved-ledger"), path.join(dir, "logs"));
  const restored = harness(dir).jobs;
  t.after(() => restored.shutdown());
  assert.equal(await restored.reapPreviousLaunch(), 0);
  await restored.stopWorkspace("ws-1", "access-changed");
  await assert.rejects(fs.access(path.join(dir, "logs", "running.json")), { code: "ENOENT" });
});

test("a denied check-group stop retains recovery ownership and blocks only its workspace", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs } = harness(dir);
  const run = checkHarness(dir, jobs);
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number) => {
    if (run.group && pid === -run.group && (signal === "SIGTERM" || signal === "SIGKILL")) {
      throw Object.assign(new Error("signal denied"), { code: "EPERM" });
    }
    return kill(pid, signal);
  });
  t.after(async () => {
    try { if (run.group) kill(-run.group, "SIGKILL"); } catch { /* Already gone. */ }
    await cleanUp(jobs, dir);
  });
  const outcome = await run.check("sleep 60 </dev/null >/dev/null 2>&1 & echo $! > child");
  assert.equal(outcome.kind, "stopped");
  assert.match(outcome.summary, /confirm.*check stopped/u);
  const group = run.group;
  const child = Number(await fs.readFile(path.join(dir, "child"), "utf8"));
  assert.ok(alive(child));
  const ledger = async () => JSON.parse(await fs.readFile(path.join(dir, "logs", "running.json"), "utf8")).jobs;
  await jobs.stopWorkspace("ws-other", "access-changed");
  await assert.rejects(jobs.stopWorkspace("ws-1", "access-changed"), /confirm.*check stopped/u);
  assert.equal((await ledger())[0]?.pid, group);
  // Simulate a relaunch where the original leader is gone and the live
  // descendant's marker is hidden. Recovery cannot safely signal it.
  const restored = harness(dir, { processHasEnvironment: async () => false }).jobs;
  t.after(() => restored.shutdown());
  assert.equal(await restored.reapPreviousLaunch(), 0);
  await assert.rejects(restored.stopWorkspace("ws-1", "access-changed"), /confirm.*check stopped/u);
  assert.equal((await ledger())[0]?.pid, group);
  kill(-group, "SIGKILL");
  await eventually(() => !alive(child), "the surviving descendant to exit");
  await restored.stopWorkspace("ws-1", "access-changed");
  assert.deepEqual(await ledger(), []);
});

test("a shell's background job that cannot be confirmed gone is not reported stopped", { skip: process.platform === "win32" }, async () => {
  const result = await runBoundedShellCommand({
    command: "sleep 30 &\necho started",
    env: process.env,
    cwd: os.tmpdir(),
    // Falls inside cleanup: the command itself finished well before this.
    timeoutMs: 1_500,
    maxOutputBytes: 4_096,
    groupProbe: { exists: () => true, stillRuns: async () => true },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.backgroundStopped, false);
});

// ── Design jobs: a dev server design mode runs for a workspace, owned by no chat ──

const NODE = process.execPath;

function designHarness(dir: string, options: Partial<ConstructorParameters<typeof BackgroundJobs>[0]> = {}) {
  const ended: BackgroundJobEnded[] = [];
  const changed: string[] = [];
  const designChanges: DesignJobView[] = [];
  const jobs = new BackgroundJobs({
    logDir: path.join(dir, "logs"),
    onEnded: (event) => ended.push(event),
    onChange: (chatId) => changed.push(chatId),
    onDesignChange: (view) => designChanges.push(view),
    stopGraceMs: 500,
    ...options,
  });
  const startDesign = (file: string, args: string[], appRoot = ".") =>
    jobs.startDesign({
      workspaceId: "ws-1",
      appRoot,
      cwd: dir,
      argv: { file, args },
      display: "npm run dev",
      description: "Run the app",
      env: process.env,
    });
  const startNode = (script: string, appRoot = ".") => startDesign(NODE, ["-e", script], appRoot);
  return { jobs, ended, changed, designChanges, startDesign, startNode };
}

const FOREVER = "setInterval(() => {}, 1000);";

test("a design job runs its argv without a shell", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startDesign } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const job = startDesign(NODE, ["-e", "console.log(process.argv.slice(1).join('|'))", "a b", "$(echo x)", ";"]);
  assert.equal(job.owner, "design");
  assert.equal(job.appRoot, ".");
  assert.equal(job.command, "npm run dev");
  assert.equal("chatId" in job, false);
  await eventually(() => jobs.getDesign(job.id)?.state === "exited", "the job to end");
  await eventually(async () => (await jobs.readDesignLog(job.id, { after: 0, maxBytes: 4096 })).text === "a b|$(echo x)|;\n", "the output");
});

test("a design job is invisible to every chat-keyed method", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startNode } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const job = startNode(FOREVER);
  for (const chatId of ["chat-1", "", "ws-1"]) {
    assert.deepEqual(jobs.list(chatId), [], chatId);
    assert.equal(jobs.get(chatId, job.id), undefined, chatId);
    assert.throws(() => jobs.read(chatId, job.id), /no background job/u, chatId);
    await assert.rejects(jobs.settle(chatId, job.id, 0), /no background job/u, chatId);
    await assert.rejects(jobs.stop(chatId, job.id, "agent"), /no background job/u, chatId);
    assert.equal(jobs.runningCount(chatId), 0, chatId);
    assert.equal(jobs.hasSettleStoppable(chatId), false, chatId);
    await jobs.stopChat(chatId, "chat-deleted", true);
    assert.deepEqual(await jobs.stopSettled(chatId), [], chatId);
  }
  assert.equal(jobs.getDesign(job.id)?.state, "running", "a chat's stop leaves the design job running");
  assert.deepEqual(jobs.listDesign("ws-1").map((view) => view.id), [job.id]);
  assert.deepEqual(jobs.listDesign("ws-2"), []);
});

test("a design job never calls onEnded or onChange, from its end, a port scan or finished-job eviction, and calls onDesignChange", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, ended, changed, designChanges, startNode } = designHarness(dir, {
    processGroups: async () => new Map([...jobs.listAll()].filter((view) => view.pid).map((view) => [view.pid!, [view.pid!]])),
    listeningPorts: async (pids) => new Map(pids.map((pid) => [pid, [5173]])),
    portScanMs: 60_000,
  });
  t.after(() => cleanUp(jobs, dir));
  const server = startNode(FOREVER);
  await jobs.scanPorts();
  assert.deepEqual(jobs.getDesign(server.id)?.ports, [5173]);
  assert.ok(designChanges.some((view) => view.id === server.id && view.ports?.[0] === 5173), "the port change reaches onDesignChange");
  await jobs.stopDesign(server.id);
  // More finished design jobs than are kept: the oldest are forgotten.
  const quick: string[] = [];
  for (let index = 0; index < MAX_RUNNING_DESIGN_JOBS + 2; index += 1) {
    const job = startNode("process.exit(index % 2)".replace("index", String(index)));
    quick.push(job.id);
    await eventually(() => jobs.getDesign(job.id)?.state !== "running", `quick job ${index} to end`);
  }
  assert.equal(jobs.getDesign(server.id), undefined, "the oldest finished design job is forgotten");
  assert.deepEqual(ended, [], "no chat hears about a design job");
  assert.deepEqual(changed, [], "no chat list changes for a design job");
  assert.ok(designChanges.some((view) => view.id === quick[quick.length - 1] && view.state !== "running"));
});

test("design jobs don't count toward a chat's 10 or Aiden's 20, and chat jobs don't count toward the design 8", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startDesign } = designHarness(dir, { maxRunningPerChat: 2, maxRunning: 2, maxRunningDesign: 2 });
  t.after(() => cleanUp(jobs, dir));
  const start = (chatId: string) => jobs.start({ chatId, workspaceId: "ws-1", cwd: dir, command: "sleep 30", env: process.env });
  startDesign("sleep", ["30"]);
  startDesign("sleep", ["30"]);
  start("chat-1");
  start("chat-1");
  assert.throws(() => start("chat-2"), /Aiden already has 2 background jobs running/u);
  assert.throws(() => startDesign("sleep", ["30"]), BackgroundJobLimitError);
  assert.equal(jobs.runningCount(), 2);
});

test("a ninth running design job is refused with BackgroundJobLimitError", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startDesign } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  for (let index = 0; index < MAX_RUNNING_DESIGN_JOBS; index += 1) startDesign("sleep", ["30"], `apps/a${index}`);
  assert.equal(MAX_RUNNING_DESIGN_JOBS, 8);
  assert.throws(() => startDesign("sleep", ["30"]), BackgroundJobLimitError);
});

test("stopWorkspace and shutdown stop design jobs, and running.json lists them for the next launch", { skip }, async (t) => {
  const dir = await tempDir();
  const logDir = path.join(dir, "logs");
  const { jobs, startNode } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const ledger = async () =>
    (JSON.parse(await fs.readFile(path.join(logDir, "running.json"), "utf8")) as { jobs: Array<{ id: string }> }).jobs.map((entry) => entry.id);

  const first = startNode(FOREVER);
  await eventually(async () => (await ledger().catch((): string[] => [])).includes(first.id), "the record to list the design job");
  await jobs.stopWorkspace("ws-1", "access-changed");
  assert.equal(jobs.getDesign(first.id)?.state, "stopped");

  // A crash: the next launch reaps the design job the record lists.
  const crashed = startNode(FOREVER);
  await eventually(async () => {
    const raw = JSON.parse(await fs.readFile(path.join(logDir, "running.json"), "utf8").catch(() => "{}")) as {
      jobs?: Array<{ id: string; processStart?: string }>;
    };
    return raw.jobs?.some((entry) => entry.id === crashed.id && entry.processStart) === true;
  }, "the record to hold the design job's start time");
  const next = new BackgroundJobs({ logDir, stopGraceMs: 500 });
  assert.equal(await next.reapPreviousLaunch(), 1);
  await eventually(() => !alive(crashed.pid!), "the left-over design job to end");

  const last = startNode(FOREVER);
  await jobs.shutdown();
  assert.equal(jobs.getDesign(last.id)?.state, "stopped");
});

test("a design log rotates past its size and keeps running", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startNode } = designHarness(dir, { designLogRotateBytes: 4 * 1024 });
  t.after(() => cleanUp(jobs, dir));
  const job = startNode(
    "let n = 0; const timer = setInterval(() => { process.stdout.write('x'.repeat(1023) + '\\n'); if (++n === 32) clearInterval(timer); }, 2); setInterval(() => {}, 1000);",
  );
  await eventually(() => (jobs.getDesign(job.id)?.outputBytes ?? 0) >= 32 * 1024, "32 KiB of output");
  const view = jobs.getDesign(job.id)!;
  assert.equal(view.state, "running");
  assert.ok(view.oldestKeptByte > 0, "older output was let go");
  const logs = (await fs.readdir(path.join(dir, "logs"))).filter((name) => name.startsWith(job.id));
  assert.ok(logs.length <= 2, logs.join(", "));
  await eventually(async () => {
    const read = await jobs.readDesignLog(job.id, { after: 0, maxBytes: 64 * 1024 });
    return read.from === jobs.getDesign(job.id)!.oldestKeptByte && read.truncated && read.next === jobs.getDesign(job.id)!.outputBytes;
  }, "a read from the start to begin at the oldest kept byte");
});

test("readDesignLog returns the bytes after a cursor and the next cursor", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startNode } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const expected = Array.from({ length: 50 }, (_, index) => `line ${index} é\n`).join("");
  const job = startNode(`process.stdout.write(${JSON.stringify(expected)})`);
  await eventually(() => jobs.getDesign(job.id)?.state === "exited", "the job to end");
  await eventually(async () => (await jobs.readDesignLog(job.id, { after: 0, maxBytes: 1 << 20 })).next === Buffer.byteLength(expected), "the log to flush");
  const first = await jobs.readDesignLog(job.id, { after: 0, maxBytes: 100 });
  assert.equal(first.from, 0);
  assert.equal(first.next, 100);
  assert.equal(first.truncated, false);
  const second = await jobs.readDesignLog(job.id, { after: first.next, maxBytes: 1 << 20 });
  assert.equal(second.from, 100);
  assert.equal(first.text + second.text, expected, "two reads join with nothing lost");
  assert.equal(second.next, Buffer.byteLength(expected));
  const past = await jobs.readDesignLog(job.id, { after: 1 << 20, maxBytes: 100 });
  assert.equal(past.text, "");
  await assert.rejects(jobs.readDesignLog("job_00000000", { after: 0, maxBytes: 10 }));
});

test("stopDesign ends the group, children included", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startNode } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const pidFile = path.join(dir, "child.pid");
  const job = startNode(
    `const { spawn } = require("node:child_process"); const fs = require("node:fs");
     const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`,
  );
  await eventually(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).length > 0, "the child pid");
  const child = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(alive(child));
  const stopped = await jobs.stopDesign(job.id);
  assert.equal(stopped.state, "stopped");
  await eventually(() => !alive(child), "the SIGTERM-ignoring child to end", 3_000);
  // A second stop is a no-op.
  assert.equal((await jobs.stopDesign(job.id)).state, "stopped");
});

test("a design job's sockets include a listener started by a setsid grandchild, with its address, and stopDesign ends it", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startNode } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const portFile = path.join(dir, "port");
  const grandchild = `const s = require("node:net").createServer().listen(0, "127.0.0.1", () => require("node:fs").writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)));`;
  const job = startNode(
    // `detached` makes the child call setsid(): a new session and process group, as the setsid tool does.
    `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", detached: true }); setInterval(() => {}, 1000);`,
  );
  await eventually(async () => (await fs.readFile(portFile, "utf8").catch(() => "")).length > 0, "the grandchild to listen");
  const port = Number(await fs.readFile(portFile, "utf8"));
  let found: Awaited<ReturnType<BackgroundJobs["designSockets"]>> | undefined;
  await eventually(async () => {
    found = await jobs.designSockets([job.id]);
    const entry = found.get(job.id);
    return entry?.ok === true && entry.sockets.some((socket) => socket.port === port);
  }, "the grandchild's socket in the job's sockets");
  const entry = found!.get(job.id);
  assert.ok(entry?.ok);
  assert.deepEqual(
    entry.sockets.filter((socket) => socket.port === port).map((socket) => socket.address),
    ["127.0.0.1"],
  );
  assert.deepEqual(await jobs.designSockets(["job_00000000"]), new Map([["job_00000000", { ok: false, reason: "not running" }]]));
  // The setsid grandchild left the group, but it is one of the job's processes: stopping the job ends it too.
  const pid = entry.sockets.find((socket) => socket.port === port)!.pid;
  t.after(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  await jobs.stopDesign(job.id);
  await eventually(() => !alive(pid), "the setsid grandchild to end", 3_000);
});


test("designTail gives a design job's in-memory tail, and nothing for a chat job", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, startNode } = designHarness(dir);
  t.after(() => cleanUp(jobs, dir));
  const job = startNode("console.log('Local: http://127.0.0.1:5173/')");
  await eventually(() => jobs.getDesign(job.id)?.state === "exited", "the job to end");
  assert.equal(jobs.designTail(job.id), "Local: http://127.0.0.1:5173/\n");
  const chatJob = jobs.start({ chatId: "chat-1", workspaceId: "ws-1", cwd: dir, command: "echo hi", description: "Say hi", env: process.env });
  assert.equal(jobs.designTail(chatJob.id), "");
  assert.equal(jobs.designTail("job_00000000"), "");
});
