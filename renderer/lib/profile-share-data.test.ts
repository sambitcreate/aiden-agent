import assert from "node:assert/strict";
import test from "node:test";
import { buildProfileShareData } from "./profile-share-data.js";
import type { UsageModelSummary, UsageSummary, UsageTokenBreakdown } from "./types.js";

const emptyTokens = (): UsageTokenBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
});

function model(patch: Partial<UsageModelSummary>): UsageModelSummary {
  return {
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "hosted",
    modelLabel: "Hosted",
    local: false,
    requests: 4,
    reportedTokenRequests: 4,
    unmeteredRequests: 0,
    tokens: { ...emptyTokens(), total: 100 },
    hostedCostUsd: 0.02,
    ...patch,
  };
}

function allTimeSummary(): UsageSummary {
  return {
    range: "all",
    startDate: "2024-01-01",
    endDate: "2026-07-21",
    totals: {
      requests: 13,
      completedRequests: 13,
      failedRequests: 0,
      cancelledRequests: 0,
      reportedTokenRequests: 4,
      unmeteredRequests: 9,
      localRequests: 9,
      costedRequests: 4,
      unpricedHostedRequests: 0,
      hostedCostUsd: 0.02,
      activeDays: 2,
      currentStreak: 1,
      longestStreak: 1,
      tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, total: 100 },
    },
    days: [
      {
        date: "2024-01-01",
        requests: 4,
        reportedTokenRequests: 4,
        unmeteredRequests: 0,
        tokens: { ...emptyTokens(), total: 100 },
        hostedCostUsd: 0.02,
      },
      {
        date: "2026-07-21",
        requests: 9,
        reportedTokenRequests: 0,
        unmeteredRequests: 9,
        tokens: emptyTokens(),
        hostedCostUsd: 0,
      },
    ],
    models: [
      model({}),
      model({
        providerId: "ollama",
        providerLabel: "Ollama",
        modelId: "local",
        modelLabel: "Local",
        local: true,
        requests: 9,
        reportedTokenRequests: 0,
        unmeteredRequests: 9,
        tokens: emptyTokens(),
        hostedCostUsd: 0,
      }),
    ],
  };
}

test("builds a curated all-time share summary with a latest-year heatmap", () => {
  const data = buildProfileShareData("Sambit Biswas", allTimeSummary());
  assert.equal(data.rangeLabel, "All time");
  assert.equal(data.activityRangeLabel, "Latest year activity");
  assert.equal(data.activityActiveDays, "1");
  assert.ok(data.calendar.weekCount <= 53);
  assert.equal(
    data.calendar.cells.some((cell) => cell.date === "2024-01-01"),
    false,
  );
  assert.equal(data.topModels[0].modelId, "local");
  assert.equal(
    data.tokenMix.reduce((total, item) => total + item.value, 0),
    100,
  );
  assert.equal(data.tokenCoverage, "31%");
});

test("keeps shorter selected ranges intact and compacts long streak values", () => {
  const summary = allTimeSummary();
  summary.range = "90d";
  summary.startDate = "2026-04-23";
  summary.days = summary.days.filter((day) => day.date >= summary.startDate);
  summary.totals.currentStreak = 12_345;
  summary.totals.longestStreak = 98_765;

  const data = buildProfileShareData("Sambit Biswas", summary);
  assert.equal(data.rangeLabel, "90 days");
  assert.equal(data.activityRangeLabel, "90 days activity");
  assert.equal(data.calendar.weekCount <= 14, true);
  assert.equal(data.currentStreak, "12.3K days");
  assert.equal(data.longestStreak, "98.8K days");
});

test("labels a new all-time profile as all-time activity when it does not need clipping", () => {
  const summary = allTimeSummary();
  summary.startDate = "2026-07-01";
  summary.days = summary.days.filter((day) => day.date >= summary.startDate);
  const data = buildProfileShareData("Sambit Biswas", summary);
  assert.equal(data.activityRangeLabel, "All time activity");
});
