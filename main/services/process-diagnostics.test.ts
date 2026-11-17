import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { flushDevLog, initDevLog } from "./dev-log.js";
import { observeDiagnosticEvents } from "./diagnostic-journal.js";
import { installProcessDiagnostics, processDiagnosticSnapshot } from "./process-diagnostics.js";

class FakeProcess extends EventEmitter {
  readonly arch = "arm64";
  readonly pid = 123;
  readonly platform = "darwin" as const;
  readonly ppid = 45;
  readonly version = "v24.0.0";
  readonly versions = { node: "24.0.0", electron: "43.0.0", chrome: "142.0.0" } as NodeJS.ProcessVersions;
  readonly killed: Array<{ pid: number; signal: string }> = [];
  readonly warnings: Array<{ warning: string; type: string }> = [];

  cwd(): string {
    return "/workspace";
  }

  emitWarning(warning: string, type: string): void {
    this.warnings.push({ warning, type });
  }

  kill(pid: number, signal: string): boolean {
    this.killed.push({ pid, signal });
    return true;
  }

  memoryUsage(): NodeJS.MemoryUsage {
    return {
      arrayBuffers: 5,
      external: 4,
      heapTotal: 2,
      heapUsed: 3,
      rss: 1,
    };
  }

  uptime(): number {
    return 6.789;
  }
}

test("process diagnostics capture runtime identity without command-line secrets", () => {
  assert.deepEqual(processDiagnosticSnapshot(new FakeProcess() as never), {
    pid: 123,
    ppid: 45,
    platform: "darwin",
    arch: "arm64",
    node: "v24.0.0",
    electron: "43.0.0",
    chrome: "142.0.0",
    cwd: "/workspace",
    uptimeSeconds: 6.789,
    rssBytes: 1,
    heapUsedBytes: 3,
  });
});

test("process diagnostics synchronously record fatal events and preserve signal semantics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-process-diagnostics-"));
  try {
    const target = path.join(dir, "aiden-dev.log");
    const fake = new FakeProcess();
    initDevLog(target);
    installProcessDiagnostics(fake as never);
    fake.emit("uncaughtExceptionMonitor", new Error("fatal boom"), "uncaughtException");
    fake.emit("SIGTERM");
    await flushDevLog();

    const contents = `${await fs.readFile(target, "utf8")}\n${await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8")}`;
    const records = contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> });
    assert.ok(records.some((record) => record.event === "process-monitor-installed"));
    const fatal = records.find((record) => record.event === "uncaught-exception");
    assert.equal(fatal?.fields?.errorType, "Error");
    assert.match(String(fatal?.fields?.fingerprint), /^[0-9a-f]{16}$/u);
    assert.doesNotMatch(contents, /fatal boom|\/workspace/u);
    const signal = records.find((record) => record.event === "process-signal");
    assert.equal(signal?.fields?.signal, "SIGTERM");
    assert.deepEqual(fake.killed, [{ pid: 123, signal: "SIGTERM" }]);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
});

test("an uncaught exception reaches the observer with its error, and no uncaughtException listener changes crash behaviour", (t) => {
  const target = new FakeProcess();
  const seen: { event: string; origin: unknown; rawError: unknown }[] = [];
  observeDiagnosticEvents((event, detail) => {
    if (event.event === "uncaught-exception") seen.push({ event: event.event, origin: event.fields?.origin, rawError: detail?.rawError });
  });
  t.after(() => observeDiagnosticEvents(undefined));
  installProcessDiagnostics(target as never);
  const error = new Error("boom");
  const rejection = new Error("rejected");

  target.emit("uncaughtExceptionMonitor", error, "uncaughtException");
  target.emit("uncaughtExceptionMonitor", rejection, "unhandledRejection");

  assert.deepEqual(seen, [
    { event: "uncaught-exception", origin: "uncaughtException", rawError: error },
    { event: "uncaught-exception", origin: "unhandledRejection", rawError: rejection },
  ]);
  assert.equal(target.listenerCount("uncaughtException"), 0);
});

test("an unhandled rejection reaches the observer with its reason, and Node's warning is still raised", (t) => {
  const target = new FakeProcess();
  const seen: { level: unknown; errorType: unknown; rawError: unknown }[] = [];
  observeDiagnosticEvents((event, detail) => {
    if (event.event === "unhandled-rejection") seen.push({ level: event.level, errorType: event.fields?.errorType, rawError: detail?.rawError });
  });
  t.after(() => observeDiagnosticEvents(undefined));
  installProcessDiagnostics(target as never);
  const reason = new TypeError("rejected with my landlord's address");

  target.emit("unhandledRejection", reason, Promise.resolve());

  assert.deepEqual(seen, [{ level: "error", errorType: "TypeError", rawError: reason }]);
  assert.deepEqual(target.warnings, [{ warning: reason.stack, type: "UnhandledPromiseRejectionWarning" }]);
});

test("a rejection value that cannot be read does not throw from the listener", (t) => {
  const target = new FakeProcess();
  const seen: unknown[] = [];
  observeDiagnosticEvents((event) => {
    if (event.event === "unhandled-rejection") seen.push(event.fields?.errorType);
  });
  t.after(() => observeDiagnosticEvents(undefined));
  installProcessDiagnostics(target as never);
  const hostile = Object.create(null) as object;

  for (const reason of [hostile, undefined, Symbol("s"), "text"]) target.emit("unhandledRejection", reason, Promise.resolve());

  assert.equal(seen.length, 4);
  assert.equal(target.warnings.length, 3);
});
