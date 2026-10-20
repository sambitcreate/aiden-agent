import assert from "node:assert/strict";
import test from "node:test";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import { EXPIRED_CACHE_RETURN_GRACE_MS, ExpiredCacheReturns, promptCacheExpiresAt } from "./expired-cache-return";

const MINUTE = 60_000;
const LAST_REQUEST = 1_000_000;
const AFTER_EXPIRY = LAST_REQUEST + 6 * MINUTE;

function pressure(overrides: Partial<ChatContextPressureV1> = {}): ChatContextPressureV1 {
  return {
    contextTokens: 140_000,
    contextWindow: 1_000_000,
    inputBudgetTokens: 900_000,
    reservedTokens: 100_000,
    percentOfWindow: 14,
    percentOfUsableInput: 15,
    shouldCompact: false,
    messageTokens: 120_000,
    staticTokens: 20_000,
    compressibleHistoryMessages: 40,
    source: "provider-anchored",
    computedAt: AFTER_EXPIRY,
    promptCache: { ttlMs: 5 * MINUTE, lastRequestAt: LAST_REQUEST },
    ...overrides,
  };
}

const vcc = (reading: ChatContextPressureV1 | null, now = AFTER_EXPIRY, idle = true) => ({
  pressure: reading,
  engine: "vcc" as const,
  idle,
  now,
});
const llm = (reading: ChatContextPressureV1 | null, now = AFTER_EXPIRY, idle = true) => ({
  pressure: reading,
  engine: "llm" as const,
  idle,
  now,
});

/** A fresh tracker over in-memory storage, so restarts can be simulated. */
function tracker(saved: { value: Record<string, number> } = { value: {} }) {
  return new ExpiredCacheReturns({ load: () => ({ ...saved.value }), save: (handled) => { saved.value = handled; } });
}

test("returning to a large chat after its cache expired compacts with pi-vcc exactly once", () => {
  const returns = tracker();
  returns.returned("chat", AFTER_EXPIRY);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure())), true);
  // Later renders in the same return do nothing while the compaction runs.
  assert.equal(returns.takeAutomatic("chat", vcc(pressure())), false);
  returns.settle("chat", pressure(), AFTER_EXPIRY + 2_000);
  // Later focus changes and keystrokes in the same window do nothing either.
  returns.returned("chat", AFTER_EXPIRY + 1);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure({ contextTokens: 120_000 }), AFTER_EXPIRY + 1)), false);
  // A new request opens a new window, which expires and compacts again on return.
  const later = pressure({ promptCache: { ttlMs: 5 * MINUTE, lastRequestAt: LAST_REQUEST + 20 * MINUTE } });
  returns.returned("chat", LAST_REQUEST + 30 * MINUTE);
  assert.equal(returns.takeAutomatic("chat", vcc(later, LAST_REQUEST + 30 * MINUTE)), true);
});

test("a compaction that never ran is retried on the next return, and one while warm settles nothing", () => {
  const returns = tracker();
  returns.returned("chat", AFTER_EXPIRY);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure())), true);
  // The compaction could not start (another session command held it): no settle.
  returns.returned("chat", AFTER_EXPIRY + MINUTE);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure(), AFTER_EXPIRY + MINUTE)), true);

  // A manual /compact before expiry leaves the coming expiry to its own return.
  const warm = tracker();
  warm.settle("chat", pressure(), LAST_REQUEST + MINUTE);
  warm.returned("chat", AFTER_EXPIRY);
  assert.deepEqual(warm.offer("chat", llm(pressure())), { contextTokens: 140_000 });
});

test("expiry while the user stays never compacts or offers; only a later return does", () => {
  const returns = tracker();
  // Opened while the cache was still warm, then sat idle past expiry.
  returns.returned("chat", LAST_REQUEST + MINUTE);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure(), LAST_REQUEST + 2 * MINUTE)), false);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure())), false);
  assert.equal(returns.offer("chat", llm(pressure())), undefined);
  assert.equal(tracker().takeAutomatic("chat", vcc(pressure())), false);
  returns.returned("chat", AFTER_EXPIRY);
  assert.deepEqual(returns.offer("chat", llm(pressure())), { contextTokens: 140_000 });
  assert.equal(returns.takeAutomatic("chat", vcc(pressure())), true);
});

test("a return waits briefly for the reading to load and the chat to settle", () => {
  const returns = tracker();
  returns.returned("chat", AFTER_EXPIRY);
  assert.equal(returns.takeAutomatic("chat", vcc(null)), false);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure(), AFTER_EXPIRY, false)), false);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure(), AFTER_EXPIRY + 1_000)), true);

  // A chat that only becomes ready long after the return waits for the next one.
  const late = tracker();
  late.returned("chat", AFTER_EXPIRY);
  assert.equal(late.takeAutomatic("chat", vcc(pressure(), AFTER_EXPIRY + EXPIRED_CACHE_RETURN_GRACE_MS + 1)), false);
});

test("small, already-compacting, uncompressible or untimed chats are left alone", () => {
  const cases: ChatContextPressureV1[] = [
    pressure({ contextTokens: 99_999 }),
    pressure({ shouldCompact: true }),
    pressure({ compressibleHistoryMessages: 0 }),
    pressure({ promptCache: undefined }),
  ];
  for (const reading of cases) {
    const returns = tracker();
    returns.returned("chat", AFTER_EXPIRY);
    assert.equal(returns.offer("chat", llm(reading)), undefined);
    assert.equal(returns.takeAutomatic("chat", vcc(reading)), false);
  }
});

test("LLM compaction is only offered, and the offer ends when the user answers it", () => {
  const returns = tracker();
  returns.returned("chat", AFTER_EXPIRY);
  assert.equal(returns.takeAutomatic("chat", llm(pressure())), false);
  assert.deepEqual(returns.offer("chat", llm(pressure())), { contextTokens: 140_000 });
  assert.equal(returns.offer("chat", llm(pressure(), AFTER_EXPIRY, false)), undefined);
  returns.settle("chat", pressure(), AFTER_EXPIRY);
  assert.equal(returns.offer("chat", llm(pressure())), undefined);
  // Switching to pi-vcc afterwards does not compact the window the user answered.
  returns.returned("chat", AFTER_EXPIRY + 1);
  assert.equal(returns.takeAutomatic("chat", vcc(pressure(), AFTER_EXPIRY + 1)), false);
});

test("an answered window stays answered across a restart", () => {
  const saved = { value: {} as Record<string, number> };
  const before = tracker(saved);
  before.returned("dismissed", AFTER_EXPIRY);
  before.settle("dismissed", pressure(), AFTER_EXPIRY);
  before.returned("compacted", AFTER_EXPIRY);
  assert.equal(before.takeAutomatic("compacted", vcc(pressure())), true);
  before.settle("compacted", pressure(), AFTER_EXPIRY + 2_000);

  const after = tracker(saved);
  after.returned("dismissed", AFTER_EXPIRY + MINUTE);
  after.returned("compacted", AFTER_EXPIRY + MINUTE);
  assert.equal(after.offer("dismissed", llm(pressure(), AFTER_EXPIRY + MINUTE)), undefined);
  assert.equal(after.takeAutomatic("compacted", vcc(pressure(), AFTER_EXPIRY + MINUTE)), false);
});

test("chats are tracked separately", () => {
  const returns = tracker();
  returns.returned("a", AFTER_EXPIRY);
  assert.equal(returns.takeAutomatic("b", vcc(pressure())), false);
  assert.equal(returns.offer("b", llm(pressure())), undefined);
  assert.equal(returns.takeAutomatic("a", vcc(pressure())), true);
  returns.returned("b", AFTER_EXPIRY);
  assert.deepEqual(returns.offer("b", llm(pressure())), { contextTokens: 140_000 });
});

test("the expiry is the last cache request plus its lifetime", () => {
  assert.equal(promptCacheExpiresAt(pressure()), LAST_REQUEST + 5 * MINUTE);
  assert.equal(promptCacheExpiresAt(pressure({ promptCache: undefined })), undefined);
  assert.equal(promptCacheExpiresAt(null), undefined);
});
