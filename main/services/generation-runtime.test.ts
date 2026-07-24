import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model, ProviderStreams } from "@earendil-works/pi-ai";
import {
  PI_AUTH_COMPATIBILITY_TOKEN,
  buildAgentRuntimeOptions,
  resolveRuntimeApiKey,
  resolveRuntimeBaseUrl,
  resolveRuntimeHeaders,
  runtimeSupportsImages,
  settleGenerationCleanup,
  shouldExposeLocalReasoning,
  terminalAssistantReasoning,
  terminalAssistantReasoningFallback,
  terminalAssistantText,
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationInterruptionError,
  terminalGenerationWasAborted,
} from "./generation-runtime.js";

test("uses only the connection-bound runtime model as the image gate", () => {
  assert.equal(runtimeSupportsImages({ input: ["text"] }), false);
  assert.equal(runtimeSupportsImages({ input: ["text", "image"] }), true);
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
    () => agentOptions.streamFn?.(model, { messages: [] }, { sessionId: agentOptions.sessionId }),
    /captured/u,
  );
  assert.equal(receivedSessionId, "chat-session-123");
  assert.equal(receivedApiKey, "runtime-key");
  assert.equal(receivedAuthorization, null);
});

test("uses an in-memory non-secret credential for an explicitly keyless provider", () => {
  assert.equal(resolveRuntimeApiKey({ needsKey: false }, null), PI_AUTH_COMPATIBILITY_TOKEN);
  assert.equal(
    resolveRuntimeApiKey({ needsKey: false }, "old saved key"),
    PI_AUTH_COMPATIBILITY_TOKEN,
  );
  assert.deepEqual(resolveRuntimeHeaders({ kind: "openai", needsKey: false }), {
    Authorization: null,
  });
  assert.deepEqual(resolveRuntimeHeaders({ kind: "anthropic", needsKey: false }), {
    Authorization: null,
    "x-api-key": null,
  });
  assert.equal(resolveRuntimeHeaders({ kind: "openai", needsKey: true }), undefined);
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
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [{ index: 0, delta: { reasoning: "Compare locally." }, finish_reason: null }],
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
    { type: "thinking", thinking: "Compare locally.", thinkingSignature: "reasoning" },
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
          data: { type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1 } } },
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
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
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
        .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
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

test("preserves normal API-key requirements for authenticated providers", () => {
  assert.equal(resolveRuntimeApiKey({ needsKey: true }, "  live-key  "), "live-key");
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
    terminalGenerationError({ role: "assistant", stopReason: "error", errorMessage: "   " }),
    "The model couldn't complete this response.",
  );
  assert.equal(terminalGenerationError({ role: "assistant", stopReason: "aborted" }), null);
  assert.equal(terminalGenerationWasAborted({ role: "assistant", stopReason: "aborted" }), true);
  assert.equal(terminalGenerationWasAborted({ role: "toolResult", stopReason: "aborted" }), false);
});

test("surfaces a dependency abort unless the app explicitly requested cancellation", () => {
  assert.equal(
    terminalGenerationInterruptionError(true, false),
    "The response was interrupted before it finished. Try again.",
  );
  assert.equal(terminalGenerationInterruptionError(true, true), null);
  assert.equal(terminalGenerationInterruptionError(false, false), null);
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
    terminalAssistantText({ role: "toolResult", content: [{ type: "text", text: "Nope" }] }),
    "",
  );
});

test("exposes only explicit local-provider reasoning and ignores redacted blocks", () => {
  assert.equal(shouldExposeLocalReasoning("lmstudio"), true);
  assert.equal(shouldExposeLocalReasoning("ollama"), true);
  assert.equal(shouldExposeLocalReasoning("openai"), false);
  assert.equal(shouldExposeLocalReasoning("custom-local"), false);

  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Inspect the request." },
      { type: "thinking", thinking: "Do not expose this.", redacted: true },
      { type: "thinking", thinking: "Draft the answer." },
      { type: "text", text: "Final answer." },
    ],
  };
  assert.equal(terminalAssistantReasoning(message), "Inspect the request.\n\nDraft the answer.");
  assert.equal(
    terminalAssistantReasoningFallback(message, false),
    terminalAssistantReasoning(message),
  );
  assert.equal(terminalAssistantReasoningFallback(message, true), "");
  assert.equal(terminalAssistantReasoning({ role: "user", content: message.content }), "");
});

test("falls back per assistant turn instead of dropping a later terminal-only result", () => {
  let full = "I'll check the workspace.\n";
  full += terminalAssistantTextFallback(
    { role: "assistant", content: [{ type: "text", text: "Found the issue." }] },
    false,
  );
  assert.equal(full, "I'll check the workspace.\nFound the issue.");
  assert.equal(
    terminalAssistantTextFallback(
      { role: "assistant", content: [{ type: "text", text: "Already streamed." }] },
      true,
    ),
    "",
  );
});
