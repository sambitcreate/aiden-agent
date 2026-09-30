import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSubagentContextUsage,
  createSubagentContextUsageStore,
} from "./subagent-context-usage-store.js";
import {
  parseSubagentContextUsageNotification,
  subagentContextIsApproachingLimit,
  subagentContextPercent,
  subagentContextUsageFromReport,
  subagentContextUsageLabels,
} from "../shared/subagent-context-usage.js";

function payload(chatId: string, runId: string, tokens: number, window = 200_000) {
  return { streamId: "stream-1", chatId, runId, usage: { tokens, window } };
}

test("a provider report becomes a reading only when both the window and usage are known", () => {
  assert.deepEqual(subagentContextUsageFromReport(84_000, 200_000), {
    tokens: 84_000,
    window: 200_000,
  });
  assert.deepEqual(subagentContextUsageFromReport(1_234.9, 8_192.5), {
    tokens: 1_234,
    window: 8_192,
  });
  assert.equal(subagentContextUsageFromReport(84_000, undefined), undefined);
  assert.equal(subagentContextUsageFromReport(84_000, 0), undefined);
  assert.equal(subagentContextUsageFromReport(0, 200_000), undefined);
  assert.equal(subagentContextUsageFromReport(Number.NaN, 200_000), undefined);
});

test("labels round the share of the window and flag the last fifth", () => {
  assert.deepEqual(subagentContextUsageLabels({ tokens: 84_000, window: 200_000 }), {
    percent: "42%",
    amount: "84K / 200K tokens",
    spoken: "context 42 percent, 84K of 200K tokens",
  });
  assert.equal(subagentContextPercent({ tokens: 1, window: 1_000 }), 0);
  // A child can overshoot its window before the provider rejects the next turn.
  assert.equal(subagentContextPercent({ tokens: 210_000, window: 200_000 }), 105);
  assert.equal(subagentContextIsApproachingLimit({ tokens: 158_000, window: 200_000 }), false);
  assert.equal(subagentContextIsApproachingLimit({ tokens: 160_000, window: 200_000 }), true);
});

test("notification parsing rejects unsafe ids and malformed usage", () => {
  assert.deepEqual(
    parseSubagentContextUsageNotification(payload("chat-1", "run-1", 10)),
    payload("chat-1", "run-1", 10),
  );
  const rejected: unknown[] = [
    null,
    [],
    { ...payload("chat-1", "run-1", 10), chatId: "" },
    { ...payload("chat-1", "run-1", 10), streamId: 7 },
    payload("chat-1", "../escape", 10),
    payload("chat-1", "run-1", -1),
    payload("chat-1", "run-1", 1.5),
    payload("chat-1", "run-1", 10, 0),
    { ...payload("chat-1", "run-1", 10), usage: "10/200" },
  ];
  for (const value of rejected) {
    assert.equal(parseSubagentContextUsageNotification(value), undefined, JSON.stringify(value));
  }
});

test("the store keeps the latest reading per run and stays reference-stable between changes", () => {
  const store = createSubagentContextUsageStore();
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  const empty = store.forChat("chat-1");
  assert.equal(empty.size, 0);
  assert.equal(store.forChat(null), empty);

  assert.equal(store.apply(payload("chat-1", "run-1", 12_000)), true);
  const first = store.forChat("chat-1");
  assert.deepEqual(first.get("run-1"), { tokens: 12_000, window: 200_000 });
  assert.equal(store.forChat("chat-1"), first);

  // An identical reading is not a change, so subscribers are not re-rendered.
  assert.equal(store.apply(payload("chat-1", "run-1", 12_000)), false);
  assert.equal(store.forChat("chat-1"), first);

  // Context can shrink (for example after compaction); the latest reading wins.
  assert.equal(store.apply(payload("chat-1", "run-1", 9_000)), true);
  assert.notEqual(store.forChat("chat-1"), first);
  assert.equal(store.forChat("chat-1").get("run-1")?.tokens, 9_000);
  assert.equal(first.get("run-1")?.tokens, 12_000);

  assert.equal(store.apply({ nope: true }), false);
  assert.equal(store.forChat("chat-2").size, 0);
  assert.equal(notified, 2);
  unsubscribe();
  store.apply(payload("chat-1", "run-1", 1));
  assert.equal(notified, 2);
});

test("the store evicts the least recently updated runs and chats", () => {
  const store = createSubagentContextUsageStore({ maxChats: 2, maxRunsPerChat: 2 });
  store.apply(payload("chat-1", "run-a", 1));
  store.apply(payload("chat-1", "run-b", 2));
  store.apply(payload("chat-1", "run-a", 3));
  store.apply(payload("chat-1", "run-c", 4));
  assert.deepEqual([...store.forChat("chat-1").keys()], ["run-a", "run-c"]);

  store.apply(payload("chat-2", "run-x", 1));
  store.apply(payload("chat-1", "run-c", 5));
  store.apply(payload("chat-3", "run-y", 1));
  assert.equal(store.forChat("chat-2").size, 0);
  assert.equal(store.forChat("chat-1").size, 2);
  assert.equal(store.forChat("chat-3").size, 1);
});

test("only runs that are still active keep their reading", () => {
  const readings = new Map([
    ["running", { tokens: 1, window: 10 }],
    ["waiting", { tokens: 2, window: 10 }],
    ["finished", { tokens: 3, window: 10 }],
    ["stopped", { tokens: 4, window: 10 }],
  ]);
  const shown = activeSubagentContextUsage(
    [
      { runId: "running", state: "running" },
      { runId: "waiting", state: "needs_attention" },
      { runId: "finished", state: "completed" },
      { runId: "stopped", state: "stopped" },
      { runId: "unread", state: "running" },
    ],
    readings,
  );
  assert.deepEqual([...shown.keys()].sort(), ["running", "waiting"]);
  assert.equal(activeSubagentContextUsage([{ runId: "finished", state: "completed" }], readings).size, 0);
});
