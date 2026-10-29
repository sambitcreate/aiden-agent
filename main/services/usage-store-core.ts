import type {
  UsageDateRange,
  UsageModelSummary,
  UsageSummary,
  UsageTokenBreakdown,
} from "./types.js";

export type UsageRequestSource =
  | "chat"
  | "chat-title"
  | "bot-avatar"
  | "vision"
  | "voice-transcription"
  | "text-to-speech"
  | "scheduled"
  | "subagent"
  | "telegram"
  | "btw"
  | "advisor"
  | "compaction"
  | "cache-warm"
  | "design"
  | "create-images";
export type UsageRequestStatus = "completed" | "failed" | "cancelled";
export type UsageCostStatus = "reported" | "unavailable" | "not-applicable";

/**
 * One model-call accounting event. It intentionally cannot carry prompts,
 * chat ids, workspace ids, paths, transcripts, or generated content.
 */
export interface UsageRequestRecord {
  timestamp?: number;
  source: UsageRequestSource;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  local: boolean;
  status: UsageRequestStatus;
  tokens: UsageTokenBreakdown | null;
  costStatus: UsageCostStatus;
  costUsd?: number;
}

interface DailyUsageBucket {
  date: string;
  source: UsageRequestSource;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  local: boolean;
  requests: number;
  completedRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  reportedTokenRequests: number;
  unmeteredRequests: number;
  costedRequests: number;
  unpricedHostedRequests: number;
  tokens: UsageTokenBreakdown;
  hostedCostUsd: number;
}

export interface UsageDatabase {
  version: 1;
  buckets: DailyUsageBucket[];
}

export interface UsagePersistence {
  load(): Promise<unknown>;
  save(data: UsageDatabase): Promise<void>;
}

const RANGE_DAYS: Record<Exclude<UsageDateRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

const REQUEST_SOURCES = new Set<UsageRequestSource>([
  "chat",
  "chat-title",
  "bot-avatar",
  "vision",
  "voice-transcription",
  "text-to-speech",
  "scheduled",
  "subagent",
  "telegram",
  "btw",
  "advisor",
  "compaction",
  "cache-warm",
  "design",
  "create-images",
]);

export function emptyUsageTokens(): UsageTokenBreakdown {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    total: 0,
  };
}

export function createEmptyUsageDatabase(): UsageDatabase {
  return { version: 1, buckets: [] };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function nonNegativeInteger(value: unknown): number {
  return Math.floor(nonNegative(value));
}

function normalizeTokens(value: unknown): UsageTokenBreakdown {
  const tokens =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    input: nonNegativeInteger(tokens.input),
    output: nonNegativeInteger(tokens.output),
    cacheRead: nonNegativeInteger(tokens.cacheRead),
    cacheWrite: nonNegativeInteger(tokens.cacheWrite),
    cacheWrite1h: nonNegativeInteger(tokens.cacheWrite1h),
    reasoning: nonNegativeInteger(tokens.reasoning),
    total: nonNegativeInteger(tokens.total),
  };
}

function addTokens(
  target: UsageTokenBreakdown,
  value: UsageTokenBreakdown,
): void {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.cacheWrite1h = (target.cacheWrite1h ?? 0) + (value.cacheWrite1h ?? 0);
  target.reasoning += value.reasoning;
  target.total += value.total;
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeBucket(value: unknown): DailyUsageBucket | null {
  if (!value || typeof value !== "object") return null;
  const bucket = value as Record<string, unknown>;
  if (
    !isDateKey(bucket.date) ||
    !REQUEST_SOURCES.has(bucket.source as UsageRequestSource)
  ) {
    return null;
  }
  const local = bucket.local === true;
  return {
    date: bucket.date,
    source: bucket.source as UsageRequestSource,
    providerId: stringOr(bucket.providerId, "unknown"),
    providerLabel: stringOr(
      bucket.providerLabel,
      stringOr(bucket.providerId, "Unknown"),
    ),
    modelId: stringOr(bucket.modelId, "unknown"),
    modelLabel: stringOr(
      bucket.modelLabel,
      stringOr(bucket.modelId, "Unknown model"),
    ),
    local,
    requests: nonNegativeInteger(bucket.requests),
    completedRequests: nonNegativeInteger(bucket.completedRequests),
    failedRequests: nonNegativeInteger(bucket.failedRequests),
    cancelledRequests: nonNegativeInteger(bucket.cancelledRequests),
    reportedTokenRequests: nonNegativeInteger(bucket.reportedTokenRequests),
    unmeteredRequests: nonNegativeInteger(bucket.unmeteredRequests),
    costedRequests: local ? 0 : nonNegativeInteger(bucket.costedRequests),
    unpricedHostedRequests: local
      ? 0
      : nonNegativeInteger(bucket.unpricedHostedRequests),
    tokens: normalizeTokens(bucket.tokens),
    hostedCostUsd: local ? 0 : nonNegative(bucket.hostedCostUsd),
  };
}

function normalizeDatabase(value: unknown): UsageDatabase {
  if (!value || typeof value !== "object") return createEmptyUsageDatabase();
  const database = value as Record<string, unknown>;
  const buckets = Array.isArray(database.buckets)
    ? database.buckets
        .map(normalizeBucket)
        .filter((item): item is DailyUsageBucket => item !== null)
    : [];
  return { version: 1, buckets };
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Usage timestamp is outside the valid date range.");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftDateKey(value: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function dateOrdinal(value: string): number {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function bucketKey(
  bucket: Pick<
    DailyUsageBucket,
    "date" | "source" | "providerId" | "modelId" | "local"
  >,
): string {
  return JSON.stringify([
    bucket.date,
    bucket.source,
    bucket.providerId,
    bucket.modelId,
    bucket.local ? "local" : "hosted",
  ]);
}

function modelKey(
  bucket: Pick<DailyUsageBucket, "providerId" | "modelId" | "local">,
): string {
  return JSON.stringify([
    bucket.providerId,
    bucket.modelId,
    bucket.local ? "local" : "hosted",
  ]);
}

function streaks(
  activeDates: string[],
  endDate: string,
): { current: number; longest: number } {
  const ordered = [...new Set(activeDates)].sort();
  if (ordered.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let index = 1; index < ordered.length; index += 1) {
    if (dateOrdinal(ordered[index]!) - dateOrdinal(ordered[index - 1]!) === 1)
      run += 1;
    else run = 1;
    longest = Math.max(longest, run);
  }

  const active = new Set(ordered);
  let cursor = active.has(endDate)
    ? endDate
    : active.has(shiftDateKey(endDate, -1))
      ? shiftDateKey(endDate, -1)
      : null;
  let current = 0;
  while (cursor && active.has(cursor)) {
    current += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return { current, longest };
}

function summaryFromDatabase(
  database: UsageDatabase,
  range: UsageDateRange,
  now: number,
): UsageSummary {
  const endDate = localDateKey(now);
  const earliest = database.buckets.reduce<string | null>(
    (value, bucket) =>
      value === null || bucket.date < value ? bucket.date : value,
    null,
  );
  const startDate =
    range === "all"
      ? (earliest ?? endDate)
      : shiftDateKey(endDate, -(RANGE_DAYS[range] - 1));
  const buckets = database.buckets.filter(
    (bucket) => bucket.date >= startDate && bucket.date <= endDate,
  );

  const totals: UsageSummary["totals"] = {
    requests: 0,
    completedRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    reportedTokenRequests: 0,
    unmeteredRequests: 0,
    localRequests: 0,
    costedRequests: 0,
    unpricedHostedRequests: 0,
    hostedCostUsd: 0,
    activeDays: 0,
    currentStreak: 0,
    longestStreak: 0,
    tokens: emptyUsageTokens(),
  };
  const dayMap = new Map<string, UsageSummary["days"][number]>();
  const models = new Map<string, UsageModelSummary>();

  for (const bucket of buckets) {
    totals.requests += bucket.requests;
    totals.completedRequests += bucket.completedRequests;
    totals.failedRequests += bucket.failedRequests;
    totals.cancelledRequests += bucket.cancelledRequests;
    totals.reportedTokenRequests += bucket.reportedTokenRequests;
    totals.unmeteredRequests += bucket.unmeteredRequests;
    totals.localRequests += bucket.local ? bucket.requests : 0;
    totals.costedRequests += bucket.costedRequests;
    totals.unpricedHostedRequests += bucket.unpricedHostedRequests;
    totals.hostedCostUsd += bucket.hostedCostUsd;
    addTokens(totals.tokens, bucket.tokens);

    const day = dayMap.get(bucket.date) ?? {
      date: bucket.date,
      requests: 0,
      reportedTokenRequests: 0,
      unmeteredRequests: 0,
      tokens: emptyUsageTokens(),
      hostedCostUsd: 0,
    };
    day.requests += bucket.requests;
    day.reportedTokenRequests += bucket.reportedTokenRequests;
    day.unmeteredRequests += bucket.unmeteredRequests;
    day.hostedCostUsd += bucket.hostedCostUsd;
    addTokens(day.tokens, bucket.tokens);
    dayMap.set(bucket.date, day);

    const key = modelKey(bucket);
    const model = models.get(key) ?? {
      providerId: bucket.providerId,
      providerLabel: bucket.providerLabel,
      modelId: bucket.modelId,
      modelLabel: bucket.modelLabel,
      local: bucket.local,
      requests: 0,
      reportedTokenRequests: 0,
      unmeteredRequests: 0,
      tokens: emptyUsageTokens(),
      hostedCostUsd: 0,
    };
    model.providerLabel = bucket.providerLabel;
    model.modelLabel = bucket.modelLabel;
    model.requests += bucket.requests;
    model.reportedTokenRequests += bucket.reportedTokenRequests;
    model.unmeteredRequests += bucket.unmeteredRequests;
    model.hostedCostUsd += bucket.hostedCostUsd;
    addTokens(model.tokens, bucket.tokens);
    models.set(key, model);
  }

  const days = [...dayMap.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const streak = streaks(
    days.filter((day) => day.requests > 0).map((day) => day.date),
    endDate,
  );
  totals.activeDays = days.filter((day) => day.requests > 0).length;
  totals.currentStreak = streak.current;
  totals.longestStreak = streak.longest;

  return {
    range,
    startDate,
    endDate,
    totals,
    days,
    models: [...models.values()].sort(
      (left, right) =>
        right.requests - left.requests ||
        right.tokens.total - left.tokens.total ||
        left.modelLabel.localeCompare(right.modelLabel),
    ),
  };
}

export interface UsageStoreOptions {
  /**
   * Coalesce saves for this many milliseconds instead of writing on every
   * request. Callers that set it must call `flush()` before exit; `record`
   * then resolves once the aggregate is in memory and reports later save
   * failures through `onSaveError`. Omitted, every record waits for its save.
   */
  saveDelayMs?: number;
  onSaveError?: (error: unknown) => void;
}

export function createUsageStore(
  persistence: UsagePersistence,
  now: () => number = Date.now,
  options: UsageStoreOptions = {},
): {
  record(record: UsageRequestRecord): Promise<void>;
  summary(range: UsageDateRange): Promise<UsageSummary>;
  /** Write any coalesced aggregate now; resolves once it is durable. */
  flush(): Promise<void>;
} {
  const saveDelayMs =
    typeof options.saveDelayMs === "number" && options.saveDelayMs > 0
      ? options.saveDelayMs
      : 0;
  let mutationQueue: Promise<void> = Promise.resolve();
  let databasePromise: Promise<{
    database: UsageDatabase;
    index: Map<string, DailyUsageBucket>;
  }> | null = null;
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadDatabase(): Promise<{
    database: UsageDatabase;
    index: Map<string, DailyUsageBucket>;
  }> {
    databasePromise ??= persistence.load().then((value) => {
      const database = normalizeDatabase(value);
      const index = new Map<string, DailyUsageBucket>();
      // Keep the first bucket for a key, as the former linear lookup did.
      for (const bucket of database.buckets) {
        const key = bucketKey(bucket);
        if (!index.has(key)) index.set(key, bucket);
      }
      return { database, index };
    });
    try {
      return await databasePromise;
    } catch (error) {
      databasePromise = null;
      throw error;
    }
  }

  /** Runs inside the mutation queue, so it never races a record. */
  async function saveIfDirty(): Promise<void> {
    if (!dirty || !databasePromise) return;
    const { database } = await databasePromise;
    dirty = false;
    try {
      await persistence.save(database);
    } catch (error) {
      dirty = true;
      throw error;
    }
  }

  function enqueueFlush(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const task = mutationQueue.then(saveIfDirty);
    mutationQueue = task.catch(() => undefined);
    return task;
  }

  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      enqueueFlush().catch((error: unknown) => options.onSaveError?.(error));
    }, saveDelayMs);
    saveTimer.unref?.();
  }

  return {
    record(record) {
      const task = mutationQueue.then(async () => {
        const { database, index } = await loadDatabase();
        const timestamp =
          typeof record.timestamp === "number" &&
          Number.isFinite(record.timestamp)
            ? record.timestamp
            : now();
        const descriptor = {
          date: localDateKey(timestamp),
          source: record.source,
          providerId: stringOr(record.providerId, "unknown"),
          providerLabel: stringOr(
            record.providerLabel,
            stringOr(record.providerId, "Unknown"),
          ),
          modelId: stringOr(record.modelId, "unknown"),
          modelLabel: stringOr(
            record.modelLabel,
            stringOr(record.modelId, "Unknown model"),
          ),
          local: record.local,
        };
        const key = bucketKey(descriptor);
        let bucket = index.get(key);
        if (!bucket) {
          bucket = {
            ...descriptor,
            requests: 0,
            completedRequests: 0,
            failedRequests: 0,
            cancelledRequests: 0,
            reportedTokenRequests: 0,
            unmeteredRequests: 0,
            costedRequests: 0,
            unpricedHostedRequests: 0,
            tokens: emptyUsageTokens(),
            hostedCostUsd: 0,
          };
          database.buckets.push(bucket);
          index.set(key, bucket);
        }
        bucket.providerLabel = descriptor.providerLabel;
        bucket.modelLabel = descriptor.modelLabel;
        bucket.requests += 1;
        if (record.status === "completed") bucket.completedRequests += 1;
        else if (record.status === "cancelled") bucket.cancelledRequests += 1;
        else bucket.failedRequests += 1;

        if (record.tokens) {
          bucket.reportedTokenRequests += 1;
          addTokens(bucket.tokens, normalizeTokens(record.tokens));
        } else {
          bucket.unmeteredRequests += 1;
        }

        if (!record.local && record.costStatus === "reported") {
          bucket.costedRequests += 1;
          bucket.hostedCostUsd += nonNegative(record.costUsd);
        } else if (!record.local) {
          bucket.unpricedHostedRequests += 1;
        }
        if (saveDelayMs === 0) {
          // Without a delay every record waits for its own save, as before.
          await persistence.save(database);
        } else {
          dirty = true;
          scheduleSave();
        }
      });
      mutationQueue = task.catch(() => undefined);
      return task;
    },

    async summary(range) {
      await mutationQueue;
      const { database } = await loadDatabase();
      return summaryFromDatabase(database, range, now());
    },

    flush: enqueueFlush,
  };
}
