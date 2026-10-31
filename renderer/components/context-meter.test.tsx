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
      "conversation",
      "system + tools",
      "recent work",
      "reserved",
      "model context",
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
  assert.match(html, /Reported by 1 of 2 saved assistant turns/);
  assert.match(html, /Total cost<.*Unavailable/);
  assert.doesNotMatch(html, /\$0\.00/);
  const text = html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  assert.match(text, /42% used/u);
  assert.match(text, /~40K of 96K usable/u);
  // 500 of 640 prompt tokens (input 100 + cache read 500 + cache write 40) came from cache.
  assert.match(text, /78% from cache/u);
});


test("cumulative usage past a billion tokens reads in billions", async () => {
  const { ChatContextPanel } = await import("./chat-context-panel.js");
  const usage = { input: 90_000_000, output: 10_000_000, cacheRead: 1_100_000_000, cacheWrite: 0, total: 1_200_000_000, requests: 900 };
  const turn = { id: "a", role: "assistant" as const, content: "done", createdAt: 20, turnStats: { version: 1 as const, startedAt: 10, finishedAt: 20, usage } };
  const html = renderToStaticMarkup(<ChatContextPanel details={{ chat: { id: "chat", title: "Long", createdAt: 1, updatedAt: 20, messages: [turn] }, pressure: null, compacting: false, providerLabel: "Local", modelLabel: "Model" }} />);
  assert.match(html, />1\.2B</u);
  assert.match(html, /92% from cache/u);
});

test("a chat whose provider never reported usage says so once instead of a column of Unavailable", async () => {
  const { ChatContextPanel } = await import("./chat-context-panel.js");
  const messages = [{ id: "old", role: "assistant" as const, content: "local reply", createdAt: 1 }];
  const html = renderToStaticMarkup(<ChatContextPanel details={{ chat: { id: "chat", title: "Test", createdAt: 1, updatedAt: 20, messages }, pressure: pressure(), compacting: false, providerLabel: "Ollama", modelLabel: "llama3.2" }} />);
  assert.match(html, /hasn(?:'|&#x27;)t reported token usage/u);
  assert.doesNotMatch(html, /Unavailable/u);
});

test("the Session panel's provider chip wears the provider's mark and its model chip the model's own", async () => {
  const { ChatContextPanel } = await import("./chat-context-panel.js");
  const html = renderToStaticMarkup(<ChatContextPanel details={{ chat: { id: "chat", title: "Test", createdAt: 1, updatedAt: 20, messages: [] }, pressure: null, compacting: false, providerId: "anthropic", providerLabel: "Anthropic", modelId: "claude-opus-4-1", modelLabel: "Claude Opus 4.1" }} />);
  const chipFor = (label: string) => {
    const end = html.indexOf(`${label}</`);
    assert.ok(end > 0, `${label} chip is rendered`);
    const start = html.lastIndexOf("data-provider-icon=", end);
    return html.slice(start, end).match(/data-provider-icon="([^"]+)"/u)?.[1];
  };
  assert.equal(chipFor("Anthropic"), "anthropic");
  assert.equal(chipFor("Claude Opus 4.1"), "claude");
});
