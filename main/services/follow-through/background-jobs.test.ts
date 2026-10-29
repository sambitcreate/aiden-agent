// Background jobs run real shell commands here: the claims are about process
// groups, exits and logs, which a fake process would only restate.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  BackgroundJobs,
  defaultProcessStartTime,
  describeJobEnd,
  newBackgroundJobId,
  type BackgroundJobEnded,
} from "./background-jobs.js";
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
  const start = (command: string, chatId = "chat-1", extra: { description?: string } = {}) =>
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

test("stopping a chat's jobs for deletion forgets them and their logs", { skip }, async (t) => {
  const dir = await tempDir();
  const { jobs, start } = harness(dir);
  t.after(() => cleanUp(jobs, dir));
  const job = start("sleep 30");
  await jobs.stopChat("chat-1", "chat-deleted", true);
  assert.deepEqual(jobs.list("chat-1"), []);
  await assert.rejects(fs.access(path.join(dir, "logs", `${job.id}.log`)));
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
