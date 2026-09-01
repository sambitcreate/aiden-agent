import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  assertGenerationContextCapacity,
  compactGenerationContext,
  createGenerationContextTransform,
  limitComputerUseImages,
  projectNextContextUsage,
  projectMessagesForModel,
} from "./generation-context.js";

const options = {
  contextWindow: 128_000,
  systemPrompt: "You are a coding agent.",
  tools: [],
  providerId: "openai-codex",
  modelId: "gpt-5.3-codex-spark",
};

function user(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistant(
  toolCallId: string,
  toolName = "read_file",
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: { path: `src/${toolCallId}.ts` },
      },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolResult(
  toolCallId: string,
  content: string | ToolResultMessage["content"],
  toolName = "read_file",
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content:
      typeof content === "string" ? [{ type: "text", text: content }] : content,
    isError: false,
    timestamp: Date.now(),
  };
}

function assertToolProtocolIsPaired(messages: AgentMessage[]): void {
  const toolCallIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content
            .filter((part) => part.type === "toolCall")
            .map((part) => part.id)
        : [],
    ),
  );
  const toolResultIds = new Set(
    messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : [],
    ),
  );
  assert.deepEqual(toolResultIds, toolCallIds);
}

test("returns the original context when it fits the model window", () => {
  const messages: AgentMessage[] = [
    user("Hello"),
    assistant("one"),
    toolResult("one", "small"),
  ];
  const result = compactGenerationContext(messages, options);

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
  assert.equal(result.estimatedTokensAfter, result.estimatedTokensBefore);
  assert.equal(result.usedContextFallback, false);
});

test("projects zero-usage restored history plus the current prompt and static context", () => {
  const messages: AgentMessage[] = [
    user(`old ${"x".repeat(8_000)}`),
    assistant("old-call"),
    toolResult("old-call", "done"),
    user(`current ${"y".repeat(4_000)}`),
  ];
  const projection = projectNextContextUsage(messages, {
    contextWindow: 4_096,
    systemPrompt: "system ".repeat(400),
    tools: [],
  });
  assert.equal(projection.providerUsageTokens, 0);
  assert.ok(projection.addedAfterUsageAnchorTokens > 0);
  assert.ok(projection.staticTokens > 0);
  assert.equal(projection.compressibleHistoryMessages, 3);
  assert.equal(projection.shouldCompact, true);
});

test("does not call an irreducible first prompt compressible history", () => {
  const projection = projectNextContextUsage(
    [user("attachment payload ".repeat(10_000))],
    { contextWindow: 2_048, systemPrompt: "system", tools: [] },
  );
  assert.equal(projection.shouldCompact, true);
  assert.equal(projection.compressibleHistoryMessages, 0);
});

test("does not classify an active tool-loop tail as compressible history", () => {
  const projection = projectNextContextUsage(
    [user("active request"), assistant("active"), toolResult("active", "x".repeat(80_000))],
    { ...options, contextWindow: 8_000 },
  );
  assert.equal(projection.shouldCompact, true);
  assert.equal(projection.compressibleHistoryMessages, 0);
});

test("ignores provider usage from a different saved model binding", () => {
  const stale = assistant("stale");
  stale.usage.input = 100_000;
  stale.usage.totalTokens = 100_000;
  const projection = projectNextContextUsage([user("old"), stale, user("new")], {
    ...options,
    providerId: "anthropic",
    modelId: "claude-new",
  });
  assert.equal(projection.providerUsageTokens, 0);
  assert.equal(projection.usageAnchorIndex, null);
  assert.ok(projection.contextTokens < 1_000);
});

test("adds current static context to a matching provider usage anchor", () => {
  const anchored = assistant("anchored");
  anchored.usage.input = 1_000;
  anchored.usage.totalTokens = 1_000;
  const projection = projectNextContextUsage([user("old"), anchored, user("new")], {
    ...options,
    systemPrompt: "expanded instructions ".repeat(1_000),
  });

  assert.equal(projection.providerUsageTokens, 1_000);
  assert.equal(projection.usageAnchorIndex, 1);
  assert.ok(projection.staticTokens > 1_000);
  assert.ok(
    projection.contextTokens >=
      projection.providerUsageTokens + projection.staticTokens,
  );
});

test("projects model-neutral image history only for vision requests", () => {
  const imageUser: UserMessage = {
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "private-image", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  };
  const neutral: AgentMessage[] = [imageUser];

  assert.equal(
    JSON.stringify(projectMessagesForModel(neutral, true)).includes(
      "private-image",
    ),
    true,
  );
  const textOnly = projectMessagesForModel(neutral, false);
  assert.equal(JSON.stringify(textOnly).includes("private-image"), false);
  assert.match(
    JSON.stringify(textOnly),
    /retained in Aiden's private journal/u,
  );
  assert.equal(JSON.stringify(neutral).includes("private-image"), true);
});

test("limitComputerUseImages keeps the newest screenshots and leaves other results alone", () => {
  const messages: AgentMessage[] = [user("Use the desktop.")];
  for (let index = 0; index < 5; index += 1) {
    const id = `cu-${index}`;
    messages.push(
      assistant(id, "computer_use"),
      toolResult(
        id,
        [
          { type: "text", text: `capture-${index}` },
          { type: "image", data: `img-${index}`, mimeType: "image/png" },
        ],
        "computer_use",
      ),
      assistant(`cu-text-${index}`, "computer_use"),
      toolResult(`cu-text-${index}`, `status-${index}`, "computer_use"),
    );
  }
  const otherImage = toolResult(
    "other-image",
    [
      { type: "text", text: "unrelated image" },
      { type: "image", data: "other", mimeType: "image/png" },
    ],
    "read_file",
  );
  messages.push(assistant("other-image"), otherImage);
  const limited = limitComputerUseImages(messages, 3);
  const computerUseResults = limited.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "computer_use",
  );
  const captures = computerUseResults.filter((result) =>
    result.content.some(
      (part) => part.type === "text" && part.text.startsWith("capture-"),
    ),
  );
  assert.equal(computerUseResults.length, 10);
  assert.equal(
    computerUseResults.filter((r) => r.content.some((p) => p.type === "image"))
      .length,
    3,
  );
  assert.equal(
    captures[0]?.content.some((part) => part.type === "image"),
    false,
  );
  assert.equal(
    captures[1]?.content.some((part) => part.type === "image"),
    false,
  );
  assert.equal(
    captures[2]?.content.some((part) => part.type === "image"),
    true,
  );
  assert.equal(
    captures[4]?.content.some((part) => part.type === "image"),
    true,
  );
  assert.equal(limited[limited.length - 1], otherImage);
  assert.equal(
    otherImage.content.some((part) => part.type === "image"),
    true,
  );
  assert.match(
    String(
      captures[0]?.content[0]?.type === "text"
        ? captures[0].content[0].text
        : "",
    ),
    /capture-0/u,
  );
});

test("compactGenerationContext always applies computer_use image retention", () => {
  const messages: AgentMessage[] = [
    user("Hello"),
    assistant("cu-1", "computer_use"),
    toolResult(
      "cu-1",
      [
        { type: "text", text: "first" },
        { type: "image", data: "one", mimeType: "image/png" },
      ],
      "computer_use",
    ),
    assistant("cu-2", "computer_use"),
    toolResult(
      "cu-2",
      [
        { type: "text", text: "second" },
        { type: "image", data: "two", mimeType: "image/png" },
      ],
      "computer_use",
    ),
    assistant("cu-3", "computer_use"),
    toolResult(
      "cu-3",
      [
        { type: "text", text: "third" },
        { type: "image", data: "three", mimeType: "image/png" },
      ],
      "computer_use",
    ),
    assistant("cu-4", "computer_use"),
    toolResult(
      "cu-4",
      [
        { type: "text", text: "fourth" },
        { type: "image", data: "four", mimeType: "image/png" },
      ],
      "computer_use",
    ),
  ];
  const result = compactGenerationContext(messages, options);
  const imagesKept = result.messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" &&
      message.toolName === "computer_use" &&
      message.content.some((part) => part.type === "image"),
  );
  assert.equal(imagesKept.length, 3);
});

test("bounds a Codex-sized discovery loop while preserving recent evidence and tool pairs", () => {
  const messages: AgentMessage[] = [user("Inspect the provider runtime.")];
  for (let index = 0; index < 38; index += 1) {
    const id = `read-${index}`;
    messages.push(
      assistant(id),
      toolResult(id, `${id}\n${"x".repeat(20_000)}`),
    );
  }
  for (let index = 0; index < 8; index += 1) {
    const id = `grep-${index}`;
    messages.push(
      assistant(id, "grep"),
      toolResult(id, `${id}\n${"y".repeat(20_000)}`, "grep"),
    );
  }
  const originalFirstResult = (messages[2] as ToolResultMessage).content[0];
  const result = compactGenerationContext(messages, options);

  assert.equal(result.compacted, true);
  assert.ok(result.compactedToolResults > 0);
  assert.ok(result.estimatedTokensBefore > result.inputBudgetTokens);
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
  assert.equal(originalFirstResult?.type, "text");
  assert.equal(
    originalFirstResult?.type === "text" ? originalFirstResult.text.length : 0,
    20_007,
  );

  const transformedText = JSON.stringify(result.messages);
  assert.match(
    transformedText,
    /payload omitted to stay within the model context window/,
  );
  assert.match(transformedText, /grep-7/);
  assert.doesNotMatch(transformedText, /Call the tool again/u);
  assertToolProtocolIsPaired(result.messages);
});

test("keeps Pi's provider-measured prefix while estimating a compacted trailing result", () => {
  const toolCall = assistant("provider-measured");
  toolCall.usage.input = 101_000;
  toolCall.usage.totalTokens = 101_000;
  const result = compactGenerationContext(
    [
      user("Continue the investigation."),
      toolCall,
      toolResult("provider-measured", "z".repeat(20_000)),
    ],
    options,
  );

  assert.equal(result.compacted, true);
  assert.equal(result.usedContextFallback, false);
  assert.ok(result.estimatedTokensBefore >= 106_000);
  assert.ok(result.estimatedTokensAfter >= 101_000);
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
  assert.match(
    JSON.stringify(result.messages),
    /payload omitted to stay within the model context window/,
  );
  assertToolProtocolIsPaired(result.messages);
});

test("uses a bounded non-tool fallback when the provider-measured prefix cannot fit", () => {
  const toolCall = assistant("provider-overflow");
  toolCall.usage.input = 110_000;
  toolCall.usage.totalTokens = 110_000;
  const messages: AgentMessage[] = [
    user("Continue the investigation."),
    toolCall,
    toolResult("provider-overflow", "z".repeat(20_000)),
  ];
  const result = compactGenerationContext(messages, options);

  assert.equal(result.compacted, true);
  assert.equal(result.usedContextFallback, true);
  assert.ok(result.estimatedTokensBefore >= 115_000);
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
  assert.match(JSON.stringify(result.messages), /larger-context model/u);
  assertToolProtocolIsPaired(result.messages);
});

test("drops oldest complete chat turns before sacrificing the active request", () => {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push(user(`old-user-${index}-${"u".repeat(18_000)}`), {
      ...assistant(`old-${index}`),
      content: [
        { type: "text", text: `old-answer-${index}-${"a".repeat(18_000)}` },
      ],
      stopReason: "stop",
    });
  }
  messages.push(user("current-request"));

  const result = compactGenerationContext(messages, {
    ...options,
    contextWindow: 24_000,
  });

  assert.equal(result.compacted, true);
  assert.ok(result.removedHistoryMessages > 0);
  assert.deepEqual(result.emergencyProjection, {
    kind: "history_removed",
    removedHistoryMessages: result.removedHistoryMessages,
    requiresDurableCheckpoint: true,
  });
  const finalMessage = result.messages[result.messages.length - 1];
  assert.equal(finalMessage?.role, "user");
  assert.equal(
    finalMessage?.role === "user" ? finalMessage.content : "",
    "current-request",
  );
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
});

test("keeps the semantic checkpoint while pruning its retained tail", () => {
  const messages: AgentMessage[] = [
    {
      role: "compactionSummary",
      summary: "Durable checkpoint: keep this exact decision.",
      tokensBefore: 100_000,
      timestamp: 1,
    },
  ];
  for (let index = 0; index < 4; index += 1) {
    messages.push(user(`tail-user-${index}-${"u".repeat(12_000)}`), {
      ...assistant(`tail-${index}`),
      content: [
        { type: "text", text: `tail-answer-${index}-${"a".repeat(12_000)}` },
      ],
      stopReason: "stop",
    });
  }
  messages.push(user("current-request"));

  const result = compactGenerationContext(messages, {
    ...options,
    contextWindow: 16_000,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.messages[0]?.role, "compactionSummary");
  assert.match(JSON.stringify(result.messages[0]), /keep this exact decision/u);
  assert.equal(result.messages[result.messages.length - 1]?.role, "user");
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
});

test("bounds oversized tool text while retaining image evidence without mutating the result", () => {
  const content: ToolResultMessage["content"] = [
    { type: "text", text: `head-${"a".repeat(50_000)}` },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    { type: "text", text: `tail-${"b".repeat(50_000)}` },
    { type: "image", data: "aW1hZ2Uy", mimeType: "image/jpeg" },
  ];
  const resultMessage = { ...toolResult("vision", ""), content };
  const messages: AgentMessage[] = [
    user("Inspect this screenshot."),
    assistant("vision"),
    resultMessage,
  ];
  const snapshot = structuredClone(messages);
  const result = compactGenerationContext(messages, {
    ...options,
    contextWindow: 32_000,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.truncatedToolResults, 1);
  assert.equal(result.emergencyProjection.kind, "active_payload_reduced");
  assert.equal(result.emergencyProjection.requiresDurableCheckpoint, false);
  assert.equal(result.usedContextFallback, false);
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
  const transformedResult = result.messages.find(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
  assert.equal(
    transformedResult?.content.filter((part) => part.type === "image").length,
    2,
  );
  assert.deepEqual(messages, snapshot);
  assertToolProtocolIsPaired(result.messages);
});

test("replaces an oversized active request with a bounded fail-safe notice", () => {
  const messages: AgentMessage[] = [user("x".repeat(100_000))];
  const result = compactGenerationContext(messages, {
    ...options,
    contextWindow: 8_000,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.usedContextFallback, true);
  assert.deepEqual(result.emergencyProjection, {
    kind: "active_payload_replaced",
    category: "active_context_too_large",
    requiresDurableCheckpoint: false,
  });
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
  assert.equal(result.messages.length, 1);
  assert.match(
    JSON.stringify(result.messages),
    /fewer\/lower-size attachments/u,
  );
  assert.equal((messages[0] as UserMessage).content.length, 100_000);
});

test("rejects a model whose static prompt and tools cannot fit even the fail-safe notice", () => {
  assert.throws(
    () =>
      assertGenerationContextCapacity({
        contextWindow: 512,
        systemPrompt: "You are a coding agent.",
        tools: [],
      }),
    /context window is too small/u,
  );
  assert.throws(
    () => assertGenerationContextCapacity({ ...options, contextWindow: 0 }),
    /does not report a usable context window/u,
  );
  assert.doesNotThrow(() => assertGenerationContextCapacity(options));
});

test("never rejects when compaction inputs or observers fail", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const messages: AgentMessage[] = [
    user("safe fallback"),
    user("x".repeat(100_000)),
  ];
  let observerCalls = 0;
  const transform = createGenerationContextTransform(
    {
      ...options,
      contextWindow: 8_000,
      tools: [
        {
          name: "circular",
          label: "Circular",
          description: "test",
          parameters: circular,
          execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ] as never,
    },
    () => {
      observerCalls += 1;
      throw new Error("observer failure");
    },
  );

  await assert.doesNotReject(transform(messages));
  const transformed = await transform(messages);
  assert.equal(transformed.length, 1);
  assert.equal(transformed[0]?.role, "user");
  assert.match(JSON.stringify(transformed), /larger-context model/u);
  assert.equal(observerCalls, 2);
});
