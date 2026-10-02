import { Agent } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, normalizeContext, Type, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { PiCacheWarmer, withPiCacheWarming, cacheWarmingEconomics, stopAllPiCacheWarmers, type CacheWarmingClock } from "./pi-cache-warming.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";

class Clock implements CacheWarmingClock {
  time = 0;
  timers = new Map<object, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout(callback: () => void, delay: number) { const id = {}; this.timers.set(id, { at: this.time + delay, callback }); return id; }
  clearTimeout(timer: unknown) { this.timers.delete(timer as object); }
  async advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of this.timers) if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
    for (let index = 0; index < 12; index++) await Promise.resolve();
  }
}
const model: Model<Api> = {
  id: "priced", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid", name: "Priced fixture",
  input: ["text"], reasoning: false, contextWindow: 200_000, maxTokens: 8_192,
  cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 }, promptCache: { short: 300 },
};
function usageMessage() {
  return { ...fauxAssistantMessage("ordinary response"), usage: { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 100_010, cost: { input: 1, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 1.0003 } } };
}
function fixture(t: test.TestContext) {
  const clock = new Clock();
  const signal = new AbortController();
  const requests: Array<SimpleStreamOptions | undefined> = [];
  const contexts: unknown[] = [];
  const recorded: unknown[] = [];
  let enabled = true;
  let resolutions = 0;
  let runtimeModel = model;
  let key = "fresh-key";
  let hold = false;
  let resolutionBarrier: Promise<void> | undefined;
  let completeHeld: (reason: "stop" | "aborted") => void = () => {};
  const runtime = (): ResolvedModelRuntime => ({
    model: runtimeModel, provider: { id: "fixture", label: "Fixture", kind: "openai", models: ["priced"], baseUrl: model.baseUrl, needsKey: true },
    models: undefined as never, apiKey: key, headers: { Authorization: `Bearer ${key}` },
    streams: { streamSimple: (_model, context, options) => {
      requests.push(options); contexts.push(context);
      const stream = createAssistantMessageEventStream();
      completeHeld = (reason) => { const message = { ...usageMessage(), stopReason: reason };
        if (reason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      };
      if (!hold) completeHeld("stop");
      return stream;
    } },
  });
  const warmer = new PiCacheWarmer({ clock, signal: signal.signal, enabled: async () => enabled, resolveRuntime: async () => { resolutions++; await resolutionBarrier; return runtime(); }, recordUsage: async (message) => { recorded.push(message); } });
  t.after(() => warmer.dispose());
  const start = (options: SimpleStreamOptions = {}, selected = model) => {
    const context = normalizeContext({ messages: [{ role: "user", content: "in-memory prompt", timestamp: 1 }] });
    const response = warmer.requestStarted(selected, context, options);
    response(usageMessage());
    return context;
  };
  return { warmer, clock, signal, requests, contexts, recorded, start, setEnabled: (value: boolean) => enabled = value, setKey: (value: string) => key = value, setModel: (value: Model<Api>) => runtimeModel = value, setHold: () => hold = true, completeHeld: (reason: "stop" | "aborted") => completeHeld(reason), setResolutionBarrier: (value: Promise<void>) => resolutionBarrier = value, resolutions: () => resolutions };
}

test("warming waits for real usage, snapshots the prefix and resolves fresh credentials at dispatch", async (t) => {
  const h = fixture(t);
  assert.equal(h.clock.timers.size, 0);
  const context = h.start({ apiKey: "old-key", sessionId: "owned-chat" });
  context.messages.push({ role: "user", content: "later mutation", timestamp: 2 });
  h.setKey("rotated-key");
  await h.clock.advance(269_999);
  assert.equal(h.requests.length, 0);
  await h.clock.advance(1);
  assert.equal(h.resolutions(), 1);
  assert.equal(h.requests[0]?.apiKey, "rotated-key");
  assert.deepEqual(h.requests[0]?.headers, { Authorization: "Bearer rotated-key" });
  assert.equal(h.requests[0]?.maxTokens, 1);
  assert.equal(h.requests[0]?.maxRetries, 0);
  assert.equal(h.requests[0]?.sessionId, "owned-chat");
  assert.doesNotMatch(JSON.stringify(h.contexts), /later mutation/u);
  assert.equal(h.recorded.length, 1);
});

test("off, unknown economics, unsafe replay and late wakeups never dispatch", async (t) => {
  for (const scenario of ["off", "unpriced", "low-savings", "no-ttl", "late", "thinking", "payload", "headers"] as const) {
    const h = fixture(t);
    let selected = model;
    if (scenario === "off") h.setEnabled(false);
    if (scenario === "unpriced") selected = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    if (scenario === "low-savings") selected = { ...model, cost: { input: 0.1, output: 0.1, cacheRead: 0.05, cacheWrite: 0 } };
    if (scenario === "no-ttl") selected = { ...model, promptCache: undefined };
    if (scenario === "thinking") selected = { ...model, api: "anthropic-messages" };
    h.start(scenario === "thinking" ? { reasoning: "high" } : scenario === "payload" ? { onPayload: () => ({}) } : scenario === "headers" ? { headers: { Authorization: "original-auth" } } : {}, selected);
    await h.clock.advance(scenario === "late" ? 300_000 : 270_000);
    assert.equal(h.requests.length, 0, scenario);
    assert.equal(h.clock.timers.size, 0, scenario);
  }
});

test("new requests replace timers; generation cancellation and settings off abort in-flight warming", async (t) => {
  const h = fixture(t);
  h.start();
  await h.clock.advance(100_000);
  h.start();
  await h.clock.advance(170_000);
  assert.equal(h.requests.length, 0);
  h.setHold();
  await h.clock.advance(100_000);
  assert.equal(h.requests.length, 1);
  stopAllPiCacheWarmers();
  assert.equal(h.requests[0]?.signal?.aborted, true);
  h.start();
  await h.clock.advance(300_000);
  assert.equal(h.requests.length, 1);
  const cancelled = fixture(t);
  cancelled.start();
  cancelled.signal.abort();
  await cancelled.clock.advance(270_000);
  assert.equal(cancelled.requests.length, 0);
});

test("request abort, endpoint change and fixed one-hour horizon stop warming", async (t) => {
  const aborted = fixture(t);
  const requestAbort = new AbortController();
  aborted.start({ signal: requestAbort.signal });
  requestAbort.abort();
  await aborted.clock.advance(270_000);
  assert.equal(aborted.requests.length, 0);
  const changed = fixture(t);
  changed.start();
  changed.setModel({ ...model, baseUrl: "https://changed.invalid" });
  await changed.clock.advance(270_000);
  assert.equal(changed.requests.length, 0);
  const capped = fixture(t);
  capped.start();
  for (let i = 0; i < 14; i++) await capped.clock.advance(270_000);
  assert.equal(capped.requests.length, 13);
  assert.equal(capped.clock.timers.size, 0);
});

test("pricing uses the matching long-context tier and charges the warm read plus one output token", () => {
  const basic = cacheWarmingEconomics(model, 100_000)!;
  assert.ok(Math.abs(basic.warmCost - 0.10003) < 1e-10);
  assert.ok(Math.abs(basic.expectedSavings - 1.04997) < 1e-10);
  const tiered = { cost: { ...model.cost, tiers: [{ inputTokensAbove: 50_000, input: 20, output: 60, cacheRead: 2, cacheWrite: 25 }] } };
  const estimate = cacheWarmingEconomics(tiered, 100_000)!;
  assert.ok(Math.abs(estimate.warmCost - 0.20006) < 1e-10);
  assert.ok(estimate.expectedSavings > 2);
});


test("the real Agent observes normalized tools and warms during a tool wait without executing extra tools", async (t) => {
  const h = fixture(t);
  let finishTool!: () => void;
  let startedTool!: () => void;
  const waiting = new Promise<void>((resolve) => { finishTool = resolve; });
  const started = new Promise<void>((resolve) => { startedTool = resolve; });
  let realRequests = 0;
  let toolCalls = 0;
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: "Unique system instructions",
      tools: [{ name: "wait_fixture", label: "Wait", description: "Await an owned operation", parameters: Type.Object({}), execute: async () => {
        toolCalls++; startedTool(); await waiting;
        return { content: [{ type: "text", text: "finished" }], details: {} };
      } }],
    },
    streamFn: withPiCacheWarming(() => {
      const message = usageMessage();
      realRequests++;
      if (realRequests === 1) { message.content = [{ type: "toolCall", id: "wait-1", name: "wait_fixture", arguments: {} }]; message.stopReason = "toolUse"; }
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end(message);
      return stream;
    }, h.warmer),
  });
  agent.subscribe((event) => { if (event.type === "agent_end") h.warmer.dispose(); });
  const running = agent.prompt("Run the waiting tool");
  await started;
  await h.clock.advance(270_000);
  assert.equal(h.requests.length, 1);
  assert.match(JSON.stringify(h.contexts[0]), /Unique system instructions/u);
  assert.match(JSON.stringify(h.contexts[0]), /Await an owned operation/u);
  assert.equal(toolCalls, 1);
  finishTool();
  await running;
  await h.clock.advance(270_000);
  assert.equal(h.requests.length, 1);
  assert.equal(realRequests, 2);
  assert.equal(toolCalls, 1);
});


test("settings changes and cancellation are checked again after asynchronous credential resolution", async (t) => {
  for (const action of ["disable", "cancel", "replace"] as const) {
    const h = fixture(t);
    let release!: () => void;
    h.setResolutionBarrier(new Promise<void>((resolve) => { release = resolve; }));
    h.start();
    await h.clock.advance(270_000);
    assert.equal(h.resolutions(), 1);
    if (action === "disable") h.setEnabled(false);
    else if (action === "cancel") h.signal.abort();
    else h.start();
    release();
    await h.clock.advance(0);
    assert.equal(h.requests.length, 0, action);
  }
});


test("provider usage arriving after cancellation is recorded once without restarting warming", async (t) => {
  for (const reason of ["stop", "aborted"] as const) {
    const h = fixture(t);
    h.setHold();
    h.start();
    await h.clock.advance(270_000);
    assert.equal(h.requests.length, 1);
    h.signal.abort();
    assert.equal(h.requests[0]?.signal?.aborted, true);
    h.completeHeld(reason);
    await h.clock.advance(0);
    assert.equal(h.recorded.length, 1, reason);
    assert.equal(h.clock.timers.size, 0, reason);
    await h.clock.advance(300_000);
    assert.equal(h.requests.length, 1, reason);
    assert.equal(h.recorded.length, 1, reason);
  }
});
