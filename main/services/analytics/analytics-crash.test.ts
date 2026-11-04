import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PENDING_CRASH_FILE,
  acknowledgePendingCrash,
  beginRun,
  crashSignalFor,
  deletePendingCrash,
  endRun,
  parsePendingCrash,
  readPendingCrash,
  serializePendingCrash,
  takePendingCrash,
  writePendingCrashSync,
} from "./analytics-crash.js";
import { sanitizeException } from "./analytics-sanitize.js";

const APP_ROOT = "/Applications/Aiden.app/Contents/Resources/app.asar";
const NOW = new Date("2026-10-30T12:00:00.000Z");

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "aiden-analytics-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function crash() {
  const error = new TypeError("Cannot read properties of undefined");
  error.stack = `TypeError: Cannot read properties of undefined\n    at boot (${APP_ROOT}/dist/main/index.js:5:2)`;
  return sanitizeException(error, { appRoots: [APP_ROOT] });
}

const context = { source: "main", level: "fatal", processType: "browser", origin: "uncaught_exception", uptimeSeconds: 4, appVersion: "1.40.0" } as const;

test("a fatal crash written during one run is read back once on the next", (t) => {
  const dir = tempDir(t);

  assert.equal(writePendingCrashSync(dir, crash(), context, NOW), true);
  const pending = takePendingCrash(dir);

  assert.ok(pending);
  assert.deepEqual(pending.exception, crash());
  assert.deepEqual(pending.context, context);
  assert.equal(pending.capturedAt, NOW.toISOString());
  assert.equal(takePendingCrash(dir), undefined);
  assert.equal(existsSync(join(dir, PENDING_CRASH_FILE)), false);
});

test("a crash with fractional process uptime survives the round trip", () => {
  const fractional = { ...context, uptimeSeconds: 12.345 };
  const pending = parsePendingCrash(serializePendingCrash(crash(), fractional, { now: NOW }));

  assert.ok(pending);
  assert.equal(pending.context.uptimeSeconds, 12.345);
});

test("a write that cannot reach the disk reports failure without throwing", () => {
  assert.equal(writePendingCrashSync("/nonexistent/aiden/analytics", crash(), context, NOW), false);
});

test("a tampered record is discarded instead of sent", (t) => {
  const dir = tempDir(t);
  writePendingCrashSync(dir, crash(), context, NOW);
  const record = JSON.parse(readFileSync(join(dir, PENDING_CRASH_FILE), "utf8"));

  const tampered = [
    { ...record, exception: { ...record.exception, errors: [{ ...record.exception.errors[0], frames: [{ filename: "/Users/jane/secret.js", function: "f", inApp: true }] }] } },
    { ...record, exception: { ...record.exception, errors: [{ ...record.exception.errors[0], value: "x".repeat(10_000) }] } },
    { ...record, exception: { ...record.exception, errors: [{ ...record.exception.errors[0], type: "Error at /Users/jane" }] } },
    { ...record, context: { ...record.context, origin: "/Users/jane" } },
    { ...record, version: 2 },
  ];
  for (const value of tampered) {
    writeFileSync(join(dir, PENDING_CRASH_FILE), JSON.stringify(value));
    assert.equal(takePendingCrash(dir), undefined);
    assert.equal(existsSync(join(dir, PENDING_CRASH_FILE)), false);
  }
  assert.equal(parsePendingCrash("{not json"), undefined);
});

test("turning analytics off deletes a pending crash", (t) => {
  const dir = tempDir(t);
  writePendingCrashSync(dir, crash(), context, NOW);

  deletePendingCrash(dir);

  assert.equal(takePendingCrash(dir), undefined);
});

test("serializing and parsing round-trip", () => {
  const id = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const parsed = parsePendingCrash(serializePendingCrash(crash(), context, { now: NOW, id }));
  assert.equal(parsed?.id, id);
});

test("a record stays until the server acknowledges it, and only that record is removed", (t) => {
  const dir = tempDir(t);
  const first = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const newer = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  writePendingCrashSync(dir, crash(), context, NOW, { id: first });

  assert.equal(readPendingCrash(dir)?.id, first);
  assert.equal(readPendingCrash(dir)?.id, first);

  writePendingCrashSync(dir, crash(), context, NOW, { id: newer });
  acknowledgePendingCrash(dir, first);
  assert.equal(readPendingCrash(dir)?.id, newer);

  acknowledgePendingCrash(dir, newer);
  assert.equal(existsSync(join(dir, PENDING_CRASH_FILE)), false);
});

test("a damaged record is removed on read instead of being retried forever", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, PENDING_CRASH_FILE), "{damaged");

  assert.equal(readPendingCrash(dir), undefined);
  assert.equal(existsSync(join(dir, PENDING_CRASH_FILE)), false);
});

test("a record carries the install id it was captured under", () => {
  const installId = "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b";
  assert.equal(parsePendingCrash(serializePendingCrash(crash(), context, { now: NOW, installId }))?.installId, installId);
  assert.equal(parsePendingCrash(serializePendingCrash(crash(), context, { now: NOW, installId: "/Users/jane" })), undefined);
});

test("process deaths map to crash events; clean exits, intended stops and quitting do not", () => {
  const gone = (event: string, fields: Record<string, unknown>, duringShutdown = false) =>
    crashSignalFor({ event, fields }, { duringShutdown });

  assert.deepEqual(gone("renderer-process-gone", { reason: "oom", exitCode: 9 }), {
    kind: "process_gone",
    props: { kind: "renderer", reason: "oom", exit_code: 9 },
  });
  assert.deepEqual(gone("child-process-gone", { processType: "GPU", reason: "crashed", exitCode: 5 }), {
    kind: "process_gone",
    props: { kind: "gpu", reason: "crashed", exit_code: 5 },
  });
  assert.deepEqual(gone("browser-tab-process-gone", { reason: "launch-failed", exitCode: 1 }), {
    kind: "process_gone",
    props: { kind: "browser_tab", reason: "launch_failed", exit_code: 1 },
  });
  assert.deepEqual(gone("child-process-gone", { processType: "Zygote", reason: "abnormal-exit" }), {
    kind: "process_gone",
    props: { kind: "other", reason: "abnormal_exit" },
  });
  assert.deepEqual(crashSignalFor({ event: "renderer-crash-loop", fields: { crashCount: 4 } }), {
    kind: "process_gone",
    props: { kind: "renderer_loop" },
  });

  assert.equal(gone("renderer-process-gone", { reason: "clean-exit", exitCode: 0 }), undefined);
  assert.equal(gone("child-process-gone", { processType: "Utility", reason: "clean-exit", exitCode: 0 }), undefined);
  assert.equal(gone("child-process-gone", { processType: "Utility", reason: "killed", exitCode: 15 }), undefined);
  assert.equal(gone("renderer-process-gone", { reason: "killed", exitCode: 15 }, true), undefined);
  assert.equal(gone("child-process-gone", { processType: "GPU", reason: "crashed" }, true), undefined);
});

test("soft failures in the journal are not crashes", () => {
  for (const event of ["provider-failed", "renderer-react-caught", "renderer-route-error", "renderer-react-recoverable", "mcp-failed", "store-write-failed"]) {
    assert.equal(crashSignalFor({ event }, { rawError: new Error("handled") }), undefined, event);
  }
});

test("a renderer report without raw fields has nothing to send", () => {
  assert.equal(crashSignalFor({ event: "renderer-global-error" }), undefined);
  assert.deepEqual(crashSignalFor({ event: "unhandled-rejection" }, { rawError: "x" }), { kind: "main_rejection", error: "x" });
  assert.deepEqual(crashSignalFor({ event: "bootstrap-import-failed" }, { rawError: "x" }), { kind: "fatal", error: "x", origin: "uncaught_exception" });
  assert.deepEqual(crashSignalFor({ event: "renderer-unhandled-rejection" }, { rawError: {} }), {
    kind: "renderer_error",
    error: {},
    origin: "unhandled_rejection",
  });
});

test("a run that ends without a clean quit is reported on the next launch", (t) => {
  const dir = tempDir(t);

  const first = beginRun(dir);
  assert.equal(first.previousRunUnclean, false);
  const second = beginRun(dir);
  assert.equal(second.previousRunUnclean, true);
  assert.equal(second.previousRunId, first.runId);
  endRun(dir);
  assert.equal(beginRun(dir).previousRunUnclean, false);
});
