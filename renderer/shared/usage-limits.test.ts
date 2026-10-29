import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUsageLimitTime,
  parseUsageLimitWaits,
  usageLimitWaitFor,
  usageLimitWaitLabel,
  type UsageLimitWaitView,
} from "./usage-limits.js";

const NOW = Date.UTC(2026, 9, 26, 15, 0);
const zone = { locale: "en-US", timeZone: "UTC" };
const wait = (over: Partial<UsageLimitWaitView> = {}): UsageLimitWaitView => ({
  ownerKind: "chat",
  ownerId: "chat-1",
  providerLabel: "Claude",
  modelId: "opus",
  nextTryAt: Date.UTC(2026, 9, 26, 15, 40),
  trying: false,
  ...over,
});

test("a reset reads as a time today, a weekday this week, else a date", () => {
  assert.equal(formatUsageLimitTime(Date.UTC(2026, 9, 26, 15, 40), NOW, zone), "at 3:40 PM");
  assert.equal(formatUsageLimitTime(Date.UTC(2026, 9, 29, 9, 0), NOW, zone), "Thursday at 9:00 AM");
  assert.equal(formatUsageLimitTime(Date.UTC(2026, 10, 9, 9, 0), NOW, zone), "Nov 9 at 9:00 AM");
});

test("a waiting reply says whose limit and when it tries next, then that it is trying", () => {
  assert.equal(usageLimitWaitLabel(wait(), NOW, zone), "Waiting for Claude’s usage limit · next try at 3:40 PM");
  assert.equal(usageLimitWaitLabel(wait({ trying: true }), NOW, zone), "Trying Claude again…");
  assert.equal(usageLimitWaitLabel(wait({ nextTryAt: NOW - 1 }), NOW, zone), "Trying Claude again…");
  assert.equal(usageLimitWaitLabel(wait({ providerLabel: " " }), NOW, zone), "Waiting for the provider’s usage limit · next try at 3:40 PM");
});

test("each chat shows its own soonest wait, a test request first", () => {
  const waits = [
    wait({ ownerId: "chat-2", nextTryAt: NOW + 1 }),
    wait({ nextTryAt: NOW + 60_000 }),
    wait({ nextTryAt: NOW + 30_000 }),
  ];
  assert.equal(usageLimitWaitFor(waits, "chat", "chat-1")?.nextTryAt, NOW + 30_000);
  assert.equal(usageLimitWaitFor([...waits, wait({ nextTryAt: NOW + 90_000, trying: true })], "chat", "chat-1")?.trying, true);
  assert.equal(usageLimitWaitFor(waits, "bot", "chat-1"), undefined);
});

test("waits from main are read strictly and a bad one is dropped", () => {
  const good = wait({ resetAt: NOW + 1 });
  assert.deepEqual(parseUsageLimitWaits([good, { ...good, ownerKind: "team" }, { ...good, nextTryAt: -1 }, "x"]), [good]);
  assert.deepEqual(parseUsageLimitWaits({}), []);
});
