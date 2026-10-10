// Device-local model pace: time to first token and output speed measured from
// the user's own chat responses. Nothing here is transmitted. The values are
// display-only and must never change runtime limits, routing or inventory.

import * as fs from "node:fs/promises";
import type { ModelPaceSummary } from "../../renderer/shared/model-pace.js";
import { DataStore } from "./data-store.js";

export const MODEL_PACE_FILE = "model-pace.json";
export const MODEL_PACE_SAMPLES_PER_MODEL = 20;
export const MODEL_PACE_MAX_MODELS = 500;
export const MODEL_PACE_MIN_OUTPUT_TOKENS = 16;
export const MODEL_PACE_MIN_GENERATION_MS = 250;
export const MODEL_PACE_PERSIST_DEBOUNCE_MS = 5_000;
const MODEL_PACE_MAX_BYTES = 2 * 1024 * 1024;

/** Stop reasons of a response that completed; failures and partial states are excluded. */
const COMPLETED_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length", "toolUse"]);

export interface ModelPaceSample {
  ttftMs: number;
  tokensPerSecond: number;
  /** Wall-clock epoch milliseconds when the response finished. */
  at: number;
}

export interface ModelPaceDocument {
  version: 1;
  models: Record<string, { samples: ModelPaceSample[] }>;
}

export type { ModelPaceSummary };

export interface ModelPaceTiming {
  /** Monotonic ms when the model request for this response started. */
  requestStartedAt: number;
  /** Monotonic ms of the first text or thinking delta, if any arrived. */
  firstDeltaAt: number | undefined;
  /** Monotonic ms when the response ended. */
  endedAt: number;
  outputTokens: number;
  stopReason: string;
  /** Wall-clock epoch ms stored as the sample time. */
  at: number;
}

export function emptyModelPaceDocument(): ModelPaceDocument {
  return { version: 1, models: {} };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidSample(value: unknown): value is ModelPaceSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  return (
    isFiniteNonNegative(sample.ttftMs) &&
    isFiniteNonNegative(sample.tokensPerSecond) &&
    sample.tokensPerSecond > 0 &&
    isFiniteNonNegative(sample.at)
  );
}

/** A `${providerId}::${modelId}` key with both parts present. */
export function isModelPaceKey(value: string): boolean {
  const separator = value.indexOf("::");
  return separator > 0 && separator + 2 < value.length && value.length <= 512;
}

/**
 * Turn one response's timing into a sample, or null when it is not a usable
 * measurement: a failed or unfinished response, fewer than 16 output tokens,
 * no streamed text/thinking, or under 250 ms of generation.
 */
export function acceptModelPaceSample(timing: ModelPaceTiming): ModelPaceSample | null {
  const { requestStartedAt, firstDeltaAt, endedAt, outputTokens, stopReason, at } = timing;
  if (!COMPLETED_STOP_REASONS.has(stopReason)) return null;
  if (!isFiniteNonNegative(outputTokens) || outputTokens < MODEL_PACE_MIN_OUTPUT_TOKENS) return null;
  if (firstDeltaAt === undefined) return null;
  if (![requestStartedAt, firstDeltaAt, endedAt, at].every(isFiniteNonNegative)) return null;
  const ttftMs = firstDeltaAt - requestStartedAt;
  const generationMs = endedAt - firstDeltaAt;
  if (ttftMs < 0 || generationMs < MODEL_PACE_MIN_GENERATION_MS) return null;
  return {
    ttftMs: Math.round(ttftMs),
    tokensPerSecond: outputTokens / (generationMs / 1_000),
    at,
  };
}

function lastSampledAt(entry: { samples: ModelPaceSample[] }): number {
  return entry.samples.reduce((latest, sample) => Math.max(latest, sample.at), 0);
}

/** Append a sample, keep the last 20 per model and the 500 most recently sampled models. */
export function addModelPaceSample(
  document: ModelPaceDocument,
  key: string,
  sample: ModelPaceSample,
): ModelPaceDocument {
  const previous = document.models[key]?.samples ?? [];
  const models = {
    ...document.models,
    [key]: { samples: [...previous, sample].slice(-MODEL_PACE_SAMPLES_PER_MODEL) },
  };
  const keys = Object.keys(models);
  if (keys.length <= MODEL_PACE_MAX_MODELS) return { version: 1, models };
  const kept = keys
    .map((candidate) => ({ candidate, last: lastSampledAt(models[candidate]!) }))
    .sort((a, b) => b.last - a.last)
    .slice(0, MODEL_PACE_MAX_MODELS);
  return {
    version: 1,
    models: Object.fromEntries(kept.map(({ candidate }) => [candidate, models[candidate]!])),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeModelPace(document: ModelPaceDocument): Record<string, ModelPaceSummary> {
  const summaries: Record<string, ModelPaceSummary> = {};
  for (const [key, entry] of Object.entries(document.models)) {
    if (entry.samples.length === 0) continue;
    summaries[key] = {
      medianTtftMs: median(entry.samples.map((sample) => sample.ttftMs)),
      medianTokensPerSecond: median(entry.samples.map((sample) => sample.tokensPerSecond)),
      sampleCount: entry.samples.length,
      lastSampledAt: lastSampledAt(entry),
    };
  }
  return summaries;
}

/** Strict reader: any unexpected shape throws so the store fails closed to empty. */
export function parseModelPaceDocument(value: unknown): ModelPaceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model pace data must be an object.");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== 1) throw new Error("Model pace data version is invalid.");
  const models = document.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new Error("Model pace models are invalid.");
  }
  const entries = Object.entries(models as Record<string, unknown>);
  if (entries.length > MODEL_PACE_MAX_MODELS) throw new Error("Model pace data has too many models.");
  const parsed: ModelPaceDocument["models"] = {};
  for (const [key, entry] of entries) {
    if (!isModelPaceKey(key)) throw new Error("Model pace key is invalid.");
    const samples = (entry as { samples?: unknown } | null)?.samples;
    if (
      !Array.isArray(samples) ||
      samples.length > MODEL_PACE_SAMPLES_PER_MODEL ||
      !samples.every(isValidSample)
    ) {
      throw new Error("Model pace samples are invalid.");
    }
    parsed[key] = {
      samples: samples.map(({ ttftMs, tokensPerSecond, at }) => ({ ttftMs, tokensPerSecond, at })),
    };
  }
  return { version: 1, models: parsed };
}

export interface ModelPacePersistence {
  load(): Promise<ModelPaceDocument>;
  save(document: ModelPaceDocument): Promise<void>;
  remove(): Promise<void>;
}

/** `userData/model-pace.json`, owner-only; unreadable or invalid files read as empty. */
export function createModelPacePersistence(root?: () => string): ModelPacePersistence {
  const store = new DataStore<ModelPaceDocument>(MODEL_PACE_FILE, emptyModelPaceDocument(), root, {
    maxBytes: MODEL_PACE_MAX_BYTES,
    fileMode: 0o600,
    compact: true,
    normalize: parseModelPaceDocument,
    // Regenerable measurements; a rescue copy of a bad file would only litter.
    preserveCorruptFile: false,
  });
  return {
    load: () => store.load(),
    save: (document) => store.save(document),
    remove: async () => {
      await fs.rm(await store.path(), { force: true });
    },
  };
}

/** The subset of Pi agent events the timer reads. */
export interface ModelPaceAgentEvent {
  type: string;
  assistantMessageEvent?: { type: string };
  message?: { role?: string; stopReason?: string; usage?: { output?: number } };
}

/**
 * Times one model response at a time within a generation.
 *
 * `requestStarted` must be called when Pi invokes the stream function for a
 * model request — after context transforms and compaction, immediately before
 * the provider request is sent. TTFT is measured from there to the first text
 * or thinking delta, so it includes connection, queueing and any hidden
 * reasoning the provider does not stream. Generation time runs from that delta
 * to the assistant `message_end`. Tool execution between responses is never
 * counted, because each response needs its own `requestStarted`.
 */
export class ModelPaceTimer {
  private current: { key: string; startedAt: number; firstDeltaAt?: number } | null = null;

  constructor(
    private readonly clock: { monotonic: () => number; wall: () => number } = {
      monotonic: () => performance.now(),
      wall: () => Date.now(),
    },
  ) {}

  requestStarted(key: string): void {
    this.current = { key, startedAt: this.clock.monotonic() };
  }

  /** Returns the measured sample when an accepted assistant response ends. */
  observe(event: ModelPaceAgentEvent): { key: string; sample: ModelPaceSample } | null {
    const current = this.current;
    if (!current) return null;
    if (event.type === "message_update") {
      const kind = event.assistantMessageEvent?.type;
      if (current.firstDeltaAt === undefined && (kind === "text_delta" || kind === "thinking_delta")) {
        current.firstDeltaAt = this.clock.monotonic();
      }
      return null;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return null;
    this.current = null;
    const sample = acceptModelPaceSample({
      requestStartedAt: current.startedAt,
      firstDeltaAt: current.firstDeltaAt,
      endedAt: this.clock.monotonic(),
      outputTokens: event.message.usage?.output ?? Number.NaN,
      stopReason: event.message.stopReason ?? "",
      at: this.clock.wall(),
    });
    return sample ? { key: current.key, sample } : null;
  }
}

export interface ModelPaceRecorderOptions {
  debounceMs?: number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

/**
 * Keeps samples in memory and persists them at most once per debounce window
 * (and on flush). `record` never throws, so measuring can't disturb a chat.
 */
export class ModelPaceRecorder {
  private document: ModelPaceDocument | null = null;
  private loading: Promise<ModelPaceDocument> | null = null;
  private epoch = 0;
  private dirty = false;
  private timer: unknown = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly persistence: ModelPacePersistence,
    options: ModelPaceRecorderOptions = {},
  ) {
    this.debounceMs = Math.max(options.debounceMs ?? MODEL_PACE_PERSIST_DEBOUNCE_MS, MODEL_PACE_PERSIST_DEBOUNCE_MS);
    this.schedule =
      options.schedule ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        return handle;
      });
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.onError = options.onError ?? (() => {});
  }

  private loaded(): Promise<ModelPaceDocument> {
    if (this.document) return Promise.resolve(this.document);
    this.loading ??= this.persistence
      .load()
      .catch((error: unknown) => {
        this.onError(error);
        return emptyModelPaceDocument();
      })
      .then((document) => {
        this.document ??= document;
        return this.document;
      });
    return this.loading;
  }

  record(key: string, sample: ModelPaceSample): void {
    try {
      if (!isModelPaceKey(key) || !isValidSample(sample)) return;
      const epoch = this.epoch;
      void this.loaded()
        .then((document) => {
          if (epoch !== this.epoch) return;
          this.document = addModelPaceSample(this.document ?? document, key, sample);
          this.dirty = true;
          if (this.timer === null) {
            this.timer = this.schedule(() => {
              this.timer = null;
              void this.persist();
            }, this.debounceMs);
          }
        })
        .catch((error: unknown) => this.onError(error));
    } catch (error) {
      this.onError(error);
    }
  }

  private persist(): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (!this.dirty || !this.document) return;
      this.dirty = false;
      try {
        await this.persistence.save(this.document);
      } catch (error) {
        this.onError(error);
      }
    });
    return this.tail;
  }

  async summaries(): Promise<Record<string, ModelPaceSummary>> {
    return summarizeModelPace(await this.loaded());
  }

  /** Persist pending samples now (app quit). */
  async flush(): Promise<void> {
    // Let records already waiting on the initial load land first.
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    await this.persist();
  }

  /** Forget every measurement and delete the file. Rejects if the file could not be removed. */
  async clear(): Promise<void> {
    this.epoch += 1;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.document = emptyModelPaceDocument();
    this.dirty = false;
    const removal = this.tail.then(() => this.persistence.remove());
    this.tail = removal.catch(() => undefined);
    await removal;
  }
}
