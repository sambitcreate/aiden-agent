import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  normalizeContext,
  type Api,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SpendingChangedEvent } from "../../renderer/shared/spending.js";
import type { SpendingDocument } from "./spending-core.js";
import { createSpendingMeter, SpendingService, spendCounts } from "./spending-service.js";

const context = normalizeContext({ messages: [] });
const model: Model<Api> = {
  id: "opus",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://fixture.invalid",
  name: "Fixture",
  input: ["text"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A provider answer that cost `usd`. */
function pricedStream(usd: number, text = "ok"): StreamFn {
  return () => {
    const message = fauxAssistantMessage(text);
    message.usage = { ...message.usage, cost: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
}

function service(settings: unknown, saved: SpendingDocument[] = [], events: SpendingChangedEvent[] = [], load: unknown = undefined) {
  return new SpendingService({
    persistence: { load: async () => load, save: async (document) => void saved.push(document) },
    settings: async () => settings,
    broadcast: (event) => void events.push(event),
  });
}

async function drain(stream: Awaited<ReturnType<StreamFn>>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("a chat's responses count, and the meter settles before a limit check reads them", async () => {
  const events: SpendingChangedEvent[] = [];
  const spending = service({ chatUsd: 1 }, [], events);
  const owner = { kind: "chat", id: "chat-1" } as const;
  const meter = createSpendingMeter({ spending, owner, counts: async () => true });
  const stream = meter.wrap(pricedStream(0.7));
  await drain(await stream(model, context, {}));
  meter.count({ usage: { cost: { total: 0.4 } } });
  await meter.settled();
  assert.equal((await spending.status("chat", "chat-1"))?.spentUsd, 1.1);
  assert.equal((await spending.block(owner))?.kind, "chat");
  assert.deepEqual(events[events.length - 1], { ownerKind: "chat", ownerId: "chat-1" });
});

test("a sign-in or a model on this Mac counts as $0", async () => {
  const spending = service({ chatUsd: 1 });
  const meter = createSpendingMeter({
    spending,
    owner: { kind: "chat", id: "chat-1" },
    counts: () => spendCounts({ local: false, provider: { id: "anthropic" }, models: { checkAuth: async () => ({ type: "oauth" }) } }),
  });
  await drain(await meter.wrap(pricedStream(3))(model, context, {}));
  await meter.settled();
  assert.equal((await spending.status("chat", "chat-1"))?.spentUsd, 0);
  assert.equal(await spendCounts({ local: true, provider: { id: "lm" }, models: { checkAuth: async () => ({ type: "api_key" }) } }), false);
  assert.equal(await spendCounts({ local: false, provider: { id: "x" }, models: { checkAuth: async () => ({ type: "api_key" }) } }), true);
  assert.equal(
    await spendCounts({ local: false, provider: { id: "x" }, models: { checkAuth: async () => Promise.reject(new Error("locked")) } }),
    true,
    "an unreadable sign-in counts",
  );
});

test("a helper over its chat's limit is refused before the provider is asked", async () => {
  const spending = service({ chatUsd: 1 });
  const owner = { kind: "chat", id: "chat-1" } as const;
  await spending.record(owner, 1.5);
  let asked = 0;
  const meter = createSpendingMeter({ spending, owner, counts: async () => true, refuse: true });
  const stream = meter.wrap((...args) => {
    asked += 1;
    return pricedStream(0.1)(...args);
  });
  const events = await drain(await stream(model, context, {}));
  assert.equal(asked, 0);
  const last = events[events.length - 1];
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" && last.error.errorMessage, "This chat reached its $1.00 spending limit. Allow more to keep going.");
});

test("each spending change is durable before returning; unreadable limits refuse instead of removing the cap", async () => {
  const saved: SpendingDocument[] = [];
  const first = service({ botMonthUsd: 5 }, saved);
  await first.record({ kind: "bot", id: "ada" }, 2);
  await first.setBotLimit("ada", 3);
  await first.flush();
  assert.equal(Object.values(saved[0]?.botPeriods ?? {})[0]?.spentUsd, 2, "the charge was durable before the later settings write");
  const second = service({ botMonthUsd: 5 }, [], [], saved[saved.length - 1]);
  assert.deepEqual(
    { ...(await second.status("bot", "ada")), periodStart: undefined, periodEnd: undefined },
    { ownerKind: "bot", ownerId: "ada", period: "month", limitUsd: 3, extraUsd: 0, spentUsd: 2, state: "under", periodStart: undefined, periodEnd: undefined },
  );
  const bad = service({ chatUsd: -1 });
  await assert.rejects(bad.record({ kind: "chat", id: "c" }, 9), /Spending limits could not be read safely/u);
});

test("a meter whose response charge could not be saved refuses the next provider dispatch", async () => {
  let asked = 0;
  const meter = createSpendingMeter({
    owner: { kind: "chat", id: "save-failed" }, counts: async () => true,
    spending: { refusal: async () => undefined, record: async () => { throw new Error("charge publication failed"); } },
  });
  const stream = meter.wrap((...args) => { asked++; return pricedStream(0.2)(...args); });
  await drain(await stream(model, context, {}));
  await assert.rejects(meter.settled(), /charge publication failed/u);
  await assert.rejects(async () => { await stream(model, context, {}); }, /charge publication failed/u);
  assert.equal(asked, 1);
});

test("a restart immediately after recording restores the routine and monthly balances", async () => {
  const saved: SpendingDocument[] = [];
  const settings = { routineRunUsd: 1, botMonthUsd: 3 };
  const first = service(settings, saved);
  const owner = { kind: "bot", id: "ada", run: "morning" } as const;
  await Promise.all([first.record(owner, 0.25), first.record(owner, 0.75)]);
  const reopened = service(settings, [], [], saved[saved.length - 1]);
  assert.deepEqual(await reopened.block(owner), { kind: "run", allowedUsd: 1, spentUsd: 1 });
  assert.equal((await reopened.status("bot", owner.id))?.spentUsd, 1);
  assert.equal(await reopened.block({ ...owner, run: "evening" }), undefined);
});
