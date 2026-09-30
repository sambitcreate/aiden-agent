import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WebSearchError } from "./web-search-core.js";
import {
  EMPTY_WEB_SEARCH_KEY_POOL_DOCUMENT,
  WebSearchKeyPoolTracker,
  formatWebSearchKeyPoolCooldown,
  moveWebSearchKeyPoolEntry,
  normalizeWebSearchKeyPoolLabel,
  parseWebSearchKeyPoolDocument,
  reorderWebSearchKeyPoolEntries,
  runWithWebSearchKeyPool,
  serializeWebSearchKeyPoolDocument,
  webSearchKeyPoolRendererState,
  type WebSearchKeyPool,
} from "./web-search-key-pool-core.js";
import { createTavilyWebSearchAdapter } from "./web-search-tavily-adapter.js";

const SUCCESS_BODY = readFileSync(
  new URL("./fixtures/tavily-search/json-success.json", import.meta.url),
  "utf8",
);

const MINUTE = 60_000;

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * Fake Tavily endpoint: each key has a scripted status. Records the bearer
 * key of every request actually sent.
 */
function fakeTavily(statusByKey: Record<string, number>) {
  const sent: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const key = auth.replace(/^Bearer /u, "");
    sent.push(key);
    const status = statusByKey[key] ?? 500;
    return status === 200
      ? new Response(SUCCESS_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response(`{"detail":"rejected ${key}"}`, { status });
  }) as typeof globalThis.fetch;
  return { sent, adapter: createTavilyWebSearchAdapter({ fetch }) };
}

function pool(strategy: WebSearchKeyPool["strategy"], ...keys: string[]): WebSearchKeyPool {
  return { strategy, keys: keys.map((key, index) => ({ id: `k${index + 1}`, key })) };
}

function search(adapter: ReturnType<typeof fakeTavily>["adapter"], key: string) {
  return adapter.search({
    query: "pool failover",
    numResults: 2,
    credentialMode: "api-key",
    credential: key,
    signal: new AbortController().signal,
  });
}

test("ordered pools fail over past rejected and rate-limited keys to a healthy one", async () => {
  const clock = fakeClock();
  const tracker = new WebSearchKeyPoolTracker({ now: clock.now });
  const tavily = fakeTavily({ "tvly-a": 401, "tvly-b": 429, "tvly-c": 200 });
  const attempts: string[] = [];

  const result = await runWithWebSearchKeyPool({
    providerId: "tavily",
    pool: pool("ordered", "tvly-a", "tvly-b", "tvly-c"),
    tracker,
    beforeKeyAttempt: (entryId) => {
      attempts.push(entryId);
    },
    run: (key) => search(tavily.adapter, key),
  });

  assert.ok(result.results.length > 0);
  assert.deepEqual(tavily.sent, ["tvly-a", "tvly-b", "tvly-c"]);
  assert.deepEqual(attempts, ["k1", "k2", "k3"]);
  assert.equal(tracker.cooldown("tavily", "k1")?.reason, "auth");
  assert.equal(tracker.cooldown("tavily", "k2")?.reason, "quota");
  assert.equal(tracker.cooldown("tavily", "k3"), undefined);

  // The next search skips both cooling keys and goes straight to the healthy one.
  tavily.sent.length = 0;
  await runWithWebSearchKeyPool({
    providerId: "tavily",
    pool: pool("ordered", "tvly-a", "tvly-b", "tvly-c"),
    tracker,
    run: (key) => search(tavily.adapter, key),
  });
  assert.deepEqual(tavily.sent, ["tvly-c"]);
});

test("Tavily's plan-quota status codes also rotate to the next key", async () => {
  const tracker = new WebSearchKeyPoolTracker({ now: fakeClock().now });
  const tavily = fakeTavily({ "tvly-a": 432, "tvly-b": 433, "tvly-c": 200 });
  await runWithWebSearchKeyPool({
    providerId: "tavily",
    pool: pool("ordered", "tvly-a", "tvly-b", "tvly-c"),
    tracker,
    run: (key) => search(tavily.adapter, key),
  });
  assert.deepEqual(tavily.sent, ["tvly-a", "tvly-b", "tvly-c"]);
  assert.equal(tracker.cooldown("tavily", "k1")?.reason, "quota");
  assert.equal(tracker.cooldown("tavily", "k2")?.reason, "quota");
});

test("non-credential failures stop immediately instead of burning other keys", async () => {
  const tracker = new WebSearchKeyPoolTracker({ now: fakeClock().now });
  const tavily = fakeTavily({ "tvly-a": 500, "tvly-b": 200 });
  await assert.rejects(
    runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: pool("ordered", "tvly-a", "tvly-b"),
      tracker,
      run: (key) => search(tavily.adapter, key),
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind !== "auth",
  );
  assert.deepEqual(tavily.sent, ["tvly-a"]);
  assert.equal(tracker.cooldown("tavily", "k1"), undefined);
});

test("when every key is cooling, no request is sent and the error names the recoverable kind", async () => {
  const clock = fakeClock();
  const tracker = new WebSearchKeyPoolTracker({ now: clock.now });
  const tavily = fakeTavily({ "tvly-a": 401, "tvly-b": 429 });
  const keys = pool("ordered", "tvly-a", "tvly-b");

  await assert.rejects(
    runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: keys,
      tracker,
      run: (key) => search(tavily.adapter, key),
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "quota",
  );
  assert.equal(tavily.sent.length, 2);

  tavily.sent.length = 0;
  await assert.rejects(
    runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: keys,
      tracker,
      run: (key) => search(tavily.adapter, key),
    }),
    (error: unknown) =>
      error instanceof WebSearchError &&
      error.kind === "quota" &&
      !error.message.includes("tvly-a") &&
      !error.message.includes("tvly-b"),
  );
  assert.deepEqual(tavily.sent, [], "a fully cooling pool must not touch the network");

  // A pool whose only keys were rejected reports an auth failure instead.
  const authOnly = new WebSearchKeyPoolTracker({ now: clock.now });
  authOnly.recordFailure("tavily", "k1", "auth");
  await assert.rejects(
    runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: pool("ordered", "tvly-a"),
      tracker: authOnly,
      run: (key) => search(tavily.adapter, key),
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "auth",
  );
  assert.deepEqual(tavily.sent, []);
});

test("cooldowns expire on the clock and escalate on repeated failures of the same kind", () => {
  const clock = fakeClock();
  const tracker = new WebSearchKeyPoolTracker({ now: clock.now });

  const first = tracker.recordFailure("tavily", "k1", "quota");
  assert.equal(first.until - clock.now(), MINUTE);
  const second = tracker.recordFailure("tavily", "k1", "quota");
  assert.equal(second.until - clock.now(), 2 * MINUTE);

  clock.advance(2 * MINUTE - 1);
  assert.ok(tracker.cooldown("tavily", "k1"));
  clock.advance(1);
  assert.equal(tracker.cooldown("tavily", "k1"), undefined);

  // Quota escalation is capped at one hour.
  for (let index = 0; index < 12; index += 1) tracker.recordFailure("tavily", "k2", "quota");
  assert.equal(tracker.cooldown("tavily", "k2")!.until - clock.now(), 60 * MINUTE);

  // A different failure kind restarts from that kind's base, and auth cools longer.
  const auth = tracker.recordFailure("tavily", "k2", "auth");
  assert.equal(auth.consecutiveFailures, 1);
  assert.equal(auth.until - clock.now(), 15 * MINUTE);

  // Success clears the record so the next failure starts from base again.
  tracker.recordSuccess("tavily", "k2");
  assert.equal(tracker.recordFailure("tavily", "k2", "quota").until - clock.now(), MINUTE);
});

test("round-robin starts each search on the next key while ordered always starts first", async () => {
  const tracker = new WebSearchKeyPoolTracker({ now: fakeClock().now });
  const tavily = fakeTavily({ "tvly-a": 200, "tvly-b": 200, "tvly-c": 200 });
  for (let index = 0; index < 4; index += 1) {
    await runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: pool("round-robin", "tvly-a", "tvly-b", "tvly-c"),
      tracker,
      run: (key) => search(tavily.adapter, key),
    });
  }
  assert.deepEqual(tavily.sent, ["tvly-a", "tvly-b", "tvly-c", "tvly-a"]);

  tavily.sent.length = 0;
  for (let index = 0; index < 3; index += 1) {
    await runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: pool("ordered", "tvly-a", "tvly-b", "tvly-c"),
      tracker: new WebSearchKeyPoolTracker(),
      run: (key) => search(tavily.adapter, key),
    });
  }
  assert.deepEqual(tavily.sent, ["tvly-a", "tvly-a", "tvly-a"]);
});

test("round-robin skips a cooling key and cancellation stops failover", async () => {
  const tracker = new WebSearchKeyPoolTracker({ now: fakeClock().now });
  tracker.recordFailure("tavily", "k2", "quota");
  const tavily = fakeTavily({ "tvly-a": 200, "tvly-b": 200, "tvly-c": 200 });
  const keys = pool("round-robin", "tvly-a", "tvly-b", "tvly-c");
  for (let index = 0; index < 3; index += 1) {
    await runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: keys,
      tracker,
      run: (key) => search(tavily.adapter, key),
    });
  }
  assert.deepEqual(tavily.sent, ["tvly-a", "tvly-c", "tvly-c"]);

  const controller = new AbortController();
  const aborting = fakeTavily({ "tvly-a": 429, "tvly-b": 200 });
  await assert.rejects(
    runWithWebSearchKeyPool({
      providerId: "tavily",
      pool: pool("ordered", "tvly-a", "tvly-b"),
      tracker: new WebSearchKeyPoolTracker(),
      signal: controller.signal,
      run: async (key) => {
        try {
          return await search(aborting.adapter, key);
        } finally {
          controller.abort();
        }
      },
    }),
    (error: unknown) => error instanceof WebSearchError && error.kind === "cancelled",
  );
  assert.deepEqual(aborting.sent, ["tvly-a"]);
});

test("the renderer projection carries labels and cooldowns but never key material", () => {
  const clock = fakeClock();
  const tracker = new WebSearchKeyPoolTracker({ now: clock.now });
  tracker.recordFailure("tavily", "primary", "quota");
  const state = webSearchKeyPoolRendererState(
    "tavily",
    {
      version: 1,
      strategy: "round-robin",
      entries: [
        { id: "primary", label: "Personal", addedAt: 10 },
        { id: "abc123", label: "Team", addedAt: 20 },
      ],
    },
    tracker,
  );
  assert.equal(state.strategy, "round-robin");
  assert.deepEqual(
    state.entries.map((entry) => [entry.id, entry.label, entry.cooldown?.reason ?? null]),
    [
      ["primary", "Personal", "quota"],
      ["abc123", "Team", null],
    ],
  );
  assert.equal(state.entries[0]!.cooldown!.until, clock.now() + MINUTE);
  for (const entry of state.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["addedAt", "cooldown", "id", "label"]);
  }
});

test("the encrypted pool index round-trips and rejects malformed or oversized documents", () => {
  const document = {
    version: 1 as const,
    strategy: "ordered" as const,
    entries: [
      { id: "primary", label: "Key 1", addedAt: 1 },
      { id: "a1b2", label: "Key 2", addedAt: 2 },
    ],
  };
  assert.deepEqual(
    parseWebSearchKeyPoolDocument(serializeWebSearchKeyPoolDocument(document)),
    document,
  );
  assert.deepEqual(
    parseWebSearchKeyPoolDocument(
      serializeWebSearchKeyPoolDocument(EMPTY_WEB_SEARCH_KEY_POOL_DOCUMENT),
    ),
    EMPTY_WEB_SEARCH_KEY_POOL_DOCUMENT,
  );
  for (const raw of [
    "not json",
    JSON.stringify({ ...document, version: 2 }),
    JSON.stringify({ ...document, strategy: "random" }),
    JSON.stringify({ ...document, entries: [document.entries[0], document.entries[0]] }),
    JSON.stringify({ ...document, entries: [{ id: "../x", label: "x", addedAt: 1 }] }),
    JSON.stringify({
      ...document,
      entries: Array.from({ length: 9 }, (_, index) => ({
        id: `k${index}`,
        label: "x",
        addedAt: 1,
      })),
    }),
  ]) {
    assert.equal(parseWebSearchKeyPoolDocument(raw), undefined, raw.slice(0, 60));
  }
});

test("shared list helpers reorder exact permutations and format remaining cooldown", () => {
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(moveWebSearchKeyPoolEntry(entries, 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveWebSearchKeyPoolEntry(entries, 0, -1), ["a", "b", "c"]);
  assert.deepEqual(
    reorderWebSearchKeyPoolEntries(entries, ["c", "a", "b"]).map((entry) => entry.id),
    ["c", "a", "b"],
  );
  assert.throws(() => reorderWebSearchKeyPoolEntries(entries, ["a", "b"]), /no longer matches/u);
  assert.throws(
    () => reorderWebSearchKeyPoolEntries(entries, ["a", "a", "b"]),
    /no longer matches/u,
  );

  assert.equal(formatWebSearchKeyPoolCooldown(45_000, 0), "45s");
  assert.equal(formatWebSearchKeyPoolCooldown(12 * MINUTE, 0), "12m");
  assert.equal(formatWebSearchKeyPoolCooldown(185 * MINUTE, 0), "3h 5m");

  assert.equal(normalizeWebSearchKeyPoolLabel("  Team\u0000 key  ", "Key 2"), "Team key");
  assert.equal(normalizeWebSearchKeyPoolLabel("   ", "Key 2"), "Key 2");
  assert.equal(normalizeWebSearchKeyPoolLabel("x".repeat(80), "Key 2").length, 48);
});
