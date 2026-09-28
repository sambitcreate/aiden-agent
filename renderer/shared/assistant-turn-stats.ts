// Content-free per-turn facts shown in the compact footer under an assistant
// response: how long the turn took and the provider-reported token usage. No
// prompt, response, or provider diagnostic ever enters this record.

import type { GenerationTimeline } from "./generation-timeline.js";

export const ASSISTANT_TURN_STATS_VERSION = 1 as const;

/** Provider-reported token totals summed across every request in one turn. */
export interface AssistantTurnUsageV1 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Model requests that reported usage; tool loops make several per turn. */
  requests: number;
}

export interface AssistantTurnStatsV1 {
  version: typeof ASSISTANT_TURN_STATS_VERSION;
  /** Host wall-clock bounds of the generation, in epoch milliseconds. */
  startedAt: number;
  finishedAt: number;
  /** Absent when the provider reported no usage (common for local runtimes). */
  usage?: AssistantTurnUsageV1;
}

/** Any usage shape with the Pi/usage-store token buckets. */
export interface TurnUsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const MAX_TOKEN_COUNT = 1_000_000_000_000;
const MAX_REQUESTS = 100_000;
const MAX_TURN_MS = 7 * 24 * 60 * 60 * 1_000;

function count(value: unknown, max = MAX_TOKEN_COUNT): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Folds one request's reported usage into the running turn total. */
export function addTurnUsage(
  total: AssistantTurnUsageV1 | undefined,
  sample: TurnUsageSample | null | undefined,
): AssistantTurnUsageV1 | undefined {
  if (!sample) return total;
  const clamp = (value: number) =>
    Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_TOKEN_COUNT) : 0;
  const base = total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 };
  return {
    input: Math.min(base.input + clamp(sample.input), MAX_TOKEN_COUNT),
    output: Math.min(base.output + clamp(sample.output), MAX_TOKEN_COUNT),
    cacheRead: Math.min(base.cacheRead + clamp(sample.cacheRead), MAX_TOKEN_COUNT),
    cacheWrite: Math.min(base.cacheWrite + clamp(sample.cacheWrite), MAX_TOKEN_COUNT),
    total: Math.min(base.total + clamp(sample.total), MAX_TOKEN_COUNT),
    requests: Math.min(base.requests + 1, MAX_REQUESTS),
  };
}

/** Strict replay of a stored record; anything malformed is dropped whole. */
export function parseAssistantTurnStatsV1(value: unknown): AssistantTurnStatsV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== ASSISTANT_TURN_STATS_VERSION ||
    !timestamp(record.startedAt) ||
    !timestamp(record.finishedAt) ||
    record.finishedAt < record.startedAt ||
    record.finishedAt - record.startedAt > MAX_TURN_MS
  ) {
    return undefined;
  }
  const stats: AssistantTurnStatsV1 = {
    version: ASSISTANT_TURN_STATS_VERSION,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
  if (record.usage === undefined) return stats;
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const tokens = usage as Record<string, unknown>;
  if (
    !count(tokens.input) ||
    !count(tokens.output) ||
    !count(tokens.cacheRead) ||
    !count(tokens.cacheWrite) ||
    !count(tokens.total) ||
    !count(tokens.requests, MAX_REQUESTS) ||
    tokens.requests === 0
  ) {
    return undefined;
  }
  stats.usage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    total: tokens.total,
    requests: tokens.requests,
  };
  return stats;
}

/** "830", "12.4k", "1.2M" — compact enough for a one-line footer. */
export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  // Switch units before rounding would print "1000k".
  if (value < 999_500) {
    const thousands = value / 1_000;
    return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions < 100 ? millions.toFixed(1).replace(/\.0$/u, "") : Math.round(millions)}M`;
}

/** "0.8s", "12s", "3m 5s", "1h 2m". */
export function formatTurnDuration(durationMs: number): string {
  if (durationMs < 10_000) {
    return `${Math.max(0.1, Math.round(durationMs / 100) / 10).toFixed(1).replace(/\.0$/u, "")}s`;
  }
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

export interface TurnFooterItem {
  kind: "duration" | "model" | "tokens";
  /** Compact visible text. */
  text: string;
  /** Full sentence for assistive technology and the hover title. */
  description: string;
}

/**
 * The footer's facts, in reading order. Each fact appears only when it is
 * actually known: duration from the recorded turn (or a settled timeline),
 * the model that produced the message, and provider-reported token usage.
 */
export function turnFooterItems(input: {
  turnStats?: AssistantTurnStatsV1;
  timeline?: GenerationTimeline | null;
  model?: string;
}): TurnFooterItem[] {
  const items: TurnFooterItem[] = [];
  const bounds = input.turnStats
    ? { startedAt: input.turnStats.startedAt, finishedAt: input.turnStats.finishedAt }
    : input.timeline && input.timeline.status !== "running" && input.timeline.finishedAt !== undefined
      ? { startedAt: input.timeline.startedAt, finishedAt: input.timeline.finishedAt }
      : undefined;
  if (bounds && bounds.finishedAt >= bounds.startedAt) {
    const text = formatTurnDuration(bounds.finishedAt - bounds.startedAt);
    items.push({ kind: "duration", text, description: `Took ${text}` });
  }
  const model = input.model?.trim();
  if (model) items.push({ kind: "model", text: model, description: `Model ${model}` });
  const usage = input.turnStats?.usage;
  if (usage && usage.total > 0) {
    const read = usage.input + usage.cacheRead + usage.cacheWrite;
    const text = `${formatTokenCount(read)} in · ${formatTokenCount(usage.output)} out`;
    const cached = usage.cacheRead > 0 ? `, ${usage.cacheRead.toLocaleString("en-US")} from cache` : "";
    const requests = usage.requests === 1 ? "1 request" : `${usage.requests} requests`;
    items.push({
      kind: "tokens",
      text,
      description: `${read.toLocaleString("en-US")} input tokens${cached}, ${usage.output.toLocaleString("en-US")} output tokens across ${requests}`,
    });
  }
  return items;
}
