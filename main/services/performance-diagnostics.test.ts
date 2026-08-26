import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";
import {
  diagnosticMetadata,
  parsePreviousPerformanceDiagnosticSession,
  parseRendererDiagnosticReport,
  writePerformanceDiagnosticExport,
} from "./performance-diagnostics.js";

test("main-loaded is emitted after the complete static dependency graph evaluates", async () => {
  const diagnosticsSource = await readFile(
    new URL("./performance-diagnostics.ts", import.meta.url),
    "utf8",
  );
  const mainSource = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(diagnosticsSource, /name: "startup\.main_loaded"/u);
  const milestone = mainSource.indexOf('recordDiagnosticEvent({ name: "startup.main_loaded" })');
  const lastImport = mainSource.lastIndexOf("import ", milestone);
  const firstRuntimeAction = mainSource.indexOf("app.requestSingleInstanceLock()", milestone);
  assert.ok(lastImport >= 0 && lastImport < milestone);
  assert.ok(firstRuntimeAction > milestone);
});

test("renderer diagnostics accept only fixed privacy-safe envelopes", () => {
  assert.deepEqual(parseRendererDiagnosticReport({ name: "startup.shell_painted" }), {
    name: "startup.shell_painted",
  });
  assert.deepEqual(
    parseRendererDiagnosticReport({ name: "renderer.react_commit", count: 2, durationMs: 12.5 }),
    { name: "renderer.react_commit", count: 2, durationMs: 12.5 },
  );
  assert.throws(
    () =>
      parseRendererDiagnosticReport({
        name: "renderer.long_task",
        durationMs: 12,
        prompt: "PRIVATE",
      }),
    /Invalid renderer diagnostic/u,
  );
  assert.throws(
    () => parseRendererDiagnosticReport({ name: "arbitrary", path: "/Users/alice" }),
    /Invalid renderer diagnostic name/u,
  );
});

test("diagnostic export installs exactly one parseable bounded JSON document", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-export-"));
  const destination = path.join(directory, "diagnostics.json");
  try {
    await writePerformanceDiagnosticExport(
      destination,
      diagnosticMetadata({ appVersion: "test", buildMode: "development" }),
    );
    const text = await readFile(destination, "utf8");
    const parsed = JSON.parse(text) as { schemaVersion?: number; exportId?: string };
    assert.equal(parsed.schemaVersion, 1);
    assert.match(parsed.exportId ?? "", /^[0-9a-f-]{36}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("previous-session diagnostics accept only the bounded aggregate schema", () => {
  const value = {
    schemaVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    scenario: "visible-idle",
    completedAt: "2026-08-10T00:00:00.000Z",
    sessionStartedAt: "2026-08-09T23:59:00.000Z",
    shutdownDurationMs: 12,
    shutdownTimeouts: 0,
    shutdownFailures: 0,
    shutdownStatus: "complete",
    crashLoopEvents: 0,
    rendererProcessGoneEvents: 0,
    childProcessGoneEvents: 0,
  };
  assert.deepEqual(parsePreviousPerformanceDiagnosticSession(value), value);
  assert.equal(
    parsePreviousPerformanceDiagnosticSession({ ...value, path: "/Users/alice/private" }),
    undefined,
  );
  assert.equal(
    parsePreviousPerformanceDiagnosticSession({ ...value, completedAt: "/Users/alice/private" }),
    undefined,
  );
  assert.equal(
    parsePreviousPerformanceDiagnosticSession({ ...value, shutdownDurationMs: -1 }),
    undefined,
  );
  assert.equal(
    parsePreviousPerformanceDiagnosticSession({ ...value, crashLoopEvents: 1.5 }),
    undefined,
  );
});
