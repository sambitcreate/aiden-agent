import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageSummary } from "../../lib/types.js";
import { ProfileShareCard } from "./profile-share-card.js";

const summary: UsageSummary = {
  range: "all",
  startDate: "2024-01-01",
  endDate: "2026-07-21",
  totals: {
    requests: 4,
    completedRequests: 4,
    failedRequests: 0,
    cancelledRequests: 0,
    reportedTokenRequests: 4,
    unmeteredRequests: 0,
    localRequests: 0,
    costedRequests: 4,
    unpricedHostedRequests: 0,
    hostedCostUsd: 0.01,
    activeDays: 1,
    currentStreak: 1,
    longestStreak: 1,
    tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, total: 100 },
  },
  days: [
    {
      date: "2026-07-21",
      requests: 4,
      reportedTokenRequests: 4,
      unmeteredRequests: 0,
      tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, total: 100 },
      hostedCostUsd: 0.01,
    },
  ],
  models: [
    {
      providerId: "private-provider-id",
      providerLabel: "Private\u202E provider label that is deliberately far too long",
      modelId: "private-model-id",
      modelLabel: "A model label that is deliberately far too long for the panel",
      local: false,
      requests: 4,
      reportedTokenRequests: 4,
      unmeteredRequests: 0,
      tokens: { input: 70, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 5, total: 100 },
      hostedCostUsd: 0.01,
    },
  ],
};

test("renders a self-contained, bounded 3:4 SVG share preview", () => {
  const markup = renderToStaticMarkup(
    <ProfileShareCard
      name={`${"Wide name ".repeat(8)}\u202E`}
      summary={summary}
      dark={false}
      accent="#138af2"
    />,
  );

  assert.match(markup, /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(markup, /width="1200"/u);
  assert.match(markup, /height="1600"/u);
  assert.match(markup, /viewBox="0 0 1200 1600"/u);
  assert.match(markup, /profile-share-name-clip/u);
  assert.match(markup, /profile-share-model-clip/u);
  assert.doesNotMatch(markup, /\u202e/iu);
  assert.doesNotMatch(markup, /private-provider-id|private-model-id/u);
  assert.doesNotMatch(markup, /<foreignObject|href=|<script/iu);
});
