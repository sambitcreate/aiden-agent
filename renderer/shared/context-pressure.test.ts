import assert from "node:assert/strict";
import test from "node:test";
import {
  contextPressurePercent,
  formatContextTokenCount,
  parseChatContextPressure,
  parseChatContextPressureNotification,
  type ChatContextPressureV1,
} from "./context-pressure.js";

function pressure(extra: Partial<ChatContextPressureV1> = {}): ChatContextPressureV1 {
  return {
    contextTokens: 82_000,
    contextWindow: 128_000,
    inputBudgetTokens: 96_000,
    reservedTokens: 32_000,
    percentOfWindow: 64,
    percentOfUsableInput: 85,
    shouldCompact: false,
    messageTokens: 61_000,
    staticTokens: 21_000,
    compressibleHistoryMessages: 12,
    source: "estimated",
    computedAt: 1_789_000_000_000,
    ...extra,
  };
}

test("a well-formed pressure payload round-trips", () => {
  const value = pressure({
    providerUsageTokens: 50_000,
    addedAfterUsageAnchorTokens: 11_000,
    source: "provider-anchored",
  });
  assert.deepEqual(parseChatContextPressure({ ...value }), value);
});

test("malformed pressure payloads are rejected field by field", () => {
  assert.equal(parseChatContextPressure(null), undefined);
  assert.equal(parseChatContextPressure({}), undefined);
  assert.equal(parseChatContextPressure({ ...pressure(), contextWindow: 0 }), undefined);
  assert.equal(parseChatContextPressure({ ...pressure(), percentOfWindow: -1 }), undefined);
  assert.equal(parseChatContextPressure({ ...pressure(), shouldCompact: "yes" }), undefined);
  assert.equal(parseChatContextPressure({ ...pressure(), source: "guessed" }), undefined);
  assert.equal(parseChatContextPressure({ ...pressure(), providerUsageTokens: -5 }), undefined);
  assert.equal(
    parseChatContextPressure({
      ...pressure(),
      compressibleHistoryMessages: 1.5,
    }),
    undefined,
  );
});

test("notifications require a chat id and accept stream-scoped or ambient shapes", () => {
  assert.equal(
    parseChatContextPressureNotification({ chatId: "chat-1", pressure: pressure() })?.pressure
      ?.contextTokens,
    82_000,
  );
  assert.deepEqual(
    parseChatContextPressureNotification({
      chatId: "chat-1",
      streamId: "stream-1",
      pressure: null,
    }),
    { chatId: "chat-1", streamId: "stream-1", pressure: null },
  );
  assert.equal(parseChatContextPressureNotification({ pressure: pressure() }), undefined);
  assert.equal(
    parseChatContextPressureNotification({
      chatId: "chat-1",
      streamId: "",
      pressure: pressure(),
    }),
    undefined,
  );
  assert.equal(
    parseChatContextPressureNotification({ chatId: "chat-1", pressure: { bogus: 1 } }),
    undefined,
  );
});

test("token formatting stays compact and approximate", () => {
  assert.equal(formatContextTokenCount(0), "0");
  assert.equal(formatContextTokenCount(999), "999");
  assert.equal(formatContextTokenCount(1_000), "1K");
  assert.equal(formatContextTokenCount(25_900), "25.9K");
  assert.equal(formatContextTokenCount(82_000), "82K");
  assert.equal(formatContextTokenCount(1_000_000), "1M");
  assert.equal(formatContextTokenCount(1_572_000), "1.6M");
  assert.equal(formatContextTokenCount(-4), "0");
  // Rounding never produces "1000.0K" or a trailing ".0".
  assert.equal(formatContextTokenCount(999_950), "1M");
  assert.equal(formatContextTokenCount(99_960), "100K");
  assert.equal(formatContextTokenCount(1_040), "1K");
});

test("the meter reads usable-input pressure, not raw window occupancy", () => {
  // 82K of a 128K window reads 85% once the 32K reserve is accounted for —
  // the number that matches when Aiden would compact.
  assert.equal(contextPressurePercent(pressure()), 85);
});

function breakdown() {
  return {
    categories: [
      { id: "system-prompt" as const, tokens: 9_000 },
      { id: "builtin-tools" as const, tokens: 8_000 },
      { id: "mcp-tools" as const, tokens: 3_000 },
      { id: "skills" as const, tokens: 1_000 },
    ],
    deferred: [
      {
        id: "mcp-tools" as const,
        tokens: 4_500,
        count: 3,
        servers: [
          { name: "figma", count: 2, tokens: 3_000 },
          { name: "linear", count: 1, tokens: 1_500 },
        ],
      },
    ],
  };
}

test("a breakdown that adds up to staticTokens round-trips", () => {
  const value = pressure({ breakdown: breakdown() });
  assert.deepEqual(parseChatContextPressure(structuredClone(value)), value);
});

test("a malformed breakdown is dropped while the rest of the pressure survives", () => {
  const malformed: unknown[] = [
    { ...breakdown(), categories: [...breakdown().categories.slice(1), { id: "messages", tokens: 9_000 }] },
    {
      ...breakdown(),
      categories: [{ id: "system-prompt", tokens: 30_000 }, { id: "builtin-tools", tokens: -9_000 }],
    },
    // Sums to 20_000, one short of staticTokens.
    { ...breakdown(), categories: [...breakdown().categories.slice(1), { id: "system-prompt", tokens: 8_000 }] },
    // A zero row is never sent; one would read as an empty MCP slice.
    { ...breakdown(), categories: [...breakdown().categories, { id: "memory", tokens: 0 }] },
    { ...breakdown(), categories: [...breakdown().categories.slice(0, 3), { id: "mcp-tools", tokens: 1_000 }] },
    // Deferred servers must account for the deferred total.
    { ...breakdown(), deferred: [{ ...breakdown().deferred[0], count: 4 }] },
    { ...breakdown(), deferred: [{ ...breakdown().deferred[0], servers: [{ name: "", count: 3, tokens: 4_500 }] }] },
    { categories: breakdown().categories },
    "breakdown",
  ];
  for (const value of malformed) {
    const parsed = parseChatContextPressure({ ...pressure(), breakdown: value });
    assert.ok(parsed, JSON.stringify(value));
    assert.equal(parsed.breakdown, undefined, JSON.stringify(value));
    assert.equal(parsed.percentOfUsableInput, 85);
    assert.equal(parsed.staticTokens, 21_000);
  }
});

test("a pressure without a breakdown still parses", () => {
  const parsed = parseChatContextPressure(pressure());
  assert.ok(parsed);
  assert.equal("breakdown" in parsed, false);
});
