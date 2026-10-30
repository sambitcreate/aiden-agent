import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PENDING_CRASH_FILE,
  beginRun,
  deletePendingCrash,
  endRun,
  parsePendingCrash,
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

test("a run that ends without a clean quit is reported on the next launch", (t) => {
  const dir = tempDir(t);

  assert.deepEqual(beginRun(dir), { previousRunUnclean: false });
  assert.deepEqual(beginRun(dir), { previousRunUnclean: true });
  endRun(dir);
  assert.deepEqual(beginRun(dir), { previousRunUnclean: false });
});
