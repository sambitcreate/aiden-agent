import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { createInitialSystemMessage, getCurrentSystemPrompt, getCurrentTools, Type } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  assertGenerationContextCapacity,
  chatContextPressureFromProjection,
  compactGenerationContext,
  createGenerationContextTransform,
  limitComputerUseImages,
  limitBrowserSnapshotImages,
  projectChatContextPressure,
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

test("browser image history preserves text, errors, pairing and the newest three results independently of Computer Use", () => {
  const messages: AgentMessage[] = [user("Inspect the browser and the desktop.")];
  for (let index = 0; index < 6; index += 1) {
    for (const toolName of ["browser_snapshot", "computer_use"]) {
      const id = `${toolName}-${index}`;
      const result = toolResult(id, [{ type: "text", text: `${id}: ${index === 0 ? "Error: login failed" : "actionable locator #save"}` }, { type: "image", data: id, mimeType: "image/png" }], toolName);
      if (index === 0) result.isError = true;
      messages.push(assistant(id, toolName), result);
    }
    messages.push(assistant(`browser-text-${index}`, "browser_snapshot"), toolResult(`browser-text-${index}`, "text only; no screenshot allowance used", "browser_snapshot"));
  }
  const durable = JSON.stringify(messages);
  const checkpoint = { role: "compactionSummary", summary: "Keep the user's styling decision", tokensBefore: 1_000, timestamp: 1 } as AgentMessage;
  messages.unshift(checkpoint);
  const projected = compactGenerationContext(messages, options);
  assert.equal(projected.compacted, false);
  assert.equal(projected.messages[0], checkpoint);
  assertToolProtocolIsPaired(projected.messages);
  for (const name of ["browser_snapshot", "computer_use"]) {
    const results = projected.messages.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === name);
    const images = results.flatMap((result) => result.content.filter((part) => part.type === "image").map((part) => part.data));
    assert.deepEqual(images, [3, 4, 5].map((index) => `${name}-${index}`));
    const oldest = results.find((result) => result.toolCallId === `${name}-0`)!;
    assert.equal(oldest.isError, true);
    assert.match(JSON.stringify(oldest.content), /Error: login failed/);
  }
  assert.equal(JSON.stringify(messages.slice(1)), durable);
  assert.deepEqual(projectNextContextUsage(messages, options), projectNextContextUsage(projected.messages, options));
});

test("browser screenshot projection counts image-bearing results and leaves other images and journal objects intact", () => {
  const messages: AgentMessage[] = [user("Compare snapshots")];
  for (let index = 0; index < 4; index += 1) {
    messages.push(assistant(`browser-${index}`, "browser_snapshot"), toolResult(`browser-${index}`, [{ type: "text", text: `page-${index}` }, { type: "image", data: `first-${index}`, mimeType: "image/png" }, { type: "image", data: `second-${index}`, mimeType: "image/png" }], "browser_snapshot"));
  }
  const unrelated = toolResult("read", [{ type: "image", data: "attachment", mimeType: "image/png" }]);
  messages.push(assistant("read"), unrelated);
  const projected = limitBrowserSnapshotImages(messages);
  assert.equal(projected[projected.length - 1], unrelated);
  assert.equal(projected.filter((message) => message.role === "toolResult").flatMap((message) => message.role === "toolResult" ? message.content.filter((part) => part.type === "image") : []).length, 7);
  assert.equal((messages[2] as ToolResultMessage).content.length, 3);
  assert.equal(limitBrowserSnapshotImages(messages, Number.POSITIVE_INFINITY), messages);
  const textOnly = compactGenerationContext(messages, { ...options, supportsImages: false });
  assert.equal(JSON.stringify(textOnly.messages).includes('"type":"image"'), false);
  assert.match(JSON.stringify(textOnly.messages), /private journal/);
  assert.equal((messages[2] as ToolResultMessage).content.length, 3);
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

test("emergency projection retains the transcript prompt and tool declarations", () => {
  const system = createInitialSystemMessage("Keep the host policy", [{
    name: "safe_read", description: "Read a fixture", parameters: Type.Object({}),
  }]);
  assert.ok(system);
  const messages = [system, user("x".repeat(100_000))] as AgentMessage[];
  const result = compactGenerationContext(messages, { ...options, contextWindow: 8_000 });
  assert.equal(result.usedContextFallback, true);
  assert.equal(result.messages[0]?.role, "system");
  assert.equal(getCurrentSystemPrompt(result.messages), "Keep the host policy");
  assert.deepEqual(getCurrentTools(result.messages).map((tool) => tool.name), ["safe_read"]);
  assert.equal(result.messages[1]?.role, "user");
  assert.deepEqual(messages[0], system);
});

test("history pruning and emergency fallback replay all system patches", () => {
  const base = createInitialSystemMessage("Keep host policy", [{
    name: "safe_read", description: "Read a fixture", parameters: Type.Object({}),
  }]);
  assert.ok(base);
  const patch = { role: "system" as const, content: "", timestamp: 2,
    sections: { "agents-instructions": "Follow workspace guidance" } };
  const history = compactGenerationContext(
    [base, user("x".repeat(100_000)), patch, user("Continue")],
    { ...options, contextWindow: 8_000 },
  );
  assert.equal(history.removedHistoryMessages, 1);
  assert.equal(history.messages[0]?.role, "system");
  assert.equal(history.messages[1]?.role, "user");
  assert.match(getCurrentSystemPrompt(history.messages), /Follow workspace guidance/u);
  const emergency = compactGenerationContext(
    [base, patch, user("x".repeat(100_000))],
    { ...options, contextWindow: 8_000 },
  );
  assert.equal(emergency.usedContextFallback, true);
  assert.deepEqual(emergency.messages.slice(0, 2).map((message) => message.role), ["system", "user"]);
  assert.match(getCurrentSystemPrompt(emergency.messages), /Follow workspace guidance/u);
  assert.deepEqual(getCurrentTools(emergency.messages).map((tool) => tool.name), ["safe_read"]);
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

test("the composer DTO mirrors the runtime projection and limits", () => {
  const anchored = assistant("anchored");
  anchored.usage.input = 50_000;
  anchored.usage.totalTokens = 60_000;
  const messages = [user("old"), anchored, user("current")];
  const pressure = projectChatContextPressure(messages, options);
  const projection = projectNextContextUsage(messages, options);
  // The DTO helper and the projection-first builder agree.
  assert.deepEqual(
    { ...chatContextPressureFromProjection(projection, options, pressure.computedAt) },
    pressure,
  );

  assert.equal(pressure.contextTokens, projection.contextTokens);
  assert.equal(pressure.messageTokens, projection.messageTokens);
  assert.equal(pressure.staticTokens, projection.staticTokens);
  assert.equal(pressure.shouldCompact, projection.shouldCompact);
  assert.equal(pressure.contextWindow, options.contextWindow);
  // Usable-input pressure is what matches the compaction threshold.
  assert.ok(pressure.inputBudgetTokens < pressure.contextWindow);
  assert.equal(
    pressure.inputBudgetTokens + pressure.reservedTokens,
    pressure.contextWindow,
  );
  assert.ok(pressure.percentOfUsableInput > pressure.percentOfWindow);
  assert.equal(pressure.source, "provider-anchored");
  assert.equal(pressure.providerUsageTokens, projection.providerUsageTokens);
  assert.equal(
    pressure.addedAfterUsageAnchorTokens,
    projection.addedAfterUsageAnchorTokens,
  );
  assert.equal(
    pressure.compressibleHistoryMessages,
    projection.compressibleHistoryMessages,
  );
});

test("unanchored projections read as estimates and still trip compaction", () => {
  const pressure = projectChatContextPressure([user("x".repeat(200_000))], {
    contextWindow: 4_096,
    systemPrompt: "system",
    tools: [],
  });
  assert.equal(pressure.source, "estimated");
  assert.equal(pressure.providerUsageTokens, undefined);
  assert.equal(pressure.addedAfterUsageAnchorTokens, undefined);
  assert.equal(pressure.shouldCompact, true);
  // Over-budget requests report honest >100% pressure — never clamped.
  assert.ok(pressure.percentOfUsableInput > 100);
});

test("a projection after compaction reports the post-compaction truth", () => {
  const big = [
    user("old ".repeat(8_000)),
    assistant("old-call"),
    toolResult("old-call", "y".repeat(40_000)),
    user("current"),
  ];
  const before = projectChatContextPressure(big, { ...options, contextWindow: 8_000 });
  assert.equal(before.shouldCompact, true);

  const compacted = compactGenerationContext(big, { ...options, contextWindow: 8_000 });
  const after = projectChatContextPressure(compacted.messages, {
    ...options,
    contextWindow: 8_000,
  });
  assert.ok(after.contextTokens < before.contextTokens);
  assert.ok(after.percentOfUsableInput < before.percentOfUsableInput);
});

test("model changes rescale capacity without touching the conversation", () => {
  const messages = [user("hello"), assistant("answer", "chat")];
  const small = projectChatContextPressure(messages, {
    ...options,
    contextWindow: 4_096,
  });
  const large = projectChatContextPressure(messages, options);
  assert.equal(small.contextTokens, large.contextTokens);
  assert.ok(small.percentOfUsableInput > large.percentOfUsableInput);
  assert.ok(large.reservedTokens > small.reservedTokens);
});

// Pi keeps later system messages in place for mid-conversation-capable models
// (supportsMidConvoSystemMessages), so every AGENTS.md revision is sent even
// though the replayed prompt only carries the latest one.
function agentsPatch(body: string): AgentMessage {
  return {
    role: "system",
    content: "",
    sections: { "agents-instructions-test": body },
    timestamp: Date.now(),
  } as AgentMessage;
}

test("retained AGENTS.md revisions count toward pressure and compaction for mid-conversation models", () => {
  const head = createInitialSystemMessage("HOST", []) as AgentMessage;
  const messages: AgentMessage[] = [
    head,
    user("first"),
    agentsPatch("A".repeat(8_000)),
    user("second"),
    agentsPatch("B".repeat(8_000)),
    user("x".repeat(36_000)),
  ];
  const base = {
    ...options,
    contextWindow: 16_000,
    systemPrompt: getCurrentSystemPrompt(messages as Parameters<typeof getCurrentSystemPrompt>[0]),
  };
  const folded = projectNextContextUsage(messages, base);
  const retained = projectNextContextUsage(messages, { ...base, retainsSystemUpdates: true });
  // The superseded 8,000-character revision (plus update framing) is extra.
  const extra = retained.messageTokens - folded.messageTokens;
  assert.ok(extra >= 2_000 && extra < 2_100, `extra=${extra}`);
  assert.equal(folded.shouldCompact, false);
  assert.equal(retained.shouldCompact, true);

  // Without later system messages both representations price the same request.
  const headOnly = [head, user("hello")];
  assert.equal(
    projectNextContextUsage(headOnly, { ...base, retainsSystemUpdates: true }).contextTokens,
    projectNextContextUsage(headOnly, base).contextTokens,
  );

  // Compaction sees the same over-budget transcript and replays the prompt into
  // one head, which removes the retained revisions from the outbound request.
  const compacted = compactGenerationContext(messages, { ...base, retainsSystemUpdates: true });
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.estimatedTokensBefore > compactGenerationContext(messages, base).estimatedTokensBefore);
  assert.equal(compacted.messages.filter((message) => message.role === "system").length, 1);
  assert.ok(compacted.estimatedTokensAfter <= compacted.inputBudgetTokens);
});

function usageAssistant(input: number, text = "done"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    usage: {
      input,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function agentsRemoval(): AgentMessage {
  return {
    role: "system",
    content: "",
    sections: { "agents-instructions-test": null },
    timestamp: Date.now(),
  } as AgentMessage;
}

test("retained AGENTS.md revisions after a stale usage anchor count toward anchored pressure and compaction", () => {
  const head = createInitialSystemMessage("HOST", []) as AgentMessage;
  // A valid 95k anchor, then revisions the provider has not reported on yet: a
  // zero-usage response leaves the anchor where it was.
  const messages: AgentMessage[] = [
    head,
    user("first"),
    agentsPatch("P".repeat(16_384)),
    usageAssistant(95_000),
    agentsPatch("A".repeat(16_384)),
    usageAssistant(0),
    agentsPatch("B".repeat(8_192)),
    agentsRemoval(),
    user("next"),
  ];
  const base = {
    ...options,
    contextWindow: 120_000,
    systemPrompt: getCurrentSystemPrompt(messages as Parameters<typeof getCurrentSystemPrompt>[0]),
  };
  const folded = projectNextContextUsage(messages, base);
  const retained = projectNextContextUsage(messages, { ...base, retainsSystemUpdates: true });
  assert.equal(folded.usageAnchorIndex, 3);
  assert.equal(retained.usageAnchorIndex, 3);
  assert.ok(folded.contextTokens < 96_000, `folded=${folded.contextTokens}`);
  assert.equal(folded.shouldCompact, false);
  // Both post-anchor revisions (16 KiB + 8 KiB) and the removal are sent; the
  // revision before the anchor is already inside the provider's 95k.
  const extra = retained.contextTokens - folded.contextTokens;
  assert.ok(extra >= 6_144 && extra < 6_300, `extra=${extra}`);
  assert.equal(retained.shouldCompact, true);

  // The compaction decision uses the same anchored tail.
  const foldedCompaction = compactGenerationContext(messages, base);
  const retainedCompaction = compactGenerationContext(messages, { ...base, retainsSystemUpdates: true });
  assert.equal(foldedCompaction.compacted, false);
  assert.ok(
    retainedCompaction.estimatedTokensBefore - foldedCompaction.estimatedTokensBefore >= 6_144,
    `before=${retainedCompaction.estimatedTokensBefore} folded=${foldedCompaction.estimatedTokensBefore}`,
  );
  assert.ok(retainedCompaction.estimatedTokensBefore > retainedCompaction.inputBudgetTokens);

  // A single post-anchor revision (Pullfrog's case) is enough to cross 97.5k.
  const single: AgentMessage[] = [
    head,
    user("first"),
    usageAssistant(95_000),
    agentsPatch("A".repeat(16_384)),
    usageAssistant(0),
    agentsRemoval(),
    user("next"),
  ];
  const singleBase = {
    ...base,
    systemPrompt: getCurrentSystemPrompt(single as Parameters<typeof getCurrentSystemPrompt>[0]),
  };
  assert.equal(projectNextContextUsage(single, singleBase).shouldCompact, false);
  assert.equal(projectNextContextUsage(single, { ...singleBase, retainsSystemUpdates: true }).shouldCompact, true);
});

test("an AGENTS.md revision still active after a stale anchor is priced once near the threshold", () => {
  const head = createInitialSystemMessage("HOST", []) as AgentMessage;
  // The provider has reported neither revision. The active 8 KiB revision is
  // also in the replayed static prompt, so only the superseded 16 KiB one and
  // the update framing are extra in totals that add static context.
  const transcript = (usage: number): AgentMessage[] => [
    head,
    user("first"),
    usageAssistant(usage),
    agentsPatch("A".repeat(16_384)),
    usageAssistant(0),
    agentsPatch("B".repeat(8_192)),
    user("next"),
  ];
  const project = (usage: number, retainsSystemUpdates: boolean) => {
    const messages = transcript(usage);
    const base = {
      ...options,
      contextWindow: 120_000,
      systemPrompt: getCurrentSystemPrompt(messages as Parameters<typeof getCurrentSystemPrompt>[0]),
      retainsSystemUpdates,
    };
    return { messages, base, projection: projectNextContextUsage(messages, base) };
  };

  // Threshold is 97,616. Both revisions are sent once (about 6.2k over the
  // usage); pricing the active one again would add about 2k more.
  const near = project(90_000, true);
  const sentOnce = near.projection.contextTokens - 90_000;
  assert.ok(sentOnce >= 6_144 && sentOnce < 6_400, `sentOnce=${sentOnce}`);
  assert.equal(near.projection.shouldCompact, false);
  // The static-inclusive anchored term prices only what the static prompt lacks.
  assert.ok(
    near.projection.addedAfterUsageAnchorTokens >= 4_096 &&
      near.projection.addedAfterUsageAnchorTokens < 4_200,
    `tail=${near.projection.addedAfterUsageAnchorTokens}`,
  );
  const nearCompaction = compactGenerationContext(near.messages, near.base);
  assert.equal(nearCompaction.compacted, false);
  assert.ok(nearCompaction.estimatedTokensBefore < 97_616, `before=${nearCompaction.estimatedTokensBefore}`);

  // Still more than the folded model, and a slightly larger anchor crosses.
  assert.ok(near.projection.contextTokens > project(90_000, false).projection.contextTokens);
  const over = project(92_000, true);
  assert.equal(over.projection.shouldCompact, true);

  // Compaction candidates price the same request: keeping both revisions is
  // over budget, so the prompt is replayed into one head. That head carries the
  // active revision the 92k usage never saw.
  const overCompaction = compactGenerationContext(over.messages, over.base);
  assert.equal(overCompaction.compacted, true);
  assert.equal(overCompaction.messages.filter((message) => message.role === "system").length, 1);
  assert.ok(
    overCompaction.estimatedTokensAfter >= 92_000 + 2_048,
    `after=${overCompaction.estimatedTokensAfter}`,
  );
  assert.ok(overCompaction.estimatedTokensAfter <= overCompaction.inputBudgetTokens);
});
