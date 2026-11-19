import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type AssistantMessage, type Message, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createPromptCacheTelemetry,
  formatPromptCacheMissLog,
  PROMPT_CACHE_TTL_MS,
  withPromptCacheTelemetry,
  type PromptCacheMissReport,
  type PromptCacheModelRef,
  type PromptCacheResponse,
} from "./pi-cache-telemetry.js";

const MODEL: PromptCacheModelRef = { provider: "acme", id: "large", cost: { cacheRead: 0.3 } };
const OTHER_MODEL: PromptCacheModelRef = { provider: "acme", id: "small", cost: { cacheRead: 0.1 } };

const readTool: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const writeTool: Tool = { name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } };

function head(options: { tools?: Tool[]; sections?: Record<string, string> } = {}): SystemMessage {
  return {
    role: "system",
    content: "You are a helpful assistant.",
    sections: options.sections ?? { "workspace-context": "<workspace>repo</workspace>", "memory-recall": "<memory>none</memory>" },
    toolsAdded: options.tools ?? [readTool, writeTool],
    timestamp: 1,
  };
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 2 };
}

function assistant(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "acme",
    model: "large",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 3,
  } as AssistantMessage;
}

/** A response that billed `input` fresh tokens and read `cacheRead` from cache. */
function response(options: { timestamp: number; input: number; cacheRead: number; cacheWrite?: number; model?: PromptCacheModelRef }): PromptCacheResponse {
  const model = options.model ?? MODEL;
  const cacheWrite = options.cacheWrite ?? 0;
  return {
    provider: model.provider,
    model: model.id,
    timestamp: options.timestamp,
    usage: {
      input: options.input,
      cacheRead: options.cacheRead,
      cacheWrite,
      cost: { input: options.input * 3e-6, cacheRead: options.cacheRead * 0.3e-6, cacheWrite: cacheWrite * 3.75e-6 },
    },
  };
}

const baseHistory = (): Message[] => [head(), user("first question"), assistant("first answer"), user("second question")];

/**
 * Warm the chat with one request that wrote its prefix to the cache, then send
 * `second` and bill it as a full miss. Returns the miss report.
 */
function missAfter(second: { messages: Message[]; model?: PromptCacheModelRef; idleMs?: number }): PromptCacheMissReport | undefined {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("chat-1", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 200, cacheRead: 0, cacheWrite: 20_000 }));
  clock += second.idleMs ?? 30_000;
  const model = second.model ?? MODEL;
  return telemetry
    .beginRequest("chat-1", { messages: second.messages, model })
    .complete(response({ timestamp: clock, input: 20_500, cacheRead: 0, model }));
}

test("a changed tool description is attributed to the tools section", () => {
  const renamed: Tool = { ...readTool, description: "Read a file from the workspace" };
  const [, ...rest] = baseHistory();
  const miss = missAfter({ messages: [head({ tools: [renamed, writeTool] }), ...rest] });
  assert.equal(miss?.source, "tools");
  assert.ok(miss.missedTokens > 1024);
});

test("a changed system section names that section", () => {
  const [, ...rest] = baseHistory();
  const miss = missAfter({
    messages: [head({ sections: { "workspace-context": "<workspace>repo</workspace>", "memory-recall": "<memory>a new recollection</memory>" } }), ...rest],
  });
  assert.equal(miss?.source, "system:memory-recall");
});

test("a per-generation nonce on a section name is not reported as part of the label", () => {
  const nonceA = "agents-instructions-0f8b2c1e-1111-4a2b-9c3d-aaaaaaaaaaaa";
  const nonceB = "agents-instructions-0f8b2c1e-2222-4a2b-9c3d-bbbbbbbbbbbb";
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  const withSection = (name: string, text: string) => [
    { ...head(), sections: { "workspace-context": "<workspace>repo</workspace>", [name]: text } } as SystemMessage,
    user("q"),
  ];
  telemetry.beginRequest("c", { messages: withSection(nonceA, "rules"), model: MODEL }).complete(response({ timestamp: clock, input: 100, cacheRead: 0, cacheWrite: 9_000 }));
  clock += 1_000;
  const miss = telemetry.beginRequest("c", { messages: withSection(nonceB, "new rules"), model: MODEL }).complete(response({ timestamp: clock, input: 9_100, cacheRead: 0 }));
  assert.equal(miss?.source, "system:agents-instructions");
});

test("an edited earlier message is attributed to messages at its transcript index", () => {
  const edited = baseHistory();
  edited[2] = assistant("first answer, trimmed");
  const miss = missAfter({ messages: [...edited, assistant("second answer"), user("third question")] });
  assert.equal(miss?.source, "messages");
  assert.equal(miss.messageIndex, 2);
  assert.equal(miss.messageRole, "assistant");
});

test("a model switch is attributed to the model even when the transcript also grew", () => {
  const miss = missAfter({ messages: [...baseHistory(), assistant("second answer"), user("third")], model: OTHER_MODEL });
  assert.equal(miss?.source, "model");
  assert.equal(miss.modelChanged, true);
});

test("an unchanged prefix after an idle gap past the cache lifetime is a TTL lapse", () => {
  const miss = missAfter({ messages: [...baseHistory(), assistant("second answer"), user("third")], idleMs: PROMPT_CACHE_TTL_MS + 1 });
  assert.equal(miss?.source, "ttl");
  assert.ok(miss.idleMs > PROMPT_CACHE_TTL_MS);
});

test("an unchanged prefix that still missed inside the cache lifetime is not blamed on any section", () => {
  const miss = missAfter({ messages: [...baseHistory(), assistant("second answer"), user("third")], idleMs: 10_000 });
  assert.equal(miss?.source, "unknown");
});

test("an appended turn that read its prefix from cache is not a miss", () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("c", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 200, cacheRead: 0, cacheWrite: 20_000 }));
  clock += 5_000;
  const miss = telemetry
    .beginRequest("c", { messages: [...baseHistory(), assistant("a"), user("b")], model: MODEL })
    .complete(response({ timestamp: clock, input: 600, cacheRead: 20_100 }));
  assert.equal(miss, undefined);
  assert.equal(telemetry.lastMiss("c"), undefined);
});

test("a miss within the cache breakpoint noise floor is ignored", () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("c", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 100, cacheRead: 0, cacheWrite: 20_000 }));
  clock += 5_000;
  const miss = telemetry
    .beginRequest("c", { messages: [...baseHistory(), assistant("a"), user("b")], model: MODEL })
    .complete(response({ timestamp: clock, input: 1_000, cacheRead: 19_500 }));
  assert.equal(miss, undefined);
});

test("a provider that never reports cache usage never produces misses", () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("c", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 20_000, cacheRead: 0 }));
  clock += 5_000;
  const [, ...rest] = baseHistory();
  const miss = telemetry
    .beginRequest("c", { messages: [head({ tools: [readTool] }), ...rest], model: MODEL })
    .complete(response({ timestamp: clock, input: 20_000, cacheRead: 0 }));
  assert.equal(miss, undefined);
});

test("a cache-warming read restarts the cache lifetime", () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("c", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 200, cacheRead: 0, cacheWrite: 20_000 }));
  clock += PROMPT_CACHE_TTL_MS - 10_000;
  telemetry.observeWarm("c", response({ timestamp: clock, input: 1, cacheRead: 20_200 }));
  clock += PROMPT_CACHE_TTL_MS - 10_000;
  const miss = telemetry
    .beginRequest("c", { messages: [...baseHistory(), assistant("a"), user("b")], model: MODEL })
    .complete(response({ timestamp: clock, input: 20_500, cacheRead: 0 }));
  assert.equal(miss?.source, "unknown");
  assert.ok(miss.idleMs < PROMPT_CACHE_TTL_MS);
});

test("after a reset the next request has nothing to compare and is not a miss", () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("c", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 200, cacheRead: 0, cacheWrite: 20_000 }));
  telemetry.reset("c");
  clock += 1_000;
  const miss = telemetry
    .beginRequest("c", { messages: [head(), user("summary of earlier work"), user("next")], model: MODEL })
    .complete(response({ timestamp: clock, input: 4_000, cacheRead: 0, cacheWrite: 4_000 }));
  assert.equal(miss, undefined);
});

test("chats are tracked independently", () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  telemetry.beginRequest("a", { messages: baseHistory(), model: MODEL }).complete(response({ timestamp: clock, input: 200, cacheRead: 0, cacheWrite: 20_000 }));
  clock += 1_000;
  const first = telemetry.beginRequest("b", { messages: [head({ tools: [readTool] }), user("hi")], model: MODEL }).complete(response({ timestamp: clock, input: 20_000, cacheRead: 0, cacheWrite: 1 }));
  assert.equal(first, undefined, "the first request in another chat has no previous request");
  assert.equal(telemetry.lastMiss("a"), undefined);
});

test("the miss log carries labels and hashes but none of the transcript text", () => {
  const secret = "the launch code is swordfish";
  const edited = baseHistory();
  edited[1] = user(secret);
  const miss = missAfter({ messages: edited });
  assert.equal(miss?.source, "messages");
  const line = formatPromptCacheMissLog(miss);
  assert.match(line, /source=messages/);
  assert.match(line, /index=1/);
  assert.ok(!line.includes("swordfish"));
  assert.ok(!JSON.stringify(miss).includes("swordfish"), "the report holds no transcript text");
});

test("the stream wrapper reports a miss once the response settles and passes the stream through", async () => {
  let clock = 1_000;
  const telemetry = createPromptCacheTelemetry({ now: () => clock });
  const responses = [response({ timestamp: 1_000, input: 200, cacheRead: 0, cacheWrite: 20_000 }), response({ timestamp: 2_000, input: 20_500, cacheRead: 0 })];
  let calls = 0;
  const inner: StreamFn = async () => {
    const message = responses[calls++]!;
    return { result: async () => message } as unknown as Awaited<ReturnType<StreamFn>>;
  };
  const misses: PromptCacheMissReport[] = [];
  const wrapped = withPromptCacheTelemetry(inner, { telemetry, chatKey: "c", onMiss: (miss) => misses.push(miss) });
  const model = { provider: MODEL.provider, id: MODEL.id, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } as unknown as Parameters<StreamFn>[0];
  const firstStream = await wrapped(model, normalizeContext({ messages: baseHistory() }), {});
  await firstStream.result();
  clock = 2_000;
  const [, ...rest] = baseHistory();
  const secondStream = await wrapped(model, normalizeContext({ messages: [head({ tools: [writeTool] }), ...rest] }), {});
  assert.equal(await secondStream.result(), responses[1], "the caller gets the inner stream's result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    misses.map((miss) => miss.source),
    ["tools"],
  );
  assert.equal(telemetry.lastMiss("c")?.source, "tools");
});
