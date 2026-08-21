import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  anthropicMessagesApi,
  openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import type { Model, ProviderStreams } from "@earendil-works/pi-ai";
import {
  PI_AUTH_COMPATIBILITY_TOKEN,
  assistantTurnTextSeparator,
  buildAgentRuntimeOptions,
  resolveGenerationThinkingLevel,
  reconcileTerminalAssistantProjection,
  resolveRuntimeApiKey,
  resolveRuntimeBaseUrl,
  resolveRuntimeHeaders,
  runtimeSupportsImages,
  settleGenerationCleanup,
  shouldExposeReasoning,
  terminalAssistantReasoning,
  terminalAssistantReasoningFallback,
  terminalAssistantText,
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationLengthError,
  terminalGenerationInterruptionError,
  terminalGenerationWasAborted,
  waitForAbortableDelay,
  waitForGenerationStateClear,
} from "./generation-runtime.js";

test("uses only the connection-bound runtime model as the image gate", () => {
  assert.equal(runtimeSupportsImages({ input: ["text"] }), false);
  assert.equal(runtimeSupportsImages({ input: ["text", "image"] }), true);
});

test("model thinking preserves native normalization and honors generic Pi reasoning", () => {
  assert.equal(
    resolveGenerationThinkingLevel("google", { reasoning: true }, "high"),
    "high",
  );
  assert.equal(
    resolveGenerationThinkingLevel("google", { reasoning: true }, undefined),
    "off",
  );
  assert.equal(
    resolveGenerationThinkingLevel("google", { reasoning: false }, "high"),
    "off",
  );
  assert.equal(
    resolveGenerationThinkingLevel("openai", { reasoning: true }, "high"),
    "high",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "bedrock",
      { reasoning: true, thinkingLevelMap: { low: "low" } },
      "high",
    ),
    "off",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "openai-codex",
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      "xhigh",
    ),
    "xhigh",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "openai-codex",
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      undefined,
    ),
    "medium",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "openai-codex",
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      "max",
    ),
    "medium",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "openai-codex",
      {
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      "max",
    ),
    "max",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "openai-codex",
      { reasoning: false },
      "high",
    ),
    "off",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "anthropic",
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
      undefined,
    ),
    "high",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "anthropic",
      { reasoning: true, thinkingLevelMap: { max: "max" } },
      "xhigh",
    ),
    "high",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "anthropic",
      { reasoning: true, thinkingLevelMap: { max: "max" } },
      "max",
    ),
    "max",
  );
  assert.equal(
    resolveGenerationThinkingLevel(
      "google",
      {
        reasoning: true,
        thinkingLevelMap: { off: null, low: "LOW", medium: null, high: "HIGH" },
      },
      "medium",
    ),
    "off",
  );
});

test("clears transient agent state before bounded helper teardown", async () => {
  const events: string[] = [];
  let transientScreenshot: string | null = "sensitive-image";
  const never = new Promise<void>(() => {});
  const completed = await settleGenerationCleanup(
    [
      {
        reset: () => {
          events.push("reset");
          transientScreenshot = null;
        },
        close: () => {
          events.push("close");
          return never;
        },
        completion: never,
      },
    ],
    20,
  );

  assert.equal(completed, false);
  assert.equal(transientScreenshot, null);
  assert.deepEqual(events, ["reset", "close"]);
});

test("a non-settling parent initialization cannot be mistaken for a cleared generation", async () => {
  const never = new Promise<void>(() => {});
  const cleared = await waitForGenerationStateClear(
    () => true,
    () => [never],
    Date.now() + 20,
  );
  assert.equal(cleared, false);
});

test("forwards the chat identity through Pi Agent options into the native stream", () => {
  let receivedSessionId: string | undefined;
  let receivedApiKey: string | undefined;
  let receivedAuthorization: string | null | undefined;
  const nativeStream = ((_model, _context, options) => {
    receivedSessionId = options?.sessionId;
    receivedApiKey = options?.apiKey;
    receivedAuthorization = options?.headers?.Authorization;
    throw new Error("captured");
  }) as ProviderStreams["streamSimple"];
  const agentOptions = buildAgentRuntimeOptions("chat-session-123", {
    apiKey: "runtime-key",
    headers: { Authorization: null },
    streams: { streamSimple: nativeStream },
  });
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };

  assert.equal(agentOptions.sessionId, "chat-session-123");
  assert.throws(
    () =>
      agentOptions.streamFn?.(
        model,
        { messages: [] },
        { sessionId: agentOptions.sessionId },
      ),
    /captured/u,
  );
  assert.equal(receivedSessionId, "chat-session-123");
  assert.equal(receivedApiKey, "runtime-key");
  assert.equal(receivedAuthorization, null);
});

test("uses an in-memory non-secret credential for an explicitly keyless provider", () => {
  assert.equal(
    resolveRuntimeApiKey({ needsKey: false }, null),
    PI_AUTH_COMPATIBILITY_TOKEN,
  );
  assert.equal(
    resolveRuntimeApiKey({ needsKey: false }, "old saved key"),
    PI_AUTH_COMPATIBILITY_TOKEN,
  );
  assert.deepEqual(resolveRuntimeHeaders({ kind: "openai", needsKey: false }), {
    Authorization: null,
  });
  assert.deepEqual(
    resolveRuntimeHeaders({ kind: "anthropic", needsKey: false }),
    {
      Authorization: null,
      "x-api-key": null,
    },
  );
  assert.equal(
    resolveRuntimeHeaders({ kind: "openai", needsKey: true }),
    undefined,
  );
});

test("keeps keyless auth off the wire and normalizes local reasoning", async (t) => {
  let authorization: string | string[] | undefined;
  let apiKey: string | string[] | undefined;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    apiKey = request.headers["x-api-key"];
    assert.equal(request.url, "/v1/chat/completions");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [
          {
            index: 0,
            delta: { reasoning: "Compare locally." },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not expose a TCP port.");
  const model: Model<"openai-completions"> = {
    id: "local",
    name: "Local",
    api: "openai-completions",
    provider: "local",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };

  const result = await openAICompletionsApi()
    .streamSimple(
      model,
      {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      {
        apiKey: PI_AUTH_COMPATIBILITY_TOKEN,
        headers: resolveRuntimeHeaders({ kind: "openai", needsKey: false }),
      },
    )
    .result();

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [
    {
      type: "thinking",
      thinking: "Compare locally.",
      thinkingSignature: "reasoning",
    },
    { type: "text", text: "ok" },
  ]);
  assert.equal(authorization, undefined);
  assert.equal(apiKey, undefined);
});

test("uses Anthropic's single version path without sending keyless auth headers", async (t) => {
  let authorization: string | string[] | undefined;
  let apiKey: string | string[] | undefined;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    apiKey = request.headers["x-api-key"];
    assert.equal(request.url, "/v1/messages");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: { id: "msg_test", usage: { input_tokens: 1 } },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]
        .map(
          ({ event, data }) =>
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port.");
  }
  const model: Model<"anthropic-messages"> = {
    id: "local",
    name: "Local",
    api: "anthropic-messages",
    provider: "local",
    baseUrl: resolveRuntimeBaseUrl({
      kind: "anthropic",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    }),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };

  const result = await anthropicMessagesApi()
    .streamSimple(
      model,
      {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      {
        apiKey: PI_AUTH_COMPATIBILITY_TOKEN,
        headers: resolveRuntimeHeaders({ kind: "anthropic", needsKey: false }),
      },
    )
    .result();

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.equal(authorization, undefined);
  assert.equal(apiKey, undefined);
});

test("sends adaptive Claude thinking with the selected native effort", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: { id: "msg_effort", usage: { input_tokens: 1 } },
            },
          },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]
          .map(
            ({ event, data }) =>
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join(""),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port.");
  }
  const model: Model<"anthropic-messages"> = {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}`,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
    compat: { forceAdaptiveThinking: true },
  };

  await anthropicMessagesApi()
    .streamSimple(
      model,
      {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { apiKey: "test-key", reasoning: "xhigh" },
    )
    .result();

  const payload = JSON.parse(requestBody) as Record<string, unknown>;
  assert.deepEqual(payload.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(payload.output_config, { effort: "xhigh" });
});

test("preserves normal API-key requirements for authenticated providers", () => {
  assert.equal(
    resolveRuntimeApiKey({ needsKey: true }, "  live-key  "),
    "live-key",
  );
  assert.equal(resolveRuntimeApiKey({ needsKey: true }, "   "), undefined);
  assert.equal(resolveRuntimeApiKey({ needsKey: true }, null), undefined);
});

test("classifies terminal Pi errors without turning an aborted turn into an error", () => {
  assert.equal(
    terminalGenerationError({
      role: "assistant",
      stopReason: "error",
      errorMessage: "No API key for provider: lmstudio",
    }),
    "No API key for provider: lmstudio",
  );
  assert.equal(
    terminalGenerationError({
      role: "assistant",
      stopReason: "error",
      errorMessage: "   ",
    }),
    "The model couldn't complete this response.",
  );
  assert.equal(
    terminalGenerationError({ role: "assistant", stopReason: "aborted" }),
    null,
  );
  assert.equal(
    terminalGenerationWasAborted({ role: "assistant", stopReason: "aborted" }),
    true,
  );
  assert.equal(
    terminalGenerationWasAborted({ role: "toolResult", stopReason: "aborted" }),
    false,
  );
});

test("surfaces output-limit stops as saved partial responses", () => {
  assert.match(
    terminalGenerationLengthError({
      role: "assistant",
      stopReason: "length",
    }) ?? "",
    /output limit.*partial response was saved/iu,
  );
  assert.equal(
    terminalGenerationLengthError({ role: "assistant", stopReason: "stop" }),
    null,
  );
});

test("surfaces a dependency abort unless the app explicitly requested cancellation", () => {
  assert.equal(
    terminalGenerationInterruptionError(true, false),
    "The response was interrupted before it finished. Try again.",
  );
  assert.equal(terminalGenerationInterruptionError(true, true), null);
  assert.equal(terminalGenerationInterruptionError(false, false), null);
});

test("retry backoff is immediately cancellable", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForAbortableDelay(5_000, controller.signal);
  controller.abort(new Error("stop now"));
  await assert.rejects(waiting, /stop now/u);
  assert.ok(Date.now() - started < 500);
});

test("uses final assistant text when a provider does not stream text deltas", () => {
  assert.equal(
    terminalAssistantText({
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden reasoning" },
        { type: "text", text: "Final answer" },
        { type: "text", text: " from the provider" },
      ],
    }),
    "Final answer from the provider",
  );
  assert.equal(
    terminalAssistantText({
      role: "toolResult",
      content: [{ type: "text", text: "Nope" }],
    }),
    "",
  );
});

test("matches Pi reasoning display for hosted providers and the local visibility preference", () => {
  for (const id of [
    "anthropic",
    "openai",
    "openai-codex",
    "azure-openai-responses",
    "deepseek",
    "google",
    "google-vertex",
    "amazon-bedrock",
    "mistral",
    "openrouter",
  ]) {
    assert.equal(
      shouldExposeReasoning({ id, deployment: "hosted" }, false),
      true,
      `${id} should expose normalized Pi thinking`,
    );
  }
  assert.equal(shouldExposeReasoning({ id: "lmstudio", deployment: "local" }, undefined), true);
  assert.equal(shouldExposeReasoning({ id: "ollama", deployment: "local" }, true), true);
  assert.equal(shouldExposeReasoning({ id: "custom:lmstudio", deployment: "local" }, false), false);
  assert.equal(
    shouldExposeReasoning({ id: "custom", baseUrl: "http://127.0.0.1:1234/v1" }, false),
    false,
  );
  assert.equal(
    shouldExposeReasoning({ id: "custom", baseUrl: "https://models.example.test/v1" }, false),
    true,
  );

  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Inspect the request." },
      { type: "thinking", thinking: "Do not expose this.", redacted: true },
      { type: "thinking", thinking: "Draft the answer." },
      { type: "text", text: "Final answer." },
    ],
  };
  assert.equal(
    terminalAssistantReasoning(message),
    "Inspect the request.\n\nDraft the answer.",
  );
  assert.equal(
    terminalAssistantReasoningFallback(message, false),
    terminalAssistantReasoning(message),
  );
  assert.equal(terminalAssistantReasoningFallback(message, true), "");
  assert.equal(
    terminalAssistantReasoning({ role: "user", content: message.content }),
    "",
  );
});

test("falls back per assistant turn instead of dropping a later terminal-only result", () => {
  let full = "I'll check the workspace.\n";
  full += terminalAssistantTextFallback(
    {
      role: "assistant",
      content: [{ type: "text", text: "Found the issue." }],
    },
    false,
  );
  assert.equal(full, "I'll check the workspace.\nFound the issue.");
  assert.equal(
    terminalAssistantTextFallback(
      {
        role: "assistant",
        content: [{ type: "text", text: "Already streamed." }],
      },
      true,
    ),
    "",
  );
});

test("separates distinct assistant turns with one Markdown paragraph boundary", () => {
  assert.equal(
    assistantTurnTextSeparator("First turn.", "Second turn."),
    "\n\n",
  );
  assert.equal(
    assistantTurnTextSeparator("First turn.\n", "Second turn."),
    "\n",
  );
  assert.equal(
    assistantTurnTextSeparator("First turn.\n\n", "Second turn."),
    "",
  );
  assert.equal(
    assistantTurnTextSeparator("First turn.", "\nSecond turn."),
    "\n",
  );
  assert.equal(assistantTurnTextSeparator("", "Second turn."), "");
});

test("terminal reconciliation preserves paragraph boundaries across tool-separated turns", () => {
  const projection = reconcileTerminalAssistantProjection(
    { full: "Before the tool.", reasoning: "" },
    { full: "Before the tool.".length, reasoning: 0 },
    {
      role: "assistant",
      content: [{ type: "text", text: "After the tool." }],
    },
    false,
  );
  assert.equal(
    projection.full,
    "Before the tool.\n\nAfter the tool.",
  );
});

test("reconciles interleaved streamed blocks to Pi terminal content order", () => {
  const projection = reconcileTerminalAssistantProjection(
    {
      full: "Earlier turn.Streamed second block then first.",
      reasoning: "Earlier reasoning.Streamed late then early.",
    },
    { full: "Earlier turn.".length, reasoning: "Earlier reasoning.".length },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Early thought." },
        { type: "text", text: "First block. " },
        { type: "thinking", thinking: "Late thought." },
        { type: "text", text: "Second block." },
      ],
    },
    true,
  );
  assert.equal(
    projection.full,
    "Earlier turn.\n\nFirst block. Second block.",
  );
  assert.equal(
    projection.reasoning,
    "Earlier reasoning.\n\nEarly thought.\n\nLate thought.",
  );
  assert.equal(projection.changed, true);
});

test("terminal reconciliation exposes only readable Pi thinking and honors local hiding", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Readable first thought." },
      { type: "thinking", thinking: "Opaque provider payload.", redacted: true },
      { type: "text", text: "Final answer." },
      { type: "thinking", thinking: "Readable second thought." },
    ],
  };

  const visible = reconcileTerminalAssistantProjection(
    { full: "streamed", reasoning: "partial private text" },
    { full: 0, reasoning: 0 },
    message,
    true,
  );
  assert.equal(visible.full, "Final answer.");
  assert.equal(
    visible.reasoning,
    "Readable first thought.\n\nReadable second thought.",
  );
  assert.equal(visible.reasoning.includes("Opaque provider payload."), false);

  const hidden = reconcileTerminalAssistantProjection(
    { full: "Earlier answer.streamed", reasoning: "Earlier reasoning.partial private text" },
    { full: "Earlier answer.".length, reasoning: "Earlier reasoning.".length },
    message,
    false,
  );
  assert.equal(hidden.full, "Earlier answer.\n\nFinal answer.");
  assert.equal(hidden.reasoning, "Earlier reasoning.");
});
