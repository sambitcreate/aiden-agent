import assert from "node:assert/strict";
import test from "node:test";
import {
  addTurnUsage,
  formatTokenCount,
  formatTurnDuration,
  parseAssistantTurnStatsV1,
  turnFooterItems,
} from "./assistant-turn-stats.js";
import type { GenerationTimeline } from "./generation-timeline.js";

const sample = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  total: input + output + cacheRead + cacheWrite,
});

test("a tool loop's usage is summed across every request in the turn", () => {
  let usage = addTurnUsage(undefined, sample(1_000, 50, 4_000));
  usage = addTurnUsage(usage, null); // A request with no reported usage.
  usage = addTurnUsage(usage, sample(200, 400, 5_000, 300));
  assert.deepEqual(usage, {
    input: 1_200,
    output: 450,
    cacheRead: 9_000,
    cacheWrite: 300,
    total: 10_950,
    requests: 2,
  });
  // Nothing reported at all stays unknown rather than becoming zero.
  assert.equal(addTurnUsage(undefined, null), undefined);
});

test("provider noise never produces negative or fractional counts", () => {
  const usage = addTurnUsage(undefined, {
    input: -5,
    output: 12.7,
    cacheRead: Number.NaN,
    cacheWrite: Number.POSITIVE_INFINITY,
    total: 12.7,
  });
  assert.deepEqual(usage, { input: 0, output: 12, cacheRead: 0, cacheWrite: 0, total: 12, requests: 1 });
});

test("stored stats replay only when every field is plausible", () => {
  const valid = {
    version: 1,
    startedAt: 1_000,
    finishedAt: 4_000,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, requests: 1 },
  };
  assert.deepEqual(parseAssistantTurnStatsV1(valid), valid);
  assert.deepEqual(parseAssistantTurnStatsV1({ version: 1, startedAt: 1_000, finishedAt: 1_000 }), {
    version: 1,
    startedAt: 1_000,
    finishedAt: 1_000,
  });
  // Extra keys (for example a smuggled prompt) are not carried forward.
  const withExtra = parseAssistantTurnStatsV1({ ...valid, prompt: "secret" });
  assert.equal(withExtra && "prompt" in withExtra, false);

  for (const malformed of [
    null,
    [],
    "stats",
    { ...valid, version: 2 },
    { ...valid, finishedAt: 500 },
    { ...valid, startedAt: Number.NaN },
    { ...valid, finishedAt: 1_000 + 8 * 24 * 60 * 60 * 1_000 },
    { ...valid, usage: { ...valid.usage, output: -1 } },
    { ...valid, usage: { ...valid.usage, input: 1.5 } },
    { ...valid, usage: { ...valid.usage, requests: 0 } },
    { ...valid, usage: "lots" },
  ]) {
    assert.equal(parseAssistantTurnStatsV1(malformed), undefined, JSON.stringify(malformed));
  }
});

test("token counts and durations stay short enough for one footer line", () => {
  assert.equal(formatTokenCount(830), "830");
  assert.equal(formatTokenCount(1_000), "1k");
  assert.equal(formatTokenCount(12_400), "12.4k");
  assert.equal(formatTokenCount(245_000), "245k");
  assert.equal(formatTokenCount(999_999), "1M");
  assert.equal(formatTokenCount(1_250_000), "1.3M");

  assert.equal(formatTurnDuration(0), "0.1s");
  assert.equal(formatTurnDuration(840), "0.8s");
  assert.equal(formatTurnDuration(5_000), "5s");
  assert.equal(formatTurnDuration(12_400), "12s");
  assert.equal(formatTurnDuration(185_000), "3m 5s");
  assert.equal(formatTurnDuration(120_000), "2m");
  assert.equal(formatTurnDuration(3_720_000), "1h 2m");
});

test("the footer lists only facts that are actually known", () => {
  const items = turnFooterItems({
    model: "  gpt-5  ",
    turnStats: {
      version: 1,
      startedAt: 0,
      finishedAt: 3_000,
      usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, total: 1_020, requests: 1 },
    },
  });
  assert.deepEqual(
    items.map((item) => [item.kind, item.text]),
    [
      ["duration", "3s"],
      ["model", "gpt-5"],
      ["tokens", "1k in · 20 out"],
    ],
  );
  assert.equal(
    items[2]!.description,
    "1,000 input tokens, 900 from cache, 20 output tokens across 1 request",
  );

  // A local runtime that reports zero usage shows no misleading "0 in".
  const zero = turnFooterItems({
    turnStats: {
      version: 1,
      startedAt: 0,
      finishedAt: 1_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 1 },
    },
  });
  assert.deepEqual(zero.map((item) => item.kind), ["duration"]);
  assert.deepEqual(turnFooterItems({ model: " " }), []);
});

test("older messages fall back to a settled timeline for duration", () => {
  const timeline = (status: GenerationTimeline["status"], finishedAt?: number): GenerationTimeline => ({
    version: 3,
    generationId: "g",
    status,
    startedAt: 1_000,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    steps: [],
  });
  assert.deepEqual(
    turnFooterItems({ timeline: timeline("completed", 46_000) }).map((item) => item.text),
    ["45s"],
  );
  assert.deepEqual(turnFooterItems({ timeline: timeline("running") }), []);
});
