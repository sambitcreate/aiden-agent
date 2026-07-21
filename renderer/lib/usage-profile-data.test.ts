import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActivityCalendar,
  buildTokenMix,
  formatTrackedUsd,
  profileInitials,
  rankUsageModels,
} from "./usage-profile-data.js";
import type { UsageModelSummary, UsageSummary, UsageTokenBreakdown } from "./types.js";

const emptyTokens = (): UsageTokenBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
});

function summary(): UsageSummary {
  return {
    range: "7d",
    startDate: "2026-07-15",
    endDate: "2026-07-21",
    totals: {
      requests: 3,
      completedRequests: 3,
      failedRequests: 0,
      cancelledRequests: 0,
      reportedTokenRequests: 1,
      unmeteredRequests: 2,
      localRequests: 2,
      costedRequests: 1,
      unpricedHostedRequests: 0,
      hostedCostUsd: 0.01,
      activeDays: 2,
      currentStreak: 1,
      longestStreak: 1,
      tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, total: 100 },
    },
    days: [
      {
        date: "2026-07-15",
        requests: 1,
        reportedTokenRequests: 1,
        unmeteredRequests: 0,
        tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, total: 100 },
        hostedCostUsd: 0.01,
      },
      {
        date: "2026-07-21",
        requests: 2,
        reportedTokenRequests: 0,
        unmeteredRequests: 2,
        tokens: emptyTokens(),
        hostedCostUsd: 0,
      },
    ],
    models: [],
  };
}

test("aligns activity to complete Sunday-through-Saturday weeks", () => {
  const calendar = buildActivityCalendar(summary());
  assert.equal(calendar.cells[0].date, "2026-07-12");
  assert.equal(calendar.cells[calendar.cells.length - 1]?.date, "2026-07-25");
  assert.equal(calendar.cells.length, 14);
  assert.equal(calendar.weekCount, 2);
  assert.equal(calendar.cells.find((cell) => cell.date === "2026-07-15")?.level, 3);
  assert.equal(calendar.cells.find((cell) => cell.date === "2026-07-21")?.level, 4);
  assert.equal(calendar.cells[0].inRange, false);
});

test("keeps leap days in UTC calendar ranges", () => {
  const leapSummary = summary();
  leapSummary.startDate = "2024-02-25";
  leapSummary.endDate = "2024-03-02";
  leapSummary.days = [];
  const calendar = buildActivityCalendar(leapSummary);
  assert.equal(calendar.cells.length, 7);
  assert.equal(calendar.cells[0]?.date, "2024-02-25");
  assert.equal(calendar.cells[4]?.date, "2024-02-29");
  assert.equal(calendar.cells[6]?.date, "2024-03-02");
});

test("keeps local unmetered models in request rankings", () => {
  const model = (patch: Partial<UsageModelSummary>): UsageModelSummary => ({
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "hosted",
    modelLabel: "Hosted",
    local: false,
    requests: 2,
    reportedTokenRequests: 2,
    unmeteredRequests: 0,
    tokens: { ...emptyTokens(), total: 100 },
    hostedCostUsd: 0.01,
    ...patch,
  });
  const ranked = rankUsageModels(
    [
      model({}),
      model({
        modelId: "local",
        modelLabel: "Local",
        local: true,
        requests: 5,
        reportedTokenRequests: 0,
        unmeteredRequests: 5,
        tokens: emptyTokens(),
        hostedCostUsd: 0,
      }),
    ],
    "requests",
  );
  assert.equal(ranked[0].modelId, "local");
  assert.equal(ranked.length, 2);

  const costRanked = rankUsageModels(
    [
      model({}),
      model({
        modelId: "local",
        modelLabel: "Local",
        local: true,
        requests: 5,
        reportedTokenRequests: 0,
        unmeteredRequests: 5,
        tokens: emptyTokens(),
        hostedCostUsd: 0,
      }),
      model({
        modelId: "unpriced",
        modelLabel: "Unpriced",
        hostedCostUsd: 0,
      }),
    ],
    "cost",
  );
  assert.deepEqual(
    costRanked.map((entry) => entry.modelId),
    ["hosted"],
  );
});

test("builds a mutually exclusive token mix and compact profile initials", () => {
  const tokens = summary().totals.tokens;
  assert.equal(
    buildTokenMix(tokens).reduce((total, item) => total + item.value, 0),
    tokens.total,
  );
  assert.equal(profileInitials("Sambit Biswas"), "SB");
  assert.equal(profileInitials("Aiden"), "A");
  assert.equal(formatTrackedUsd(0.005), "$0.0050");
  assert.equal(formatTrackedUsd(0.00001), "<$0.0001");
});
