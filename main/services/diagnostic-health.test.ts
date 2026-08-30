import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createDiagnosticEvent } from "./diagnostics-contract.js";
import {
  deleteDiagnosticHealth,
  diagnosticHealthPersistenceFailed,
  diagnosticHealthSnapshot,
  flushDiagnosticHealth,
  initDiagnosticHealth,
  MAX_DIAGNOSTIC_HEALTH_DAYS,
  normalizeDiagnosticHealth,
  recordDiagnosticHealth,
} from "./diagnostic-health.js";

test("health normalization is content-free and keeps only 90 valid days", () => {
  const normalized = normalizeDiagnosticHealth({
    version: 1,
    privatePrompt: "must disappear",
    days: Array.from({ length: 100 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      counts: [
        { area: "renderer", failed: 1, privateMessage: "must disappear" },
        { area: "not-an-area", failed: 100 },
      ],
    })),
  });
  assert.equal(normalized.days.length, MAX_DIAGNOSTIC_HEALTH_DAYS);
  assert.doesNotMatch(JSON.stringify(normalized), /privatePrompt|privateMessage|must disappear|not-an-area/u);
});

test("health records closed outcomes and persists owner-only data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-"));
  const target = path.join(root, "diagnostic-health.json");
  try {
    initDiagnosticHealth(target);
    const now = () => new Date("2026-08-27T12:00:00.000Z");
    recordDiagnosticHealth(createDiagnosticEvent({ level: "info", area: "app", event: "electron-ready", outcome: "started" }, "session", now));
    recordDiagnosticHealth(createDiagnosticEvent({ level: "error", area: "renderer", event: "renderer-failed", outcome: "failed" }, "session", now));
    await flushDiagnosticHealth();
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(diagnosticHealthSnapshot().days[0]?.counts, [
      { area: "app", started: 1, completed: 0, degraded: 0, failed: 0, cancelled: 0, timedOut: 0, success2xx: 0, clientError4xx: 0, serverError5xx: 0, slow: 0 },
      { area: "renderer", started: 0, completed: 0, degraded: 0, failed: 1, cancelled: 0, timedOut: 0, success2xx: 0, clientError4xx: 0, serverError5xx: 0, slow: 0 },
    ]);
    await deleteDiagnosticHealth();
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("corrupt health state fails closed to an empty database", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-corrupt-"));
  try {
    const target = path.join(root, "diagnostic-health.json");
    await fs.writeFile(target, "not-json", "utf8");
    initDiagnosticHealth(target);
    assert.deepEqual(diagnosticHealthSnapshot(), { version: 1, days: [] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("health persistence rejects symlinked roots and predictable temporary symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-links-"));
  const outside = path.join(root, "outside");
  const linked = path.join(root, "logs");
  try {
    await fs.mkdir(outside);
    await fs.symlink(outside, linked);
    initDiagnosticHealth(path.join(linked, "diagnostic-health.json"));
    assert.equal(diagnosticHealthPersistenceFailed(), true);
    await assert.rejects(fs.stat(path.join(outside, "diagnostic-health.json")), { code: "ENOENT" });

    const safeRoot = path.join(root, "safe");
    await fs.mkdir(safeRoot);
    const target = path.join(safeRoot, "diagnostic-health.json");
    const victim = path.join(root, "victim");
    await fs.writeFile(victim, "keep", { mode: 0o644 });
    await fs.symlink(victim, `${target}.tmp`);
    initDiagnosticHealth(target);
    recordDiagnosticHealth(createDiagnosticEvent({ level: "error", area: "app", event: "app-failed", outcome: "failed" }, "session"));
    await flushDiagnosticHealth();
    assert.equal(await fs.readFile(victim, "utf8"), "keep");
    assert.equal((await fs.stat(victim)).mode & 0o777, 0o644);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
