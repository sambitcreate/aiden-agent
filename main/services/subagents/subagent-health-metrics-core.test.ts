import assert from "node:assert/strict";
import test from "node:test";
import { subagentHealthMetricsEnabled } from "./feature-flag.js";
import {
  aggregateSubagentHealthMetrics,
  createEmptySubagentHealthMetrics,
  createSubagentHealthMetricsRecorder,
  createSubagentHealthMetricsService,
  MAX_SUBAGENT_HEALTH_METRICS_DAYS,
  normalizeSubagentHealthMetrics,
  type SubagentHealthMetricsDatabase,
} from "./subagent-health-metrics-core.js";

function memoryPersistence(initial: unknown = createEmptySubagentHealthMetrics()) {
  let stored = structuredClone(initial);
  const saves: SubagentHealthMetricsDatabase[] = [];
  return {
    persistence: {
      async load(): Promise<unknown> {
        return structuredClone(stored);
      },
      async save(metrics: SubagentHealthMetricsDatabase): Promise<void> {
        stored = structuredClone(metrics);
        saves.push(structuredClone(metrics));
      },
    },
    saves,
    read: () => structuredClone(stored),
  };
}

test("normalization keeps only the closed aggregate schema and merges duplicate days", () => {
  const metrics = normalizeSubagentHealthMetrics({
    version: 1,
    owner: "private-chat-id",
    days: [
      {
        date: "2026-07-28",
        starts: 2.9,
        completions: 1,
        failures: -1,
        timeouts: Number.POSITIVE_INFINITY,
        peakConcurrency: 1,
        cleanupFailures: 2,
        task: "private task text",
      },
      {
        date: "2026-07-28",
        starts: Number.MAX_SAFE_INTEGER,
        completions: 3,
        failures: 2,
        timeouts: 1,
        peakConcurrency: 4,
        cleanupFailures: 1,
        path: "/private/workspace",
      },
      { date: "2026-02-30", starts: 100 },
      "not a day",
    ],
  });

  assert.deepEqual(metrics, {
    version: 1,
    days: [
      {
        date: "2026-07-28",
        starts: Number.MAX_SAFE_INTEGER,
        completions: 4,
        failures: 2,
        timeouts: 1,
        peakConcurrency: 4,
        cleanupFailures: 3,
      },
    ],
  });
  assert.deepEqual(Object.keys(metrics.days[0]!).sort(), [
    "cleanupFailures",
    "completions",
    "date",
    "failures",
    "peakConcurrency",
    "starts",
    "timeouts",
  ]);
  assert.doesNotMatch(JSON.stringify(metrics), /private|workspace|task|owner/u);
  assert.deepEqual(normalizeSubagentHealthMetrics({ version: 2, days: [] }), {
    version: 1,
    days: [],
  });
});

test("normalization retains only the latest 90 daily buckets", () => {
  const days = Array.from({ length: MAX_SUBAGENT_HEALTH_METRICS_DAYS + 5 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    starts: 1,
  }));
  const metrics = normalizeSubagentHealthMetrics({ version: 1, days: [...days].reverse() });

  assert.equal(metrics.days.length, MAX_SUBAGENT_HEALTH_METRICS_DAYS);
  assert.equal(metrics.days[0]?.date, days[5]?.date);
  assert.equal(metrics.days[metrics.days.length - 1]?.date, days[days.length - 1]?.date);
});

test("packaged-soak aggregation removes daily keys while retaining only safe totals", () => {
  const aggregate = aggregateSubagentHealthMetrics({
    version: 1,
    days: [
      {
        date: "2026-07-27",
        starts: 2,
        completions: 1,
        failures: 1,
        timeouts: 0,
        peakConcurrency: 2,
        cleanupFailures: 0,
      },
      {
        date: "2026-07-28",
        starts: 3,
        completions: 2,
        failures: 0,
        timeouts: 1,
        peakConcurrency: 4,
        cleanupFailures: 1,
      },
    ],
  });

  assert.deepEqual(aggregate, {
    starts: 5,
    completions: 3,
    failures: 1,
    timeouts: 1,
    peakConcurrency: 4,
    cleanupFailures: 1,
  });
  assert.deepEqual(Object.keys(aggregate).sort(), [
    "cleanupFailures",
    "completions",
    "failures",
    "peakConcurrency",
    "starts",
    "timeouts",
  ]);
  assert.doesNotMatch(JSON.stringify(aggregate), /2026|date/u);
});

test("recorder aggregates actual starts, terminal outcomes, cleanup misses, and peak concurrency", async () => {
  const memory = memoryPersistence();
  const timestamp = new Date(2026, 6, 28, 12).getTime();
  const recorder = createSubagentHealthMetricsRecorder(memory.persistence, () => timestamp);

  await Promise.all([
    recorder.recordStarted(1),
    recorder.recordStarted(2),
    recorder.recordStarted(1),
    recorder.recordTerminal("completed"),
    recorder.recordTerminal("failed"),
    recorder.recordTerminal("timed_out"),
    recorder.recordCleanupFailure(),
  ]);
  await recorder.flush();

  assert.deepEqual(await recorder.snapshot(), {
    version: 1,
    days: [
      {
        date: "2026-07-28",
        starts: 3,
        completions: 1,
        failures: 1,
        timeouts: 1,
        peakConcurrency: 2,
        cleanupFailures: 1,
      },
    ],
  });
  assert.equal(memory.saves.length, 7);
});

test("recorder assigns each event to the local day when it is recorded", async () => {
  const memory = memoryPersistence();
  let timestamp = new Date(2026, 6, 28, 23, 59).getTime();
  const recorder = createSubagentHealthMetricsRecorder(memory.persistence, () => timestamp);

  await recorder.recordStarted(1);
  timestamp = new Date(2026, 6, 29, 0, 1).getTime();
  await recorder.recordTerminal("completed");

  assert.deepEqual(
    (await recorder.snapshot()).days.map((day) => [day.date, day.starts, day.completions]),
    [
      ["2026-07-28", 1, 0],
      ["2026-07-29", 0, 1],
    ],
  );
});

test("a failed persistence write does not poison later aggregate mutations", async () => {
  let attempts = 0;
  let stored = createEmptySubagentHealthMetrics();
  const recorder = createSubagentHealthMetricsRecorder(
    {
      async load() {
        return structuredClone(stored);
      },
      async save(metrics) {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
        stored = structuredClone(metrics);
      },
    },
    () => new Date(2026, 6, 28, 12).getTime(),
  );

  await assert.rejects(recorder.recordStarted(1), /disk unavailable/u);
  await recorder.recordTerminal("failed");

  assert.equal(attempts, 2);
  assert.deepEqual(await recorder.snapshot(), {
    version: 1,
    days: [
      {
        date: "2026-07-28",
        starts: 0,
        completions: 0,
        failures: 1,
        timeouts: 0,
        peakConcurrency: 0,
        cleanupFailures: 0,
      },
    ],
  });
});

test("a packaged-soak snapshot fails closed after a later aggregate write is dropped", async () => {
  let attempts = 0;
  let stored = createEmptySubagentHealthMetrics();
  const recorder = createSubagentHealthMetricsRecorder(
    {
      async load() {
        return structuredClone(stored);
      },
      async save(metrics) {
        attempts += 1;
        if (attempts === 2) throw new Error("disk unavailable");
        stored = structuredClone(metrics);
      },
    },
    () => new Date(2026, 6, 28, 12).getTime(),
  );
  let warnings = 0;
  const service = createSubagentHealthMetricsService({
    recorder,
    enabled: () => true,
    onPersistenceError: () => {
      warnings += 1;
    },
  });

  service.started(1);
  await service.flush();
  service.cleanupFailed();
  await service.flush();

  assert.equal(warnings, 1);
  assert.deepEqual(await recorder.snapshot(), {
    version: 1,
    days: [
      {
        date: "2026-07-28",
        starts: 1,
        completions: 0,
        failures: 0,
        timeouts: 0,
        peakConcurrency: 1,
        cleanupFailures: 0,
      },
    ],
  });
  await assert.rejects(service.snapshotForPackagedSoak(), /health metrics are incomplete/u);
});

test("health metrics follow the default-on subagent rollout and explicit rollback", () => {
  assert.equal(subagentHealthMetricsEnabled({}), true);
  assert.equal(subagentHealthMetricsEnabled({ AIDEN_SUBAGENTS_ENABLED: "0" }), false);
  assert.equal(subagentHealthMetricsEnabled({ AIDEN_SUBAGENTS_ENABLED: "1" }), true);
});
