import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { createImagesFixture } from "../../../renderer/create-images/fixtures.js";
import type { ResolvedModelRuntime } from "../model-runtime.js";
import { CreateImagesWorkflowProposalService } from "./workflow-proposal-service.js";

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const graph = JSON.stringify({
  version: 1,
  nodes: [
    { id: "prompt", type: "prompt", position: { x: 0, y: 0 }, data: { text: "A blue hour lake" } },
    {
      id: "generate",
      type: "generate-image",
      position: { x: 320, y: 0 },
      data: {
        providerId: "gemini",
        modelId: "gemini-3.1-flash-image",
        aspectRatio: "1:1",
        imageSize: "1K",
        outputMime: "image/png",
        count: 1,
      },
    },
    { id: "output", type: "output", position: { x: 640, y: 0 }, data: {} },
  ],
  edges: [
    { id: "a", source: "prompt", sourcePort: "text", target: "generate", targetPort: "prompt" },
    { id: "b", source: "generate", sourcePort: "images", target: "output", targetPort: "images" },
  ],
});

test("workflow proposal generation uses one tool-free, no-retry selected-chat-model request", async () => {
  const captured: Array<{ context: unknown; options: unknown }> = [];
  const streamSimple = ((_model, context, options) => {
    captured.push({ context, options });
    return { result: async () => response(graph) } as ReturnType<ProviderStreams["streamSimple"]>;
  }) as ProviderStreams["streamSimple"];
  const runtime = {
    provider: {
      id: "test-provider",
      kind: "openai",
      label: "Test provider",
      baseUrl: "http://127.0.0.1",
      models: ["test-model"],
      needsKey: false,
      isPreset: true,
    },
    model: {
      id: "test-model",
      name: "Test model",
      api: "openai-completions",
      provider: "test-provider",
      baseUrl: "http://127.0.0.1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 8_000,
    } as Model<Api>,
    apiKey: undefined,
    headers: undefined,
    streams: { streamSimple },
  } satisfies ResolvedModelRuntime;
  const usage: unknown[] = [];
  const service = new CreateImagesWorkflowProposalService({
    resolveRuntime: async () => runtime,
    recordUsage: async (record) => {
      usage.push(record);
    },
  });
  const result = await service.propose({
    request: "Build a simple lake image workflow",
    current: createImagesFixture("starter")!,
    providerId: "test-provider",
    model: "test-model",
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "ready");
  assert.equal(captured.length, 1);
  assert.equal((captured[0]?.options as { maxRetries?: number }).maxRetries, 0);
  assert.equal("tools" in (captured[0]?.context as object), false);
  assert.equal(JSON.stringify(captured[0]?.context).includes("assetRefs"), false);
  assert.equal(usage.length, 1);
});

test("workflow proposal generation leaves the graph unchanged on hostile model output", async () => {
  const service = new CreateImagesWorkflowProposalService({
    resolveRuntime: async () =>
      ({
        provider: { id: "test", kind: "openai", label: "Test", baseUrl: "http://127.0.0.1", models: ["m"], needsKey: false, isPreset: true },
        model: { id: "m", name: "m", api: "openai-completions", provider: "test", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 8_000 } as Model<Api>,
        apiKey: undefined,
        headers: undefined,
        streams: {
          streamSimple: (() => ({ result: async () => response('{"version":1,"nodes":[],"edges":[],"credential":"secret"}') })) as unknown as ProviderStreams["streamSimple"],
        },
      }) satisfies ResolvedModelRuntime,
    recordUsage: async () => undefined,
  });
  const current = createImagesFixture("starter")!;
  const result = await service.propose({
    request: "Build something",
    current,
    providerId: "test",
    model: "m",
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(current.revision, 1);
});
