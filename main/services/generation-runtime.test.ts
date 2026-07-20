import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import {
  PI_AUTH_COMPATIBILITY_TOKEN,
  resolveRuntimeApiKey,
  resolveRuntimeBaseUrl,
  resolveRuntimeHeaders,
  terminalAssistantText,
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationWasAborted,
} from "./generation-runtime.js";

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

test("keeps Pi's keyless compatibility token off the wire", async (t) => {
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
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
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
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
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
