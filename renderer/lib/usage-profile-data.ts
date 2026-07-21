import type {
  UsageDaySummary,
  UsageModelSummary,
  UsageSummary,
  UsageTokenBreakdown,
} from "./types";

const DAY_MS = 86_400_000;

export type UsageScoreMetric = "requests" | "tokens" | "cost";

export interface ActivityCell {
  date: string;
  inRange: boolean;
  requests: number;
  reportedTokens: number;
  unmeteredRequests: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityMonthLabel {
  label: string;
  weekIndex: number;
}

export interface ActivityCalendar {
  cells: ActivityCell[];
  months: ActivityMonthLabel[];
  weekCount: number;
}

export interface TokenMixItem {
  key: "input" | "output" | "cacheRead" | "cacheWrite";
  label: string;
  value: number;
}

function parseDateKey(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, count: number): Date {
  return new Date(date.getTime() + count * DAY_MS);
}

function activityLevel(day: UsageDaySummary | undefined, maxRequests: number): 0 | 1 | 2 | 3 | 4 {
  if (!day || day.requests === 0) return 0;
  if (maxRequests === 0) return 1;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(day.requests / maxRequests) * 4))) as
    | 1
    | 2
    | 3
    | 4;
}

export function buildActivityCalendar(summary: UsageSummary): ActivityCalendar {
  const rangeStart = parseDateKey(summary.startDate);
  const rangeEnd = parseDateKey(summary.endDate);
  const gridStart = addDays(rangeStart, -rangeStart.getUTCDay());
  const gridEnd = addDays(rangeEnd, 6 - rangeEnd.getUTCDay());
  const dayMap = new Map(summary.days.map((day) => [day.date, day]));
  const maxRequests = Math.max(0, ...summary.days.map((day) => day.requests));
  const cells: ActivityCell[] = [];
  const months = new Map<number, string>();

  for (let cursor = gridStart; cursor <= gridEnd; cursor = addDays(cursor, 1)) {
    const key = dateKey(cursor);
    const inRange = cursor >= rangeStart && cursor <= rangeEnd;
    const day = inRange ? dayMap.get(key) : undefined;
    const weekIndex = Math.floor(cells.length / 7);
    if (inRange && (cells.length === rangeStart.getUTCDay() || cursor.getUTCDate() === 1)) {
      months.set(
        weekIndex,
        cursor.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      );
    }
    cells.push({
      date: key,
      inRange,
      requests: day?.requests ?? 0,
      reportedTokens: day?.tokens.total ?? 0,
      unmeteredRequests: day?.unmeteredRequests ?? 0,
      level: inRange ? activityLevel(day, maxRequests) : 0,
    });
  }

  return {
    cells,
    months: [...months].map(([weekIndex, label]) => ({ weekIndex, label })),
    weekCount: Math.ceil(cells.length / 7),
  };
}

function scoreForModel(model: UsageModelSummary, metric: UsageScoreMetric): number {
  if (metric === "tokens") return model.tokens.total;
  if (metric === "cost") return model.hostedCostUsd;
  return model.requests;
}

export function rankUsageModels(
  models: UsageModelSummary[],
  metric: UsageScoreMetric,
): UsageModelSummary[] {
  const eligible =
    metric === "cost" ? models.filter((model) => !model.local && model.hostedCostUsd > 0) : models;
  return [...eligible].sort((left, right) => {
    const scoreDifference = scoreForModel(right, metric) - scoreForModel(left, metric);
    if (scoreDifference !== 0) return scoreDifference;
    const requestDifference = right.requests - left.requests;
    if (requestDifference !== 0) return requestDifference;
    return left.modelLabel.localeCompare(right.modelLabel);
  });
}

export function usageModelScore(model: UsageModelSummary, metric: UsageScoreMetric): number {
  return scoreForModel(model, metric);
}

export function buildTokenMix(tokens: UsageTokenBreakdown): TokenMixItem[] {
  return [
    { key: "input", label: "Fresh input", value: tokens.input },
    { key: "output", label: "Output", value: tokens.output },
    { key: "cacheRead", label: "Cache read", value: tokens.cacheRead },
    { key: "cacheWrite", label: "Cache write", value: tokens.cacheWrite },
  ];
}

export function formatTrackedUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  const fractionDigits = value > 0 && value < 0.01 ? 4 : 2;
  return Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function profileInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "A";
  const selected = words.length === 1 ? words : [words[0], words[words.length - 1] ?? ""];
  return selected
    .map((word) => [...word][0] ?? "")
    .join("")
    .toLocaleUpperCase();
}
