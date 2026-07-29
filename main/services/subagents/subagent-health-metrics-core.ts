export const SUBAGENT_HEALTH_METRICS_VERSION = 1 as const;
export const MAX_SUBAGENT_HEALTH_METRICS_DAYS = 90;

export type SubagentHealthTerminalState = "completed" | "failed" | "timed_out";

export interface SubagentHealthMetricsSink {
  started(activeConcurrency: number): void;
  terminal(state: SubagentHealthTerminalState): void;
  cleanupFailed(): void;
}

export interface SubagentHealthMetricsDay {
  date: string;
  starts: number;
  completions: number;
  failures: number;
  timeouts: number;
  peakConcurrency: number;
  cleanupFailures: number;
}

/**
 * Aggregate-only local release evidence. The closed schema cannot carry child
 * labels, task text, identifiers, model/provider details, paths, durations,
 * errors, or transcript content.
 */
export interface SubagentHealthMetricsDatabase {
  version: typeof SUBAGENT_HEALTH_METRICS_VERSION;
  days: SubagentHealthMetricsDay[];
}

/** A receipt-safe reduction of local daily evidence; it intentionally has no date keys. */
export interface SubagentHealthMetricsAggregate {
  starts: number;
  completions: number;
  failures: number;
  timeouts: number;
  peakConcurrency: number;
  cleanupFailures: number;
}

export interface SubagentHealthMetricsPersistence {
  load(): Promise<unknown>;
  save(data: SubagentHealthMetricsDatabase): Promise<void>;
}

export interface SubagentHealthMetricsServiceInput {
  recorder: SubagentHealthMetricsRecorder;
  enabled(): boolean;
  onPersistenceError(error: unknown): void;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function add(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Subagent health timestamp is outside the valid date range.");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyDay(date: string): SubagentHealthMetricsDay {
  return {
    date,
    starts: 0,
    completions: 0,
    failures: 0,
    timeouts: 0,
    peakConcurrency: 0,
    cleanupFailures: 0,
  };
}

function normalizeDay(value: unknown): SubagentHealthMetricsDay | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const day = value as Record<string, unknown>;
  if (!isDateKey(day.date)) return null;
  return {
    date: day.date,
    starts: nonNegativeInteger(day.starts),
    completions: nonNegativeInteger(day.completions),
    failures: nonNegativeInteger(day.failures),
    timeouts: nonNegativeInteger(day.timeouts),
    peakConcurrency: nonNegativeInteger(day.peakConcurrency),
    cleanupFailures: nonNegativeInteger(day.cleanupFailures),
  };
}

function boundedDays(days: readonly SubagentHealthMetricsDay[]): SubagentHealthMetricsDay[] {
  return [...days]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-MAX_SUBAGENT_HEALTH_METRICS_DAYS);
}

export function createEmptySubagentHealthMetrics(): SubagentHealthMetricsDatabase {
  return {
    version: SUBAGENT_HEALTH_METRICS_VERSION,
    days: [],
  };
}

export function normalizeSubagentHealthMetrics(value: unknown): SubagentHealthMetricsDatabase {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptySubagentHealthMetrics();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SUBAGENT_HEALTH_METRICS_VERSION || !Array.isArray(record.days)) {
    return createEmptySubagentHealthMetrics();
  }
  const byDate = new Map<string, SubagentHealthMetricsDay>();
  for (const raw of record.days) {
    const day = normalizeDay(raw);
    if (!day) continue;
    const existing = byDate.get(day.date);
    if (!existing) {
      byDate.set(day.date, day);
      continue;
    }
    existing.starts = add(existing.starts, day.starts);
    existing.completions = add(existing.completions, day.completions);
    existing.failures = add(existing.failures, day.failures);
    existing.timeouts = add(existing.timeouts, day.timeouts);
    existing.peakConcurrency = Math.max(existing.peakConcurrency, day.peakConcurrency);
    existing.cleanupFailures = add(existing.cleanupFailures, day.cleanupFailures);
  }
  return {
    version: SUBAGENT_HEALTH_METRICS_VERSION,
    days: boundedDays([...byDate.values()]),
  };
}

/**
 * Reduce retained daily evidence into the closed shape consumed by the
 * one-shot packaged-soak receipt. This boundary prevents dates or any future
 * persistence metadata from crossing into the release artifact.
 */
export function aggregateSubagentHealthMetrics(
  value: SubagentHealthMetricsDatabase,
): SubagentHealthMetricsAggregate {
  return normalizeSubagentHealthMetrics(value).days.reduce<SubagentHealthMetricsAggregate>(
    (aggregate, day) => ({
      starts: add(aggregate.starts, day.starts),
      completions: add(aggregate.completions, day.completions),
      failures: add(aggregate.failures, day.failures),
      timeouts: add(aggregate.timeouts, day.timeouts),
      peakConcurrency: Math.max(aggregate.peakConcurrency, day.peakConcurrency),
      cleanupFailures: add(aggregate.cleanupFailures, day.cleanupFailures),
    }),
    {
      starts: 0,
      completions: 0,
      failures: 0,
      timeouts: 0,
      peakConcurrency: 0,
      cleanupFailures: 0,
    },
  );
}

/**
 * Serializes aggregate mutations. Callers supply only a closed event and an
 * actual active-slot count; no child identity ever enters this store.
 */
export function createSubagentHealthMetricsRecorder(
  persistence: SubagentHealthMetricsPersistence,
  now: () => number = Date.now,
) {
  let tail: Promise<void> = Promise.resolve();
  let databasePromise: Promise<SubagentHealthMetricsDatabase> | null = null;

  async function loadDatabase(): Promise<SubagentHealthMetricsDatabase> {
    databasePromise ??= persistence.load().then(normalizeSubagentHealthMetrics);
    try {
      return await databasePromise;
    } catch (error) {
      databasePromise = null;
      throw error;
    }
  }

  function mutate(mutation: (day: SubagentHealthMetricsDay) => void): Promise<void> {
    const operation = tail.then(async () => {
      const database = structuredClone(await loadDatabase());
      const date = localDateKey(now());
      let day = database.days.find((candidate) => candidate.date === date);
      if (!day) {
        day = emptyDay(date);
        database.days.push(day);
      }
      mutation(day);
      database.days = boundedDays(database.days);
      await persistence.save(database);
      databasePromise = Promise.resolve(database);
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  return {
    recordStarted(activeConcurrency: number): Promise<void> {
      const active = nonNegativeInteger(activeConcurrency);
      return mutate((day) => {
        day.starts = increment(day.starts);
        day.peakConcurrency = Math.max(day.peakConcurrency, active);
      });
    },

    recordTerminal(state: SubagentHealthTerminalState): Promise<void> {
      return mutate((day) => {
        if (state === "completed") day.completions = increment(day.completions);
        else if (state === "failed") day.failures = increment(day.failures);
        else day.timeouts = increment(day.timeouts);
      });
    },

    recordCleanupFailure(): Promise<void> {
      return mutate((day) => {
        day.cleanupFailures = increment(day.cleanupFailures);
      });
    },

    async snapshot(): Promise<SubagentHealthMetricsDatabase> {
      await tail;
      return structuredClone(await loadDatabase());
    },

    flush(): Promise<void> {
      return tail;
    },
  };
}

export type SubagentHealthMetricsRecorder = ReturnType<typeof createSubagentHealthMetricsRecorder>;

/**
 * Keeps aggregate recording non-blocking for normal child execution, while
 * making the packaged-release receipt fail closed after any dropped write.
 * This intentionally exposes no error detail to the receipt or renderer.
 */
export function createSubagentHealthMetricsService(
  input: SubagentHealthMetricsServiceInput,
): SubagentHealthMetricsSink & {
  flush(): Promise<void>;
  snapshotForPackagedSoak(): Promise<SubagentHealthMetricsAggregate>;
} {
  let persistenceFailed = false;
  const pendingReports = new Set<Promise<void>>();

  function record(operation: () => Promise<void>): void {
    if (!input.enabled()) return;
    const report = operation().catch((error: unknown) => {
      persistenceFailed = true;
      input.onPersistenceError(error);
    });
    pendingReports.add(report);
    void report.then(() => pendingReports.delete(report));
  }

  async function flush(): Promise<void> {
    await input.recorder.flush();
    await Promise.all([...pendingReports]);
  }

  return {
    started(activeConcurrency): void {
      record(() => input.recorder.recordStarted(activeConcurrency));
    },

    terminal(state): void {
      record(() => input.recorder.recordTerminal(state));
    },

    cleanupFailed(): void {
      record(() => input.recorder.recordCleanupFailure());
    },

    flush,

    async snapshotForPackagedSoak(): Promise<SubagentHealthMetricsAggregate> {
      if (!input.enabled()) {
        throw new Error("Aggregate subagent health metrics are disabled.");
      }
      await flush();
      if (persistenceFailed) {
        throw new Error("Aggregate subagent health metrics are incomplete.");
      }
      return aggregateSubagentHealthMetrics(await input.recorder.snapshot());
    },
  };
}
