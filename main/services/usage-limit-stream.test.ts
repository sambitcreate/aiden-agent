import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  normalizeContext,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { UsageLimitGate, usageLimitKeys, usageLimitMaxWaitMs, type UsageLimitGateClock } from "./usage-limit-core.js";
import { streamSimpleWaitingOutUsageLimits, withUsageLimitWait, type UsageLimitStreamOptions } from "./usage-limit-stream.js";

const NOW = Date.UTC(2026, 9, 26, 15, 0, 0);
const context = normalizeContext({ messages: [] });

function model(api: Api = "anthropic-messages"): Model<Api> {
  return {
    id: "opus",
    provider: "anthropic",
    api,
    baseUrl: "https://fixture.invalid",
    name: "Fixture",
    input: ["text"],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

class FakeClock implements UsageLimitGateClock {
  time = NOW;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextTimer = 1;
  now = () => this.time;
  random = () => 0;
  setTimer = (callback: () => void, ms: number) => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

/** A provider response, written out the way pi-ai streams it. */
type Script =
  | { kind: "text"; text: string }
  | { kind: "reject"; message: string; status?: number; headers?: Record<string, string> }
  | { kind: "fail-after-text"; text: string; message: string }
  | { kind: "hang" };

function scripted(m: Model<Api>, script: Script, options: SimpleStreamOptions | undefined): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    await Promise.resolve();
    const start = fauxAssistantMessage("");
    start.content = [];
    stream.push({ type: "start", partial: start });
    if (script.kind === "hang") return;
    if (script.kind === "reject") {
      if (script.status !== undefined) await options?.onResponse?.({ status: script.status, headers: script.headers ?? {} }, m);
      const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: script.message });
      error.content = [];
      stream.push({ type: "error", reason: "error", error });
      stream.end();
      return;
    }
    const partial = fauxAssistantMessage(script.text);
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: script.text, partial });
    stream.push({ type: "text_end", contentIndex: 0, content: script.text, partial });
    if (script.kind === "fail-after-text") {
      const error = fauxAssistantMessage(script.text, { stopReason: "error", errorMessage: script.message });
      stream.push({ type: "error", reason: "error", error });
    } else {
      stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage(script.text) });
    }
    stream.end();
  })();
  return stream;
}

function fixture(scripts: Script[], overrides: Partial<UsageLimitStreamOptions> = {}) {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  const calls: Array<SimpleStreamOptions | undefined> = [];
  const inner: StreamFn = (m, _context, options) => {
    calls.push(options);
    const script = scripts.shift();
    if (!script) throw new Error("No more scripted responses.");
    return scripted(m, script, options);
  };
  const limits: UsageLimitStreamOptions = {
    gate,
    owner: { kind: "chat", id: "chat-1" },
    providerLabel: "Claude",
    maxWaitMs: () => usageLimitMaxWaitMs(6),
    now: clock.now,
    random: () => 0,
    ...overrides,
  };
  return { clock, gate, calls, limits, streamFn: withUsageLimitWait(inner, limits) };
}

async function read(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const RATE_LIMITED = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}';

test("a rate limit before any content waits for the reset and sends the same request again", async () => {
  const { clock, calls, streamFn, gate } = fixture([
    { kind: "reject", message: RATE_LIMITED, status: 429, headers: { "retry-after": "40", "x-request-id": "secret-id" } },
    { kind: "text", text: "Hello again" },
  ]);
  const signal = new AbortController().signal;
  let resolved: AssistantMessageEventStream | undefined;
  void Promise.resolve(streamFn(model(), context, { signal, maxTokens: 123 })).then((stream) => (resolved = stream));
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(resolved, undefined);
  const [wait] = gate.waits();
  assert.equal(wait?.owner.id, "chat-1");
  // retry-after 40 s, plus the 5 s cushion after a reset.
  assert.equal(wait?.nextTryAt, NOW + 45_000);
  assert.deepEqual(gate.entry(usageLimitKeys("anthropic", "opus").model)?.resetAt, NOW + 40_000);

  await clock.advance(44_999);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.signal, signal);
  assert.equal(calls[1]?.maxTokens, 123);

  const events = await read(resolved!);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_end", "done"],
  );
  assert.equal((await resolved!.result()).stopReason, "stop");
  assert.deepEqual(gate.snapshot(), []);
});

test("a failure after content goes through as it does today", async () => {
  const { calls, streamFn } = fixture([{ kind: "fail-after-text", text: "Half an", message: RATE_LIMITED }]);
  const stream = await streamFn(model(), context, {});
  const events = await read(stream);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_end", "error"],
  );
  assert.equal((await stream.result()).errorMessage, RATE_LIMITED);
  assert.equal(calls.length, 1);
});

test("errors that are not usage limits are not retried", async () => {
  const { calls, streamFn, gate } = fixture([{ kind: "reject", message: '400 {"error":{"message":"invalid tool schema"}}', status: 400 }]);
  const stream = await streamFn(model(), context, {});
  assert.equal((await stream.result()).errorMessage, '400 {"error":{"message":"invalid tool schema"}}');
  assert.equal(calls.length, 1);
  assert.deepEqual(gate.snapshot(), []);
});

test("rejected responses are read through fetch only where the provider adapter accepts one", async () => {
  const { calls, streamFn } = fixture([
    { kind: "text", text: "ok" },
    { kind: "text", text: "ok" },
    { kind: "text", text: "ok" },
  ]);
  await read(await streamFn(model("anthropic-messages"), context, {}));
  await read(await streamFn(model("google-generative-ai"), context, {}));
  assert.equal(typeof calls[0]?.fetch, "function");
  assert.equal(calls[1]?.fetch, undefined);

  // The recording fetch calls the host's fetch and keeps only rate-limit headers.
  const seen: string[] = [];
  const hostFetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response("{}", { status: 429, headers: { "retry-after": "90", "set-cookie": "a=b" } });
  }) as typeof fetch;
  await read(await streamFn(model("openai-responses"), context, { fetch: hostFetch }));
  const response = await calls[2]!.fetch!("https://fixture.invalid/v1/responses");
  assert.equal(response.status, 429);
  assert.deepEqual(seen, ["https://fixture.invalid/v1/responses"]);
});

test("the provider's retry header read through fetch decides the wait", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  const calls: number[] = [];
  const inner: StreamFn = async (m, _context, options) => {
    calls.push(clock.now());
    if (calls.length === 1) {
      // Like the Anthropic SDK: the response goes through fetch, then the SDK throws its error text.
      await options!.fetch!("https://fixture.invalid", {});
      return scripted(m, { kind: "reject", message: RATE_LIMITED }, undefined);
    }
    return scripted(m, { kind: "text", text: "ok" }, options);
  };
  const streamFn = withUsageLimitWait(inner, {
    gate,
    owner: { kind: "chat", id: "c" },
    providerLabel: "Claude",
    maxWaitMs: () => usageLimitMaxWaitMs(6),
    now: clock.now,
    random: () => 0,
  });
  const hostFetch = (async () => new Response("{}", { status: 429, headers: { "retry-after": "600" } })) as unknown as typeof fetch;
  let stream: AssistantMessageEventStream | undefined;
  void Promise.resolve(streamFn(model(), context, { fetch: hostFetch })).then((value) => (stream = value));
  await settle();
  await clock.advance(604_999);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.deepEqual(calls, [NOW, NOW + 605_000]);
  assert.equal((await stream!.result()).stopReason, "stop");
});

test("a limit past the longest wait fails at once with its reset time, and turns the next request away", async () => {
  const resetSeconds = 7 * 3_600;
  const { calls, streamFn, gate } = fixture([
    { kind: "reject", message: "You have hit your ChatGPT usage limit (plus plan). Try again in ~420 min." },
  ]);
  const stream = await streamFn(model(), context, {});
  const message = await stream.result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /^You have hit your ChatGPT usage limit \(plus plan\)\. Try again in ~420 min\.\n\nAiden stopped waiting: the limit resets /u);
  assert.match(message.errorMessage ?? "", /after the longest wait you set \(6 hours\)\.$/u);
  assert.equal(gate.entry("anthropic")?.resetAt, NOW + resetSeconds * 1_000);

  const next = await streamFn(model(), context, {});
  const refused = await next.result();
  assert.equal(calls.length, 1);
  assert.match(refused.errorMessage ?? "", /^Claude is still at its usage limit, and Aiden stopped waiting for it a few minutes ago\. It resets /u);
});

test("with waiting off, a limit fails as it does today and nothing is held", async () => {
  const { calls, streamFn, gate } = fixture([{ kind: "reject", message: RATE_LIMITED, status: 429 }, { kind: "text", text: "ok" }], {
    maxWaitMs: () => 0,
  });
  const failed = await (await streamFn(model(), context, {})).result();
  assert.equal(failed.errorMessage, RATE_LIMITED);
  assert.deepEqual(gate.snapshot(), []);
  assert.equal((await (await streamFn(model(), context, {})).result()).stopReason, "stop");
  assert.equal(calls.length, 2);
});

test("a held limit that clears after the longest wait ends the wait, including one already waiting when the setting changes", async () => {
  let maxHours = 1;
  const { calls, streamFn, gate } = fixture(
    [{ kind: "reject", message: RATE_LIMITED, status: 429 }, { kind: "text", text: "ok" }],
    { maxWaitMs: () => usageLimitMaxWaitMs(maxHours) },
  );
  const account = usageLimitKeys("anthropic", "opus").account;
  // A four-hour hold left by an earlier run, or by another chat.
  gate.load([{ key: account, providerId: "anthropic", since: NOW, nextTryAt: NOW + 4 * 3_600_000 + 5_000, resetAt: NOW + 4 * 3_600_000, attempts: 1 }]);

  const joined = await (await streamFn(model(), context, {})).result();
  assert.equal(joined.stopReason, "error");
  assert.match(joined.errorMessage ?? "", /^Claude is at its usage limit\.\n\nAiden stopped waiting: the limit resets .+, after the longest wait you set \(1 hour\)\.$/u);
  assert.equal(calls.length, 0);

  // Waiting under six hours, then the owner lowers it to one.
  maxHours = 6;
  let waiting: AssistantMessageEventStream | undefined;
  void Promise.resolve(streamFn(model(), context, {})).then((value) => (waiting = value));
  await settle();
  assert.equal(gate.waits().length, 1);
  gate.setMaxWait(usageLimitMaxWaitMs(1));
  await settle();
  assert.match((await waiting!.result()).errorMessage ?? "", /after the longest wait you set \(1 hour\)\.$/u);
  assert.deepEqual(gate.waits(), []);
  assert.equal(calls.length, 0);

  // Turned off during a wait: the request goes straight through once, and a
  // rejection fails as it would with waiting off.
  let sent: AssistantMessageEventStream | undefined;
  void Promise.resolve(streamFn(model(), context, {})).then((value) => (sent = value));
  await settle();
  gate.setMaxWait(0);
  await settle();
  const rejected = await sent!.result();
  assert.equal(rejected.stopReason, "error");
  assert.match(rejected.errorMessage ?? "", /^429 /u);
  assert.equal(calls.length, 1);
  assert.deepEqual(gate.waits(), []);
});

test("a request is held while it waits for the reset, and not once its test request is out", async () => {
  const owner = { kind: "bot" as const, id: "bot-1" };
  const { calls, clock, gate, streamFn } = fixture(
    [{ kind: "reject", message: RATE_LIMITED, status: 429, headers: { "retry-after": "60" } }, { kind: "hang" }],
    { owner },
  );
  void streamFn(model(), context, {});
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(gate.isHeld(owner), true);
  assert.equal(gate.isHeld({ kind: "bot", id: "bot-2" }), false);

  // The reset passes: the test request goes out and the provider never answers.
  await clock.advance(65_000);
  assert.equal(calls.length, 2);
  assert.equal(gate.isHeld(owner), false);
  assert.deepEqual(gate.waits().map((wait) => wait.trying), [true]);
});

test("stopping a waiting reply ends it as stopped without another request", async () => {
  const { calls, streamFn, gate } = fixture([{ kind: "reject", message: RATE_LIMITED, status: 429, headers: { "retry-after": "300" } }]);
  const controller = new AbortController();
  let stream: AssistantMessageEventStream | undefined;
  void Promise.resolve(streamFn(model(), context, { signal: controller.signal })).then((value) => (stream = value));
  await settle();
  assert.equal(gate.waits().length, 1);
  controller.abort();
  await settle();
  assert.equal((await stream!.result()).stopReason, "aborted");
  assert.equal(calls.length, 1);
  assert.deepEqual(gate.waits(), []);
});

test("an error the stream function throws reaches the caller unchanged", async () => {
  const { streamFn } = fixture([]);
  await assert.rejects(async () => streamFn(model(), context, {}), /No more scripted responses\./u);
});

test("the synchronous form returns its stream at once and fills it after the wait", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  const scripts: Script[] = [
    { kind: "reject", message: "usage_limit_reached: The usage limit has been reached" },
    { kind: "text", text: "Back" },
  ];
  const limits: UsageLimitStreamOptions = {
    gate,
    owner: { kind: "bot", id: "bot-1" },
    providerLabel: "ChatGPT",
    maxWaitMs: () => usageLimitMaxWaitMs(1),
    now: clock.now,
  };
  const m = model("openai-codex-responses");
  const stream = streamSimpleWaitingOutUsageLimits(m, {}, (options) => scripted(m, scripts.shift()!, options), limits);
  const events: AssistantMessageEvent[] = [];
  const reading = (async () => {
    for await (const event of stream) events.push(event);
  })();
  await settle();
  assert.equal(events.length, 0);
  assert.deepEqual(
    gate.waits().map((wait) => [wait.owner.kind, wait.owner.id, wait.nextTryAt]),
    [["bot", "bot-1", NOW + 15 * 60_000]],
  );
  await clock.advance(15 * 60_000);
  await reading;
  assert.equal(events[events.length - 1]?.type, "done");
  assert.equal((await stream.result()).stopReason, "stop");
});

test("requests that hit a limit another request holds wait behind its test", async () => {
  const clock = new FakeClock();
  const gate = new UsageLimitGate(clock);
  const sent: string[] = [];
  const responses = new Map<string, Script[]>([
    ["a", [{ kind: "reject", message: RATE_LIMITED, status: 429, headers: { "retry-after": "60" } }, { kind: "text", text: "a" }]],
    ["b", [{ kind: "reject", message: RATE_LIMITED, status: 429, headers: { "retry-after": "60" } }, { kind: "text", text: "b" }]],
  ]);
  const streamFor = (id: string) =>
    withUsageLimitWait(
      (m, _context, options) => {
        sent.push(id);
        return scripted(m, responses.get(id)!.shift()!, options);
      },
      {
        gate,
        owner: { kind: "chat", id },
        providerLabel: "Claude",
        maxWaitMs: () => usageLimitMaxWaitMs(6),
        now: clock.now,
        random: () => 0,
      },
    );
  const results: string[] = [];
  for (const id of ["a", "b"]) {
    void Promise.resolve(streamFor(id)(model(), context, {}))
      .then((stream) => stream.result())
      .then(() => results.push(id));
  }
  await settle();
  assert.deepEqual(sent, ["a", "b"]);
  assert.equal(gate.waits().filter((wait) => wait.testing).length, 1);
  await clock.advance(65_000);
  assert.deepEqual(sent, ["a", "b", "a"]);
  await clock.advance(1_000);
  assert.deepEqual(sent, ["a", "b", "a", "b"]);
  await settle();
  assert.deepEqual(results, ["a", "b"]);
});
