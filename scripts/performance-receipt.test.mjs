import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  emptyPerformanceArtifacts,
  emptyPerformanceMeasurements,
  PERFORMANCE_ARTIFACT_KEYS,
  PERFORMANCE_MEASUREMENT_KEYS,
} from "./performance-fixture.mjs";
import {
  verifyPerformanceDiagnosticExport,
  verifyPerformanceShutdownSummary,
  verifyPerformanceReceipt,
  verifyPerformanceReceiptArtifacts,
  readBoundedJsonFile,
} from "./performance-receipt.mjs";

function receipt() {
  return {
    schemaVersion: 1,
    runId: "00000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-10T00:00:00.000Z",
    scenario: "visible-idle",
    commit: "a".repeat(40),
    dirtyStateHash: "b".repeat(64),
    buildMode: "packaged",
    appVersion: "0.28.0",
    electronVersion: "43.1.1",
    nodeVersion: "24.18.0",
    platform: "darwin",
    hardware: "Apple M1 Max",
    logicalCpuCount: 10,
    memoryBytes: 64 * 1024 * 1024 * 1024,
    macOSVersion: "26.4",
    architecture: "arm64",
    powerSource: "ac",
    profilingBuild: true,
    packageIdentity: null,
    voiceModelIdentity: null,
    fixture: {
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      scenario: "visible-idle",
      generatedAt: "2026-08-10T00:00:00.000Z",
      chats: [100, 500],
      streams: [2_000, 10_000],
      workspaceFiles: 4_000,
      attachmentFiles: 20,
      sparseAttachmentBytes: 10 * 1024 * 1024 * 1024,
      missedSchedules: 20,
      terminals: 4,
      fixtureIdentity: "c".repeat(64),
    },
    measurements: emptyPerformanceMeasurements(),
    artifacts: emptyPerformanceArtifacts(),
  };
}

function diagnostics() {
  return {
    schemaVersion: 1,
    exportId: "00000000-0000-4000-8000-000000000002",
    metadata: {
      runId: "00000000-0000-4000-8000-000000000001",
      commit: "a".repeat(40),
      dirtyStateHash: "b".repeat(64),
      buildMode: "packaged",
      profilingBuild: true,
      appVersion: "0.28.0",
      electronVersion: "43.1.1",
      nodeVersion: "24.18.0",
      platform: "darwin",
      architecture: "arm64",
      macOSVersion: "26.4",
      hardware: "Apple M1 Max",
      logicalCpuCount: 10,
      memoryBytes: 64 * 1024 * 1024 * 1024,
      powerSource: "ac",
      scenario: "visible-idle",
    },
    diagnostics: {
      schemaVersion: 1,
      generatedAt: "2026-08-10T00:05:00.000Z",
      sessionStartedAt: "2026-08-10T00:00:00.000Z",
      droppedEvents: 0,
      droppedSeries: 0,
      events: [{ sequence: 1, monotonicMs: 1, name: "startup.main_loaded" }],
      counters: {
        "ipc:chats:list": { count: 1, errors: 0, bytesIn: 8, bytesOut: 32, durationMs: 1 },
        "benchmark:power-source-transition": {
          count: 0,
          errors: 0,
          bytesIn: 0,
          bytesOut: 0,
          durationMs: 0,
        },
      },
      gauges: { "live:child": { current: 0, peak: 1 } },
    },
  };
}

function traceZip(label) {
  const name = Buffer.from(`${label}.trace/metadata.json`, "utf8");
  const content = Buffer.from(`{"trace":"${label}"}`, "utf8");
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30 + name.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  content.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test("receipts use one exact measurement schema and can require laboratory completion", () => {
  const input = receipt();
  assert.equal(verifyPerformanceReceipt(input), true);
  assert.throws(() => verifyPerformanceReceipt(input, { requireComplete: true }), /not bound/u);
  input.packageIdentity = {
    schemaVersion: 1,
    commit: input.commit,
    dirtyStateHash: input.dirtyStateHash,
    buildMode: input.buildMode,
    profilingBuild: input.profilingBuild,
    runtimeNodeVersion: input.nodeVersion,
    runtimeElectronVersion: input.electronVersion,
    runtimePlatform: input.platform,
    runtimeArchitecture: input.architecture,
    appAsarSha256: "a".repeat(64),
    executableSha256: "b".repeat(64),
    codeDirectoryHash: "c".repeat(40),
  };
  assert.throws(
    () => verifyPerformanceReceipt(input, { requireComplete: true }),
    /missing or invalid/u,
  );
  input.measurements = Object.fromEntries(PERFORMANCE_MEASUREMENT_KEYS.map((key) => [key, 1]));
  input.artifacts = Object.fromEntries(
    PERFORMANCE_ARTIFACT_KEYS.map((key) => [
      key,
      {
        path: `${key}.${new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key) ? "zip" : "json"}`,
        sha256: "d".repeat(64),
        bytes: 1,
      },
    ]),
  );
  assert.equal(verifyPerformanceReceipt(input, { requireComplete: true }), true);
  input.measurements.privateField = 1;
  assert.throws(() => verifyPerformanceReceipt(input), /measurement schema/u);
  delete input.measurements.privateField;
  input.artifacts.timeProfiler.path = "/Users/alice/private.trace";
  assert.throws(() => verifyPerformanceReceipt(input), /artifact timeProfiler/u);
});

test("shutdown evidence is bound to the exact measured diagnostic session", () => {
  const input = receipt();
  input.measurements.shutdownMs = 12;
  input.measurements.shutdownTimeouts = 0;
  const report = diagnostics();
  const summary = {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    completedAt: "2026-08-10T00:06:00.000Z",
    sessionStartedAt: report.diagnostics.sessionStartedAt,
    shutdownDurationMs: 12,
    shutdownTimeouts: 0,
    shutdownFailures: 0,
    shutdownStatus: "complete",
    crashLoopEvents: 0,
    rendererProcessGoneEvents: 0,
    childProcessGoneEvents: 0,
  };
  assert.equal(verifyPerformanceShutdownSummary(summary, input, report), true);
  assert.throws(
    () =>
      verifyPerformanceShutdownSummary(
        { ...summary, sessionStartedAt: "2026-08-09T23:59:00.000Z" },
        input,
        report,
      ),
    /measured session/u,
  );
});

test("diagnostic exports must match their receipt and retain every bounded sample", () => {
  const input = receipt();
  const report = diagnostics();
  assert.equal(verifyPerformanceDiagnosticExport(report, input, 4_096), true);
  report.diagnostics.droppedEvents = 1;
  assert.throws(() => verifyPerformanceDiagnosticExport(report, input, 4_096), /dropped samples/u);
  report.diagnostics.droppedEvents = 0;
  report.metadata.scenario = "warm-launch";
  assert.throws(() => verifyPerformanceDiagnosticExport(report, input, 4_096), /do not match/u);
  report.metadata.scenario = "visible-idle";
  report.diagnostics.events[0].prompt = "PRIVATE";
  assert.throws(() => verifyPerformanceDiagnosticExport(report, input, 4_096), /invalid event/u);
  report.diagnostics.events[0] = { sequence: 1, monotonicMs: 1, name: "startup.main_loaded" };
  report.exportId = "/Users/alice/private";
  assert.throws(
    () => verifyPerformanceDiagnosticExport(report, input, 4_096),
    /Invalid performance diagnostics export/u,
  );
});

test("diagnostic verification rejects path-bearing or oversized aggregate schemas", () => {
  const input = receipt();
  const report = diagnostics();
  report.diagnostics.counters["/Users/alice/private"] = {
    count: 1,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 0,
  };
  assert.throws(() => verifyPerformanceDiagnosticExport(report, input, 4_096), /invalid series/u);
  assert.throws(
    () => verifyPerformanceDiagnosticExport(diagnostics(), input, 3 * 1024 * 1024),
    /export budget/u,
  );
});

test("strict diagnostics require ordered startup, IPC, and fixed scenario evidence", () => {
  const input = receipt();
  const report = diagnostics();
  const startup = [
    "startup.main_loaded",
    "startup.app_ready",
    "startup.window_created",
    "startup.navigation_started",
    "startup.window_ready",
    "startup.providers_ready",
    "startup.shell_painted",
    "startup.composer_ready",
  ];
  report.diagnostics.events = startup.map((name, index) => ({
    sequence: index + 1,
    monotonicMs: index + 1,
    name,
  }));
  report.diagnostics.events.push(
    {
      sequence: 9,
      monotonicMs: 9,
      name: "main.event_loop_sample",
      durationMs: 1,
      count: 1,
      state: "complete",
    },
    {
      sequence: 10,
      monotonicMs: 10,
      name: "renderer.react_commit",
      durationMs: 1,
      count: 1,
    },
    {
      sequence: 11,
      monotonicMs: 11,
      name: "renderer.scheduler_snapshot",
      count: 1,
    },
  );
  const completeEvents = JSON.parse(JSON.stringify(report.diagnostics.events));
  assert.equal(
    verifyPerformanceDiagnosticExport(report, input, 4_096, {
      requireScenarioEvidence: true,
    }),
    true,
  );
  const originalMeasurements = input.measurements;
  input.measurements = Object.fromEntries(PERFORMANCE_MEASUREMENT_KEYS.map((key) => [key, 0]));
  Object.assign(input.measurements, {
    mainLoadedMs: 1,
    appReadyMs: 2,
    windowCreatedMs: 3,
    navigationStartedMs: 4,
    windowReadyMs: 5,
    providersReadyMs: 6,
    shellPaintMs: 7,
    composerReadyMs: 8,
    reactCommitCount: 1,
    reactCommitDurationMs: 1,
    childPeak: 1,
    ipcMessages: 1,
    ipcBytesIn: 8,
    ipcBytesOut: 32,
  });
  report.diagnostics.gauges["live:renderer-raf"] = { current: 0, peak: 0 };
  report.diagnostics.gauges["live:renderer-timer"] = { current: 0, peak: 0 };
  assert.equal(
    verifyPerformanceDiagnosticExport(report, input, 4_096, {
      requireScenarioEvidence: true,
    }),
    true,
  );
  input.measurements.ipcMessages = 2;
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /does not match diagnostics/u,
  );
  input.measurements = originalMeasurements;
  report.diagnostics.counters["benchmark:power-source-transition"].count = 1;
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /changed power source/u,
  );
  report.diagnostics.counters["benchmark:power-source-transition"].count = 0;
  report.diagnostics.events.splice(3, 1);
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /startup sequence/u,
  );
  report.diagnostics.events = JSON.parse(JSON.stringify(completeEvents));

  input.scenario = "voice-long";
  input.fixture.scenario = "voice-long";
  report.metadata.scenario = "voice-long";
  report.diagnostics.counters["benchmark:voice-fixed-decode"] = {
    count: 2,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
  };
  assert.equal(
    verifyPerformanceDiagnosticExport(report, input, 4_096, {
      requireScenarioEvidence: true,
    }),
    true,
  );
  report.diagnostics.counters["benchmark:voice-fixed-decode"].errors = 1;
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /voice decode/u,
  );

  input.scenario = "mcp-duplicate-connect";
  input.fixture.scenario = "mcp-duplicate-connect";
  report.metadata.scenario = "mcp-duplicate-connect";
  delete report.diagnostics.counters["benchmark:voice-fixed-decode"];
  report.diagnostics.counters["benchmark:mcp-duplicate-connect"] = {
    count: 100,
    errors: 100,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
  };
  report.diagnostics.counters["child:mcp-stdio"] = {
    count: 100,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
  };
  report.diagnostics.gauges["live:child-mcp-stdio"] = { current: 0, peak: 100 };
  assert.equal(
    verifyPerformanceDiagnosticExport(report, input, 4_096, {
      requireScenarioEvidence: true,
    }),
    true,
  );
  report.diagnostics.counters["benchmark:mcp-duplicate-connect"].count = 99;
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /duplicate-connect/u,
  );
  report.diagnostics.counters["benchmark:mcp-duplicate-connect"].count = 100;
  report.diagnostics.counters["child:mcp-stdio"].count = 99;
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /duplicate-connect/u,
  );
  report.diagnostics.counters["child:mcp-stdio"].count = 100;

  input.scenario = "schedules-20-missed";
  input.fixture.scenario = "schedules-20-missed";
  report.metadata.scenario = "schedules-20-missed";
  delete report.diagnostics.counters["benchmark:mcp-duplicate-connect"];
  report.diagnostics.counters["schedule:run-start"] = {
    count: 20,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
  };
  report.diagnostics.counters["schedule:run-terminal:success"] = {
    count: 20,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
  };
  report.diagnostics.counters["schedule:run-duplicate"] = {
    count: 0,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 0,
  };
  report.diagnostics.gauges["live:schedule-run"] = { current: 0, peak: 20 };
  assert.equal(
    verifyPerformanceDiagnosticExport(report, input, 4_096, {
      requireScenarioEvidence: true,
    }),
    true,
  );
  report.diagnostics.counters["schedule:run-terminal:success"].count = 19;
  assert.throws(
    () =>
      verifyPerformanceDiagnosticExport(report, input, 4_096, {
        requireScenarioEvidence: true,
      }),
    /schedule catch-up/u,
  );
});

test("receipt reads reject oversized input before parsing it", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "build", "aiden-performance-receipt-"));
  const file = path.join(directory, "oversized.json");
  await writeFile(file, `{"payload":"${"x".repeat(4_096)}"}`);
  await assert.rejects(() => readBoundedJsonFile(file, 1_024), /bounded regular file/u);
});

test("complete receipts bind every named artifact to an existing relative file", async () => {
  const directory = await mkdtemp(
    path.join(process.cwd(), "build", "aiden-performance-artifacts-"),
  );
  const input = receipt();
  input.packageIdentity = {
    schemaVersion: 1,
    commit: input.commit,
    dirtyStateHash: input.dirtyStateHash,
    buildMode: input.buildMode,
    profilingBuild: input.profilingBuild,
    runtimeNodeVersion: input.nodeVersion,
    runtimeElectronVersion: input.electronVersion,
    runtimePlatform: input.platform,
    runtimeArchitecture: input.architecture,
    appAsarSha256: "a".repeat(64),
    executableSha256: "b".repeat(64),
    codeDirectoryHash: "c".repeat(40),
  };
  input.measurements = Object.fromEntries(PERFORMANCE_MEASUREMENT_KEYS.map((key) => [key, 1]));
  input.artifacts = {};
  for (const key of PERFORMANCE_ARTIFACT_KEYS) {
    const relative = `${key}.${new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key) ? "zip" : "json"}`;
    const bytes = new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key)
      ? traceZip(key)
      : Buffer.from(`{"artifact":"${key}"}`);
    await writeFile(path.join(directory, relative), bytes);
    input.artifacts[key] = {
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
  const receiptPath = path.join(directory, "receipt.json");
  try {
    await writeFile(receiptPath, JSON.stringify(input));
    assert.equal(await verifyPerformanceReceiptArtifacts(input, receiptPath), true);
    const duplicate = await readFile(path.join(directory, input.artifacts.timeProfiler.path));
    await writeFile(path.join(directory, input.artifacts.energyLog.path), duplicate);
    input.artifacts.energyLog.bytes = duplicate.length;
    input.artifacts.energyLog.sha256 = createHash("sha256").update(duplicate).digest("hex");
    await writeFile(receiptPath, JSON.stringify(input));
    await assert.rejects(
      () => verifyPerformanceReceiptArtifacts(input, receiptPath),
      /distinct recordings/u,
    );
    await writeFile(path.join(directory, input.artifacts.energyLog.path), "changed");
    await writeFile(receiptPath, JSON.stringify(input));
    await assert.rejects(
      () => verifyPerformanceReceiptArtifacts(input, receiptPath),
      /does not match/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("complete CLI verification always validates the bound diagnostics schema", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "build", "aiden-performance-cli-"));
  const input = receipt();
  input.packageIdentity = {
    schemaVersion: 1,
    commit: input.commit,
    dirtyStateHash: input.dirtyStateHash,
    buildMode: input.buildMode,
    profilingBuild: input.profilingBuild,
    runtimeNodeVersion: input.nodeVersion,
    runtimeElectronVersion: input.electronVersion,
    runtimePlatform: input.platform,
    runtimeArchitecture: input.architecture,
    appAsarSha256: "a".repeat(64),
    executableSha256: "b".repeat(64),
    codeDirectoryHash: "c".repeat(40),
  };
  input.measurements = Object.fromEntries(PERFORMANCE_MEASUREMENT_KEYS.map((key) => [key, 1]));
  input.artifacts = {};
  try {
    for (const key of PERFORMANCE_ARTIFACT_KEYS) {
      const relative = `${key}.${new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key) ? "zip" : "json"}`;
      const bytes = new Set(["timeProfiler", "energyLog", "coreAnimation"]).has(key)
        ? Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
        : Buffer.from(key === "diagnosticsExport" ? "not-json" : `{"artifact":"${key}"}`);
      await writeFile(path.join(directory, relative), bytes);
      input.artifacts[key] = {
        path: relative,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
    }
    const receiptPath = path.join(directory, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(input));
    assert.throws(() =>
      execFileSync(process.execPath, [
        path.join(process.cwd(), "scripts", "performance-receipt.mjs"),
        "--receipt",
        receiptPath,
        "--require-complete",
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
