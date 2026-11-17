import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeStuckShutdown, lifecycleRecords, procThreadLine, sampleMainThread } from "./e2e-shutdown-diagnostics.mjs";

const record = (scope, message, at = "2026-11-17T14:28:37.838Z", level = "info") =>
  JSON.stringify({ version: 1, at, level, area: "diagnostics", event: "legacy-log", fields: { legacyScope: scope, message } });

test("only the quit and shutdown records of a dev log are kept, oldest first", () => {
  const log = [
    record("electron-lifecycle", "Application before-quit {\"lifecycleCheckInFlight\":true}", "t1"),
    record("chat", "Generation started", "t2"),
    "not json",
    record("main", "Storage cleanup did not finish within the shutdown budget.", "t3", "warn"),
    JSON.stringify({ version: 1, at: "t4", level: "info", area: "diagnostics", event: "session-started", fields: {} }),
  ].join("\n");
  assert.deepEqual(lifecycleRecords(log), [
    "  t1 info electron-lifecycle Application before-quit {\"lifecycleCheckInFlight\":true}",
    "  t3 warn main Storage cleanup did not finish within the shutdown budget.",
  ]);
});

test("a long dev log keeps its latest quit records and cuts each message", () => {
  const log = Array.from({ length: 50 }, (_, index) => record("main", `${index} ${"x".repeat(400)}`, `t${index}`)).join("\n");
  const lines = lifecycleRecords(log, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("  t47 info main 47 "));
  assert.ok(lines.every((line) => line.length < 300));
});

test("the main thread's call graph is taken from sample output and the next thread is left out", () => {
  const output = [
    "Analysis of sampling Electron (pid 8759) every 1 millisecond",
    "Call graph:",
    "    812 Thread_1234   DispatchQueue_1: com.apple.main-thread  (serial)",
    "    + 812 start  (in dyld) + 1942",
    "    +   812 uv_run  (in Electron Framework) + 300",
    "    812 Thread_1240",
    "    + 812 thread_start",
    "",
    "Total number in stack",
  ].join("\n");
  assert.deepEqual(sampleMainThread(output), [
    "    812 Thread_1234   DispatchQueue_1: com.apple.main-thread  (serial)",
    "    + 812 start  (in dyld) + 1942",
    "    +   812 uv_run  (in Electron Framework) + 300",
  ]);
  assert.deepEqual(sampleMainThread("no graph here"), []);
});

test("a /proc thread reads as its name, state and wait channel, even when the name holds a parenthesis", () => {
  assert.equal(procThreadLine("8759", "8759 (electron) S 1 8759 8759 0 -1", "do_epoll_wait"), "  8759 electron S do_epoll_wait");
  assert.equal(procThreadLine("8761", "8761 (Chrome_(IO)) R 1 8759", "0"), "  8761 Chrome_(IO) R");
  assert.equal(procThreadLine("8762", "garbage", ""), "  8762 ?");
});

test("a live process is described with its quit records and its threads", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-shutdown-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const devLogPath = path.join(dir, "aiden-dev.log");
  await writeFile(devLogPath, `${record("electron-lifecycle", "Application quit was not started {\"reason\":\"lifecycle-check-in-flight\"}")}\n`);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const report = await describeStuckShutdown({ pid: child.pid, devLogPath });
  assert.match(report, /Quit and shutdown records:\n.*lifecycle-check-in-flight/u);
  if (process.platform === "darwin") assert.match(report, /Main thread \(sample\):\n {4}\d+ Thread_/u);
  if (process.platform === "linux") assert.match(report, new RegExp(`Threads \\(tid name state wchan\\):\\n  ${child.pid} \\S+ [A-Z]`, "u"));
});

test("a process that is already gone and a missing dev log still produce a report", async () => {
  const report = await describeStuckShutdown({ pid: 2 ** 22 + 7, devLogPath: path.join(os.tmpdir(), "missing-aiden-dev.log"), platform: "linux" });
  assert.equal(report, "Quit and shutdown records:\n  (none)\nThreads (tid name state wchan):\n  (unavailable)");
});
