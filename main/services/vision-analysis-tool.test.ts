import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createVisionAnalysisTool, INSPECT_IMAGE_TOOL_NAME } from "./vision-analysis-tool.js";
import { visionAttachmentAlias } from "./vision-attachment-reference.js";

const image = {
  id: "upload/path?private",
  name: "receipt.png",
  mimeType: "image/png",
  kind: "image" as const,
  size: 4,
  data: "IMAGE_BYTES",
};

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

test("image references are opaque, bounded, and resolved only from the current generation", async () => {
  let resolutions = 0;
  let revalidations = 0;
  const response: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "A red receipt is visible." }],
    api: "openai-responses",
    provider: "vision-provider",
    model: "vision-model",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  const tool = createVisionAnalysisTool({
    attachments: [image],
    authority: {
      providerId: "vision-provider",
      modelId: "vision-model",
      revalidateBeforeEffect: async () => { revalidations += 1; },
    },
  }, {
    resolveRuntime: async () => {
      resolutions += 1;
      return {
        provider: { id: "vision-provider", label: "Vision Provider", type: "openai" },
        model: {
          id: "vision-model", name: "Vision Model", api: "openai-responses",
          provider: "vision-provider", baseUrl: "https://example.invalid", reasoning: false,
          input: ["text", "image"], contextWindow: 8_192, maxTokens: 2_048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        apiKey: "private-key",
        streams: { streamSimple: () => ({ result: async () => response }) },
      } as never;
    },
    recordUsage: async () => undefined,
  });

  assert.equal(tool.name, INSPECT_IMAGE_TOOL_NAME);
  const alias = visionAttachmentAlias(image);
  assert.match(alias, /^image_[A-Za-z0-9_-]+$/u);
  assert.doesNotMatch(alias, /[/?]/u);

  const missing = await tool.execute("missing", {
    imageRef: "image_from_another_chat",
    question: "What is shown?",
  });
  assert.match(text(missing), /not an image in this conversation/u);
  assert.equal(resolutions, 0);

  const first = await tool.execute("first", { imageRef: alias, question: " What is shown? " });
  const repeated = await tool.execute("repeat", { imageRef: alias, question: "What is shown?" });
  assert.equal(text(first), "A red receipt is visible.");
  assert.equal(text(repeated), text(first));
  assert.equal(resolutions, 1, "the same inspection should be memoized for this generation");
  assert.equal(revalidations, 2, "authority is checked before resolution and before the provider effect");
});

test("image inspection propagates cancellation instead of turning revocation into model-visible text", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Bot access changed.", "AbortError");
  const tool = createVisionAnalysisTool({
    attachments: [image],
    authority: {
      providerId: "vision-provider",
      modelId: "vision-model",
      revalidateBeforeEffect: async () => undefined,
    },
  }, {
    resolveRuntime: async () => ({
      provider: { id: "vision-provider", label: "Vision Provider", type: "openai" },
      model: {
        id: "vision-model", name: "Vision Model", api: "openai-responses",
        provider: "vision-provider", baseUrl: "https://example.invalid", reasoning: false,
        input: ["text", "image"], contextWindow: 8_192, maxTokens: 2_048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      apiKey: "private-key",
      streams: {
        streamSimple: () => ({
          result: async () => {
            controller.abort(reason);
            throw reason;
          },
        }),
      },
    }) as never,
    recordUsage: async () => undefined,
  });

  await assert.rejects(
    tool.execute("cancelled", {
      imageRef: visionAttachmentAlias(image),
      question: "What is shown?",
    }, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("a successful image inspection survives local usage-store failure", async () => {
  const response: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "The receipt total is $12.00." }],
    api: "openai-responses",
    provider: "vision-provider",
    model: "vision-model",
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  const tool = createVisionAnalysisTool({
    attachments: [image],
    authority: {
      providerId: "vision-provider",
      modelId: "vision-model",
      revalidateBeforeEffect: async () => undefined,
    },
  }, {
    resolveRuntime: async () => ({
      provider: { id: "vision-provider", label: "Vision Provider", type: "openai" },
      model: {
        id: "vision-model", name: "Vision Model", api: "openai-responses",
        provider: "vision-provider", baseUrl: "https://example.invalid", reasoning: false,
        input: ["text", "image"], contextWindow: 8_192, maxTokens: 2_048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      apiKey: "private-key",
      streams: { streamSimple: () => ({ result: async () => response }) },
    }) as never,
    recordUsage: async () => {
      throw new Error("usage store unavailable");
    },
  });

  const inspected = await tool.execute("usage-failure", {
    imageRef: visionAttachmentAlias(image),
    question: "What is the total?",
  });

  assert.equal(text(inspected), "The receipt total is $12.00.");
});
