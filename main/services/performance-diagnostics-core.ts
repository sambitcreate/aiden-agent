const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;
const MAX_COUNTER_KEYS = 256;
const MAX_COUNTER_KEY_LENGTH = 96;
const MAX_EVENT_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_EVENT_COUNT = 1_000_000_000;

export const DIAGNOSTIC_EVENT_NAMES = [
  "startup.main_loaded",
  "startup.app_ready",
  "startup.window_created",
  "startup.navigation_started",
  "startup.window_ready",
  "startup.shell_painted",
  "startup.providers_ready",
  "startup.composer_ready",
  "main.event_loop_sample",
  "main.long_task",
  "renderer.long_task",
  "renderer.react_commit",
  "renderer.scheduler_snapshot",
  "renderer.unresponsive",
  "renderer.responsive",
  "renderer.process_gone",
  "child.process_gone",
  "process.error",
  "shutdown.timeout",
  "shutdown.complete",
  "crash_loop.state",
] as const;

export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENT_NAMES)[number];

export interface DiagnosticEventInput {
  name: DiagnosticEventName;
  durationMs?: number;
  count?: number;
  bytes?: number;
  state?: "active" | "complete" | "failed" | "recovered" | "unknown";
}

export interface DiagnosticEvent extends DiagnosticEventInput {
  sequence: number;
  monotonicMs: number;
}

export interface DiagnosticCounter {
  count: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
}

export interface DiagnosticSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sessionStartedAt: string;
  droppedEvents: number;
  droppedSeries: number;
  events: DiagnosticEvent[];
  counters: Record<string, DiagnosticCounter>;
  gauges: Record<string, { current: number; peak: number }>;
}

function boundedNumber(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, maximum);
}

function eventBytes(event: DiagnosticEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export function isSafeDiagnosticCounterKey(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_COUNTER_KEY_LENGTH && /^[a-zA-Z0-9:_-]+$/u.test(value)
  );
}

export class PerformanceDiagnosticBuffer {
  private readonly events: DiagnosticEvent[] = [];
  private readonly counters = new Map<string, DiagnosticCounter>();
  private readonly gauges = new Map<string, { current: number; peak: number }>();
  private eventByteLength = 0;
  private droppedEvents = 0;
  private droppedSeries = 0;
  private nextSequence = 1;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly maximumEvents = DEFAULT_MAX_EVENTS,
    private readonly maximumEventBytes = DEFAULT_MAX_EVENT_BYTES,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1) {
      throw new Error("Diagnostic event capacity must be a positive integer.");
    }
    if (!Number.isSafeInteger(maximumEventBytes) || maximumEventBytes < 1) {
      throw new Error("Diagnostic byte capacity must be a positive integer.");
    }
  }

  record(input: DiagnosticEventInput): void {
    if (!(DIAGNOSTIC_EVENT_NAMES as readonly string[]).includes(input.name)) return;
    const event: DiagnosticEvent = {
      sequence: this.nextSequence++,
      monotonicMs: Math.max(0, Math.round(this.monotonicNow() * 100) / 100),
      name: input.name,
      ...(boundedNumber(input.durationMs, MAX_EVENT_DURATION_MS) === undefined
        ? {}
        : { durationMs: boundedNumber(input.durationMs, MAX_EVENT_DURATION_MS) }),
      ...(boundedNumber(input.count, MAX_EVENT_COUNT) === undefined
        ? {}
        : { count: boundedNumber(input.count, MAX_EVENT_COUNT) }),
      ...(boundedNumber(input.bytes, Number.MAX_SAFE_INTEGER) === undefined
        ? {}
        : { bytes: boundedNumber(input.bytes, Number.MAX_SAFE_INTEGER) }),
      ...(input.state === "active" ||
      input.state === "complete" ||
      input.state === "failed" ||
      input.state === "recovered" ||
      input.state === "unknown"
        ? { state: input.state }
        : {}),
    };
    const bytes = eventBytes(event);
    if (bytes > this.maximumEventBytes) {
      this.droppedEvents += 1;
      return;
    }
    while (
      this.events.length > 0 &&
      (this.events.length >= this.maximumEvents ||
        this.eventByteLength + bytes > this.maximumEventBytes)
    ) {
      const removed = this.events.shift();
      if (removed) this.eventByteLength -= eventBytes(removed);
      this.droppedEvents += 1;
    }
    this.events.push(event);
    this.eventByteLength += bytes;
  }

  count(key: string, sample: Partial<DiagnosticCounter> & { count?: number } = {}): void {
    if (!isSafeDiagnosticCounterKey(key)) return;
    if (!this.counters.has(key) && this.counters.size >= MAX_COUNTER_KEYS) {
      this.droppedSeries += 1;
      return;
    }
    const current = this.counters.get(key) ?? {
      count: 0,
      errors: 0,
      bytesIn: 0,
      bytesOut: 0,
      durationMs: 0,
    };
    current.count = Math.min(
      MAX_EVENT_COUNT,
      current.count + (boundedNumber(sample.count ?? 1, MAX_EVENT_COUNT) ?? 0),
    );
    current.errors = Math.min(
      MAX_EVENT_COUNT,
      current.errors + (boundedNumber(sample.errors, MAX_EVENT_COUNT) ?? 0),
    );
    current.bytesIn = Math.min(
      Number.MAX_SAFE_INTEGER,
      current.bytesIn + (boundedNumber(sample.bytesIn, Number.MAX_SAFE_INTEGER) ?? 0),
    );
    current.bytesOut = Math.min(
      Number.MAX_SAFE_INTEGER,
      current.bytesOut + (boundedNumber(sample.bytesOut, Number.MAX_SAFE_INTEGER) ?? 0),
    );
    current.durationMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      current.durationMs + (boundedNumber(sample.durationMs, MAX_EVENT_DURATION_MS) ?? 0),
    );
    this.counters.set(key, current);
  }

  gauge(key: string, value: number): void {
    if (!isSafeDiagnosticCounterKey(key)) return;
    if (!this.gauges.has(key) && this.gauges.size >= MAX_COUNTER_KEYS) {
      this.droppedSeries += 1;
      return;
    }
    const current = boundedNumber(value, MAX_EVENT_COUNT);
    if (current === undefined) return;
    const previous = this.gauges.get(key);
    this.gauges.set(key, {
      current,
      peak: Math.max(previous?.peak ?? 0, current),
    });
  }

  snapshot(): DiagnosticSnapshot {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sessionStartedAt: this.startedAt,
      droppedEvents: this.droppedEvents,
      droppedSeries: this.droppedSeries,
      events: this.events.map((event) => ({ ...event })),
      counters: Object.fromEntries(
        [...this.counters.entries()].map(([key, value]) => [key, { ...value }]),
      ),
      gauges: Object.fromEntries(
        [...this.gauges.entries()].map(([key, value]) => [key, { ...value }]),
      ),
    };
  }
}

/**
 * Estimate a structured-clone payload without serializing or recursively
 * traversing attacker-controlled input. The result is intentionally
 * conservative and capped; it exists for aggregate diagnostics, not billing.
 */
export function estimateDiagnosticPayloadBytes(value: unknown, cap = 16 * 1024 * 1024): number {
  const maximumVisitedValues = 65_536;
  const maximumArrayEntries = 16_384;
  const maximumObjectKeys = 512;
  const seen = new Set<object>();
  let visited = 0;
  const visit = (candidate: unknown, depth: number): number => {
    if (depth > 8 || visited++ >= maximumVisitedValues) return cap;
    if (candidate === null || candidate === undefined) return 4;
    if (typeof candidate === "boolean" || typeof candidate === "number") return 8;
    if (typeof candidate === "bigint") return 16;
    if (typeof candidate === "string") return Math.min(cap, candidate.length * 3);
    if (candidate instanceof ArrayBuffer) return Math.min(cap, candidate.byteLength);
    if (ArrayBuffer.isView(candidate)) return Math.min(cap, candidate.byteLength);
    if (typeof candidate !== "object") return 16;
    if (seen.has(candidate)) return 0;
    seen.add(candidate);
    let total = 16;
    if (Array.isArray(candidate)) {
      const length = Math.min(candidate.length, maximumArrayEntries);
      for (let index = 0; index < length && total < cap; index += 1) {
        total += visit(candidate[index], depth + 1);
      }
      if (candidate.length > length) return cap;
      return Math.min(cap, total);
    }
    let keys = 0;
    for (const key in candidate as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      if (keys++ >= maximumObjectKeys || total >= cap) return cap;
      total += Math.min(cap, key.length * 3);
      total += visit((candidate as Record<string, unknown>)[key], depth + 1);
    }
    return Math.min(cap, total);
  };
  return Math.min(cap, visit(value, 0));
}
