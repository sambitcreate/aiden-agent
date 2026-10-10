import assert from "node:assert/strict";
import test from "node:test";
import { formatListPrice, isOlderThanDays, showsListPrice } from "./model-details";

test("list prices use cents under a dollar and trim whole and half dollars", () => {
  assert.equal(formatListPrice({ input: 0.15, output: 0.6 }), "$0.15 / $0.60 per 1M");
  assert.equal(formatListPrice({ input: 3, output: 15 }), "$3 / $15 per 1M");
  assert.equal(formatListPrice({ input: 2.5, output: 10.125 }), "$2.5 / $10.13 per 1M");
  // Below a cent, three significant digits rather than "$0.00".
  assert.equal(formatListPrice({ input: 0.004, output: 0.00125 }), "$0.004 / $0.00125 per 1M");
});

test("a list price with both sides at zero is free; a one-sided price names its side", () => {
  assert.equal(formatListPrice({ input: 0, output: 0 }), "Free");
  // A free side of a two-sided price says so rather than "$0.00".
  assert.equal(formatListPrice({ input: 0, output: 5 }), "Free in / $5 out per 1M");
  assert.equal(formatListPrice({ input: 0.15, output: 0 }), "$0.15 in / Free out per 1M");
  assert.equal(formatListPrice({ input: 1.25 }), "$1.25 in per 1M");
  assert.equal(formatListPrice({ output: 0.4, cacheRead: 0.1 }), "$0.40 out per 1M");
  assert.equal(formatListPrice({ input: 0 }), "Free in");
  assert.equal(formatListPrice({ output: 0 }), "Free out");
  assert.equal(formatListPrice({ cacheRead: 0.1 }), undefined);
  assert.equal(formatListPrice(undefined), undefined);
});

test("list price shows only for hosted, per-token, catalog-backed providers", () => {
  assert.equal(showsListPrice({ providerId: "anthropic", isLocal: false }), true);
  assert.equal(showsListPrice({ providerId: "openai", isLocal: false }), true);
  // A ChatGPT sign-in isn't billed per token.
  assert.equal(showsListPrice({ providerId: "openai-codex", isLocal: false }), false);
  // A custom endpoint can inherit a public row's price that doesn't apply to it.
  assert.equal(showsListPrice({ providerId: "my-gateway", isLocal: false }), false);
  // Private deployments under a catalog id are not billed at list price either.
  assert.equal(showsListPrice({ providerId: "openai", isLocal: true }), false);
  assert.equal(showsListPrice({ providerId: "constructor", isLocal: false }), false);
});

test("a date is older than N days only past that many whole days before now", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(isOlderThanDays("2026-08-10T12:00:00Z", 60, now), false, "exactly 60 days");
  assert.equal(isOlderThanDays("2026-08-10T11:59:59Z", 60, now), true);
  assert.equal(isOlderThanDays("2026-10-01", 60, now), false);
  assert.equal(isOlderThanDays("2025-01-01", 60, now), true);
  assert.equal(isOlderThanDays("not a date", 60, now), false);
  assert.equal(isOlderThanDays(undefined, 60, now), false);
});
