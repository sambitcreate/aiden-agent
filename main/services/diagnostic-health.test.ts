import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("deletion separates fresh health counts from an in-flight pre-delete snapshot", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-delete-"));
  const target = path.join(root, "diagnostic-health.json");
  const rename = fsPromises.rename;
  let releaseWrite!: () => void;
  const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let notifyWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => { notifyWrite = resolve; });
  let deletion: Promise<void> | undefined;
  let flushBefore: Promise<boolean> | undefined;
  let flushAfter: Promise<boolean> | undefined;
  let renames = 0;
  const renameMock = context.mock.method(fsPromises, "rename", async (...args: Parameters<typeof rename>) => {
    const [, destination] = args;
    if (destination === target) {
      renames += 1;
      if (renames === 1) {
        notifyWrite();
        await writeHeld;
      } else {
        // Deterministically publish the later snapshot after deletion finishes.
        await deletion;
      }
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    initDiagnosticHealth(target);
    const now = () => new Date("2026-09-19T12:00:00.000Z");
    const failure = createDiagnosticEvent({ level: "error", area: "renderer", event: "renderer-failed", outcome: "failed" }, "session", now);
    recordDiagnosticHealth(failure);
    recordDiagnosticHealth(failure);
    flushBefore = flushDiagnosticHealth();
    await writeStarted;

    deletion = deleteDiagnosticHealth();
    recordDiagnosticHealth(failure);
    const freshSnapshot = diagnosticHealthSnapshot();
    flushAfter = flushDiagnosticHealth();
    releaseWrite();
    await Promise.all([flushBefore, deletion, flushAfter]);

    assert.equal(JSON.parse(await fs.readFile(target, "utf8")).days[0].counts[0].failed, 1,
      "a later flush must not resurrect the two deleted failures");
    assert.equal(freshSnapshot.days[0]?.counts[0]?.failed, 1);
    assert.deepEqual(diagnosticHealthSnapshot(), freshSnapshot);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), freshSnapshot);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.equal(diagnosticHealthPersistenceFailed(), false);
  } finally {
    releaseWrite();
    await Promise.allSettled([flushBefore, deletion, flushAfter]);
    renameMock.mock.restore();
    syncBuiltinESMExports();
    await deleteDiagnosticHealth();
    initDiagnosticHealth(target, false);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("back-to-back deletions discard only health history admitted before each barrier", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-delete-twice-"));
  const target = path.join(root, "diagnostic-health.json");
  try {
    initDiagnosticHealth(target);
    const failure = createDiagnosticEvent({ level: "error", area: "app", event: "app-failed", outcome: "failed" }, "session");
    recordDiagnosticHealth(failure);
    const firstWrite = flushDiagnosticHealth();
    const firstDelete = deleteDiagnosticHealth();
    recordDiagnosticHealth(failure);
    const secondWrite = flushDiagnosticHealth();
    const secondDelete = deleteDiagnosticHealth();
    await Promise.all([firstWrite, firstDelete, secondWrite, secondDelete]);
    await flushDiagnosticHealth();
    assert.deepEqual(diagnosticHealthSnapshot(), { version: 1, days: [] });
    await assert.rejects(fs.stat(target), { code: "ENOENT" });

    recordDiagnosticHealth(failure);
    await flushDiagnosticHealth();
    assert.equal(JSON.parse(await fs.readFile(target, "utf8")).days[0].counts[0].failed, 1);
  } finally {
    await deleteDiagnosticHealth();
    initDiagnosticHealth(target, false);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded health flush includes an in-flight deletion barrier", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-delete-flush-"));
  const target = path.join(root, "diagnostic-health.json");
  const remove = fsPromises.rm;
  let releaseRemoval!: () => void;
  const removalHeld = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  let notifyRemoval!: () => void;
  const removalStarted = new Promise<void>((resolve) => { notifyRemoval = resolve; });
  const removeMock = context.mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
    if (args[0] === target) {
      notifyRemoval();
      await removalHeld;
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  let deletion: Promise<void> | undefined;
  // Production deadlines are unref'd; keep the synthetic blocked I/O alive.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    initDiagnosticHealth(target);
    deletion = deleteDiagnosticHealth();
    await removalStarted;
    assert.equal(await flushDiagnosticHealth(0), false);
    releaseRemoval();
    await deletion;
    assert.equal(await flushDiagnosticHealth(), true);
  } finally {
    releaseRemoval();
    await deletion;
    clearInterval(keepAlive);
    removeMock.mock.restore();
    syncBuiltinESMExports();
    initDiagnosticHealth(target, false);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed health deletion rejects without poisoning later persistence", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-health-delete-failed-"));
  const target = path.join(root, "diagnostic-health.json");
  const remove = fsPromises.rm;
  let failRemoval = true;
  const removeMock = context.mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
    const [candidate] = args;
    if (candidate === target && failRemoval) {
      throw Object.assign(new Error("Synthetic removal failure"), { code: "EACCES" });
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    initDiagnosticHealth(target);
    const failure = createDiagnosticEvent({ level: "error", area: "app", event: "app-failed", outcome: "failed" }, "session");
    recordDiagnosticHealth(failure);
    recordDiagnosticHealth(failure);
    await flushDiagnosticHealth();
    await assert.rejects(deleteDiagnosticHealth(), { code: "EACCES" });
    assert.equal(diagnosticHealthPersistenceFailed(), true);
    assert.deepEqual(diagnosticHealthSnapshot(), { version: 1, days: [] });

    recordDiagnosticHealth(failure);
    await flushDiagnosticHealth();
    assert.equal(JSON.parse(await fs.readFile(target, "utf8")).days[0].counts[0].failed, 1);
    failRemoval = false;
    await deleteDiagnosticHealth();
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally {
    removeMock.mock.restore();
    syncBuiltinESMExports();
    await deleteDiagnosticHealth();
    initDiagnosticHealth(target, false);
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
