import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMeter, ContextMeterDetails, contextMeterPhase } from "./context-meter.js";
import type { ChatContextPressureV1 } from "../shared/context-pressure.js";

function pressure(extra: Partial<ChatContextPressureV1> = {}): ChatContextPressureV1 {
  return {
    contextTokens: 40_000,
    contextWindow: 128_000,
    inputBudgetTokens: 96_000,
    reservedTokens: 32_000,
    percentOfWindow: 31.25,
    percentOfUsableInput: 41.6,
    shouldCompact: false,
    messageTokens: 30_000,
    staticTokens: 10_000,
    compressibleHistoryMessages: 4,
    source: "estimated",
    computedAt: 1_789_000_000_000,
    ...extra,
  };
}

test("the runtime compaction rule outranks the presentation threshold", () => {
  assert.equal(contextMeterPhase(pressure(), false, false), "normal");
  assert.equal(contextMeterPhase(pressure({ percentOfUsableInput: 80 }), false, false), "approaching");
  // shouldCompact trips even below the 80% presentation cue.
  assert.equal(
    contextMeterPhase(pressure({ percentOfUsableInput: 60, shouldCompact: true }), false, false),
    "compaction-pending",
  );
  // A pending compaction is still owed after a stale "compacted" flash.
  assert.equal(
    contextMeterPhase(pressure({ shouldCompact: true }), false, true),
    "compaction-pending",
  );
  assert.equal(contextMeterPhase(pressure(), false, true), "compacted");
  assert.equal(contextMeterPhase(pressure({ shouldCompact: true }), true, false), "compacting");
});

test("renders nothing until main supplies a projection", () => {
  assert.equal(renderToStaticMarkup(<ContextMeter pressure={null} />), "");
});

test("the breakdown announces each label as the term and its token count as the value", () => {
  const markup = renderToStaticMarkup(
    <ContextMeterDetails
      pressure={pressure({ addedAfterUsageAnchorTokens: 2_000 })}
      percent={42}
      emphasized={false}
      stateText="Context healthy."
    />,
  );
  const pairs = [...markup.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/gu)].map(
    ([, term, value]) => [term, value],
  );
  assert.deepEqual(
    pairs.map(([term]) => term),
    [
      "projected tokens",
      "model context",
      "reserved for response + safety",
      "conversation",
      "system + tools",
      "recent work",
    ],
  );
  for (const [, value] of pairs) assert.match(value, /\d/u);
});

test("the trigger reports usable-input pressure without clamping", () => {
  const healthy = renderToStaticMarkup(<ContextMeter pressure={pressure()} />);
  assert.match(healthy, /aria-label="Context usage, 42 percent"/u);
  assert.match(healthy, />42%</u);

  const over = renderToStaticMarkup(
    <ContextMeter pressure={pressure({ percentOfUsableInput: 131.4, shouldCompact: true })} />,
  );
  assert.match(
    over,
    /aria-label="Context usage, 131 percent, will compact before the next request"/u,
  );
  assert.match(over, />131%</u);
  assert.match(over, /text-support-warning/u);
});


test("context details aggregate durable turn totals once without inventing unavailable usage", async () => {
  const { recordedChatUsage, ChatContextPanel } = await import("./chat-context-panel.js");
  const turn = { id: "a", role: "assistant" as const, content: "done", createdAt: 20, turnStats: { version: 1 as const, startedAt: 10, finishedAt: 20, usage: { input: 100, output: 20, cacheRead: 500, cacheWrite: 40, total: 660, requests: 3 } } };
  const messages = [turn, turn, { id: "old", role: "assistant" as const, content: "legacy", createdAt: 1 }];
  assert.deepEqual(recordedChatUsage({ messages }), { input: 100, output: 20, cacheRead: 500, cacheWrite: 40, total: 660, requests: 3, turns: 1, assistantMessages: 2, userMessages: 0 });
  const html = renderToStaticMarkup(<ChatContextPanel details={{ chat: { id: "chat", title: "Test", createdAt: 1, updatedAt: 20, messages }, pressure: pressure(), compacting: false, providerLabel: "Local", modelLabel: "Model" }} />);
  assert.match(html, /Reported usage from 1 of 2 saved assistant turns/);
  assert.match(html, /Total cost<.*Unavailable/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /42% of usable context/);
});
