import assert from "node:assert/strict";
import test from "node:test";
import type { Message, Model } from "@earendil-works/pi-ai";
import { BTW_LIMITS } from "../../../renderer/shared/btw.js";
import { boundedContextMessages, boundedHistory, buildBtwContext } from "./context.js";

const model = {
  id: "model-a",
  name: "Model A",
  provider: "provider-a",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
} as Model<any>;

test("BTW context strips thinking/tool calls and bounds old messages", () => {
  const messages: Message[] = Array.from({ length: BTW_LIMITS.contextMessages + 20 }, (_, index) =>
    index % 2 === 0
      ? { role: "user", content: `question-${index}`, timestamp: index }
      : {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: `answer-${index}` },
            { type: "toolCall", id: `tool-${index}`, name: "write", arguments: {} },
          ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: index,
        },
  );
  const bounded = boundedContextMessages(messages);
  assert.ok(bounded.length <= BTW_LIMITS.contextMessages);
  assert.equal(bounded[0]?.role, "user");
  assert.doesNotMatch(JSON.stringify(bounded), /private reasoning|toolCall/u);
});

test("BTW context drops tool calls and tool results with their content", () => {
  const messages: Message[] = [
    { role: "user", content: "visible question", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        { type: "toolCall", id: "secret-read", name: "read", arguments: { path: "/private" } },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "secret-read",
      toolName: "read",
      content: [{ type: "text", text: "TOP SECRET TOOL OUTPUT" }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "next visible question", timestamp: 4 },
  ];

  const serialized = JSON.stringify(boundedContextMessages(messages));
  assert.doesNotMatch(serialized, /toolCall|toolResult|secret-read|TOP SECRET|\/private/u);
  assert.match(serialized, /visible answer/u);
  assert.match(serialized, /next visible question/u);
});

test("BTW history keeps only a bounded newest suffix", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    question: `q-${index}`,
    answer: `a-${index}`,
    timestamp: index,
  }));
  const bounded = boundedHistory(history);
  assert.equal(bounded.length, BTW_LIMITS.historyTurns);
  assert.equal(bounded[0]?.question, "q-12");
  assert.equal(bounded[bounded.length - 1]?.question, "q-19");
});

test("BTW build appends side history and question with no tools", () => {
  const built = buildBtwContext({
    branch: [{ role: "user", content: "main question", timestamp: 1 }, {
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    }],
    history: [{ question: "prior side", answer: "prior answer", timestamp: 3 }],
    question: "current side",
    model,
  });
  assert.equal(built.messages[built.messages.length - 1]?.role, "user");
  assert.match(JSON.stringify(built.messages), /prior side.*prior answer.*current side/u);
});
