import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";

import {
  MAX_ANTHROPIC_CACHE_BREAKPOINTS,
  MAX_BEDROCK_CACHE_POINTS,
  anthropicCacheBreakpoints,
  bedrockCachePoints,
  rememberStableHead,
  stableHeadOf,
  withPromptCacheBreakpoints,
} from "./prompt-cache-breakpoints.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const STABLE_HEAD = "You are the fixture agent.\n\nFollow the fixture rules.";
const FROZEN_TAIL = "<volatile_memory>fixture memory</volatile_memory>";
const SYSTEM_PROMPT = `${STABLE_HEAD}\n\n${FROZEN_TAIL}`;
const TOOLS: Tool[] = [
  { name: "read_fixture", description: "Read a fixture.", parameters: { type: "object", properties: {} } as Tool["parameters"] },
  { name: "write_fixture", description: "Write a fixture.", parameters: { type: "object", properties: {} } as Tool["parameters"] },
];

const anthropicModel: Model<Api> = {
  id: "fixture-model", name: "Fixture", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"], cost: ZERO_COST,
  contextWindow: 200_000, maxTokens: 8_192,
};
const bedrockModel: Model<Api> = {
  id: "fixture-model", name: "Fixture", api: "bedrock-converse-stream", provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", reasoning: false, input: ["text"], cost: ZERO_COST,
  contextWindow: 200_000, maxTokens: 8_192,
};

function context(systemPrompt = SYSTEM_PROMPT) {
  return normalizeContext({
    systemPrompt,
    tools: TOOLS,
    messages: [{ role: "user", content: "Synthetic breakpoint check", timestamp: 1 }],
  });
}

/** The Anthropic request body the real Pi adapter sends, captured at fetch. */
async function sentAnthropic(chatId: string, options: Partial<SimpleStreamOptions> = {}, systemPrompt = SYSTEM_PROMPT) {
  const { anthropicMessagesApi } = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
  const stream = withPromptCacheBreakpoints(anthropicMessagesApi().streamSimple);
  let body: Record<string, unknown> | undefined;
  await stream(anthropicModel, context(systemPrompt), {
    apiKey: "offline-fixture",
    sessionId: chatId,
    ...options,
    fetch: async (_url: unknown, init?: RequestInit) => {
      body ??= JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw new Error("captured before network");
    },
  }).result();
  assert.ok(body, "Pi built a request");
  return body;
}

/** The Bedrock payload the real Pi adapter builds, as the last payload hook sees it. */
async function sentBedrock(chatId: string, options: Partial<SimpleStreamOptions> = {}, forceCache = true) {
  const { bedrockConverseStreamApi } = await import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy");
  const stream = withPromptCacheBreakpoints(bedrockConverseStreamApi().streamSimple);
  let payload: Record<string, unknown> | undefined;
  await stream(bedrockModel, context(), {
    sessionId: chatId,
    env: {
      AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "offline", AWS_SECRET_ACCESS_KEY: "offline",
      ...(forceCache ? { AWS_BEDROCK_FORCE_CACHE: "1" } : {}),
    },
    ...options,
    onPayload: (request) => {
      payload = request as Record<string, unknown>;
      throw new Error("captured before network");
    },
  } as SimpleStreamOptions).result();
  assert.ok(payload, "Pi built a request");
  return payload;
}

function systemBlocks(body: Record<string, unknown>) {
  return body.system as Array<{ type: string; text: string; cache_control?: unknown }>;
}

test("stableHeadOf splits only a prompt that ends with its frozen-state tail", () => {
  assert.equal(stableHeadOf(SYSTEM_PROMPT, FROZEN_TAIL), STABLE_HEAD);
  assert.equal(stableHeadOf(STABLE_HEAD, ""), undefined, "no tail, no split");
  assert.equal(stableHeadOf(`${SYSTEM_PROMPT}\n\nlater text`, FROZEN_TAIL), undefined, "the tail must be last");
  assert.equal(stableHeadOf(`\n\n${FROZEN_TAIL}`, FROZEN_TAIL), undefined, "a blank head is not a head");
});

test("Anthropic: the stable head gets the fourth breakpoint and a tail change keeps it byte-identical", async () => {
  rememberStableHead("chat-head", STABLE_HEAD);
  const body = await sentAnthropic("chat-head");
  assert.equal(anthropicCacheBreakpoints(body), MAX_ANTHROPIC_CACHE_BREAKPOINTS);
  const [head, tail] = systemBlocks(body);
  assert.equal(head.text, STABLE_HEAD);
  assert.ok(head.cache_control, "the stable head is a cache breakpoint");
  assert.ok(tail.text.startsWith(FROZEN_TAIL), "the frozen-state tail follows in its own block");
  assert.ok(tail.cache_control, "the system prompt as a whole stays a breakpoint");
  assert.equal(systemBlocks(body).map((block) => block.text).join("\n\n").startsWith(SYSTEM_PROMPT), true,
    "the model reads the same system text");

  const tools = body.tools as Array<{ cache_control?: unknown }>;
  assert.ok(tools[tools.length - 1]?.cache_control, "Pi's tool breakpoint is kept");

  const changed = await sentAnthropic("chat-head", {}, `${STABLE_HEAD}\n\n<volatile_memory>new memory</volatile_memory>`);
  assert.deepEqual(changed.tools, body.tools);
  assert.deepEqual(systemBlocks(changed)[0], head, "the cached prefix through the stable head is unchanged");
  assert.notDeepEqual(systemBlocks(changed)[1], tail);
});

test("Anthropic: nothing is added without a matching head, with caching off, or when four markers are already set", async () => {
  rememberStableHead("chat-mismatch", "A head the system prompt does not start with.");
  const cases: Array<[string, Partial<SimpleStreamOptions>]> = [
    ["chat-unregistered", {}],
    ["chat-mismatch", {}],
  ];
  for (const [chatId, options] of cases) {
    const body = await sentAnthropic(chatId, options);
    assert.equal(systemBlocks(body).length, 1, chatId);
    assert.equal(anthropicCacheBreakpoints(body), 3, chatId);
  }

  rememberStableHead("chat-off", STABLE_HEAD);
  const off = await sentAnthropic("chat-off", { cacheRetention: "none" });
  assert.equal(anthropicCacheBreakpoints(off), 0);

  rememberStableHead("chat-oauth", STABLE_HEAD);
  const oauth = await sentAnthropic("chat-oauth", { apiKey: "sk-ant-oat01-offline-fixture" });
  assert.ok(anthropicCacheBreakpoints(oauth) <= MAX_ANTHROPIC_CACHE_BREAKPOINTS);
  assert.equal(systemBlocks(oauth).some((block) => block.text === STABLE_HEAD), false);
});

test("Anthropic: a caller's payload hook sees the final payload and its replacement wins", async () => {
  rememberStableHead("chat-hook", STABLE_HEAD);
  let seen: unknown;
  const body = await sentAnthropic("chat-hook", {
    onPayload: (payload) => {
      seen = payload;
      return { ...(payload as Record<string, unknown>), metadata: { user_id: "fixture-hook" } };
    },
  });
  assert.equal(anthropicCacheBreakpoints(seen), MAX_ANTHROPIC_CACHE_BREAKPOINTS);
  assert.deepEqual(body.metadata, { user_id: "fixture-hook" });
  assert.equal(systemBlocks(body)[0].text, STABLE_HEAD);
});

test("Bedrock: a cachePoint follows the tools, with the system cachePoint's shape, and tools stay declared", async () => {
  for (const cacheRetention of ["short", "long"] as const) {
    const payload = await sentBedrock("chat-bedrock", { cacheRetention });
    const toolConfig = payload.toolConfig as { tools: Array<Record<string, unknown>> };
    assert.deepEqual(toolConfig.tools.slice(0, -1).map((tool) => (tool.toolSpec as { name: string }).name),
      ["read_fixture", "write_fixture"]);
    const systemPoint = (payload.system as Array<Record<string, unknown>>).find((block) => block.cachePoint)?.cachePoint;
    assert.deepEqual(toolConfig.tools[toolConfig.tools.length - 1], { cachePoint: systemPoint });
    assert.ok(bedrockCachePoints(payload) <= MAX_BEDROCK_CACHE_POINTS);
    assert.equal(bedrockCachePoints(payload), 3, "system, tools and the last user message");
  }
});

test("Bedrock: no tools cachePoint when caching is off or the model does not cache", async () => {
  const off = await sentBedrock("chat-bedrock-off", { cacheRetention: "none" });
  assert.equal(bedrockCachePoints(off), 0);
  const uncached = await sentBedrock("chat-bedrock-uncached", {}, false);
  assert.equal(bedrockCachePoints(uncached), 0);
  assert.equal((uncached.toolConfig as { tools: unknown[] }).tools.length, TOOLS.length);
});

test("other APIs pass through without a payload hook", () => {
  let received: SimpleStreamOptions | undefined;
  const inner = ((_model, _context, options) => {
    received = options;
    throw new Error("captured");
  }) as Parameters<typeof withPromptCacheBreakpoints>[0];
  const options: SimpleStreamOptions = { sessionId: "chat-other" };
  assert.throws(() => withPromptCacheBreakpoints(inner)({ ...anthropicModel, api: "openai-completions" }, context(), options));
  assert.strictEqual(received, options);
  assert.equal(received?.onPayload, undefined);
});
