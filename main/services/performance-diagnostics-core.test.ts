import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateDiagnosticPayloadBytes,
  isSafeDiagnosticCounterKey,
  PerformanceDiagnosticBuffer,
} from "./performance-diagnostics-core.js";

test("diagnostics retain a bounded newest-first-safe event window", () => {
  let now = 0;
  const diagnostics = new PerformanceDiagnosticBuffer(2, 4_096, () => ++now);
  diagnostics.record({ name: "startup.main_loaded" });
  diagnostics.record({ name: "startup.app_ready" });
  diagnostics.record({ name: "startup.window_created" });
  const snapshot = diagnostics.snapshot();
  assert.deepEqual(
    snapshot.events.map((event) => event.name),
    ["startup.app_ready", "startup.window_created"],
  );
  assert.equal(snapshot.droppedEvents, 1);
});

test("diagnostics project only fixed event fields and bounded numbers", () => {
  const diagnostics = new PerformanceDiagnosticBuffer();
  diagnostics.record({
    name: "renderer.long_task",
    durationMs: Number.POSITIVE_INFINITY,
    count: -1,
    bytes: 42,
    state: "failed",
    secret: "PRIVATE PROMPT",
  } as never);
  const serialized = JSON.stringify(diagnostics.snapshot());
  assert.doesNotMatch(serialized, /PRIVATE PROMPT/u);
  assert.deepEqual(diagnostics.snapshot().events[0], {
    sequence: 1,
    monotonicMs: diagnostics.snapshot().events[0]?.monotonicMs,
    name: "renderer.long_task",
    bytes: 42,
    state: "failed",
  });
});

test("counters reject path-like and unbounded keys", () => {
  assert.equal(isSafeDiagnosticCounterKey("ipc:chats:list"), true);
  assert.equal(isSafeDiagnosticCounterKey("/Users/alice/private"), false);
  assert.equal(isSafeDiagnosticCounterKey("x".repeat(97)), false);
  const diagnostics = new PerformanceDiagnosticBuffer();
  diagnostics.count("ipc:chats:list", { bytesIn: 12, bytesOut: 34, durationMs: 5 });
  diagnostics.count("/Users/alice/private", { count: 100 });
  assert.deepEqual(Object.keys(diagnostics.snapshot().counters), ["ipc:chats:list"]);
});

test("gauges retain current and peak resource ownership", () => {
  const diagnostics = new PerformanceDiagnosticBuffer();
  diagnostics.gauge("live:pty", 1);
  diagnostics.gauge("live:pty", 3);
  diagnostics.gauge("live:pty", 0);
  assert.deepEqual(diagnostics.snapshot().gauges["live:pty"], { current: 0, peak: 3 });
});

test("diagnostics disclose aggregate-series exhaustion", () => {
  const diagnostics = new PerformanceDiagnosticBuffer();
  for (let index = 0; index < 256; index += 1) {
    diagnostics.count(`counter:${index}`);
    diagnostics.gauge(`gauge:${index}`, 0);
  }
  diagnostics.count("counter:overflow");
  diagnostics.gauge("gauge:overflow", 1);
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.droppedSeries, 2);
  assert.equal(snapshot.counters["counter:overflow"], undefined);
  assert.equal(snapshot.gauges["gauge:overflow"], undefined);
});

test("main long tasks are retained as a fixed bounded event", () => {
  const diagnostics = new PerformanceDiagnosticBuffer();
  diagnostics.record({ name: "main.long_task", durationMs: 72, state: "complete" });
  assert.equal(diagnostics.snapshot().events[0]?.name, "main.long_task");
  assert.equal(diagnostics.snapshot().events[0]?.durationMs, 72);
});

test("payload estimation is capped and cycle safe without serialization", () => {
  const cyclic: { text: string; self?: unknown } = { text: "x".repeat(1_000_000) };
  cyclic.self = cyclic;
  assert.equal(estimateDiagnosticPayloadBytes(cyclic, 1_024), 1_024);
  assert.equal(estimateDiagnosticPayloadBytes(new Uint8Array(64)), 64);
});

test("payload estimation saturates when a traversal bound would undercount input", () => {
  const cap = 4_096;
  assert.equal(estimateDiagnosticPayloadBytes({ ["k".repeat(10_000)]: 1 }, cap), cap);
  assert.equal(
    estimateDiagnosticPayloadBytes(
      Object.fromEntries([
        ...Array.from({ length: 512 }, (_, index) => [`field${index}`, index]),
        ["late", "x".repeat(10_000)],
      ]),
      cap,
    ),
    cap,
  );
  assert.equal(
    estimateDiagnosticPayloadBytes(
      Array.from({ length: 16_385 }, () => 0),
      cap,
    ),
    cap,
  );
});

test("payload estimation preserves useful totals for realistic provider catalogs", () => {
  const catalog = Array.from({ length: 40 }, (_, providerIndex) => ({
    id: `provider-${providerIndex}`,
    models: Array.from({ length: 300 }, (_, modelIndex) => ({
      id: `model-${modelIndex}`,
      name: `Model ${modelIndex}`,
      contextWindow: 128_000,
    })),
  }));
  const cap = 16 * 1024 * 1024;
  const estimate = estimateDiagnosticPayloadBytes(catalog, cap);
  assert.ok(estimate > 100_000);
  assert.ok(estimate < cap);
});
