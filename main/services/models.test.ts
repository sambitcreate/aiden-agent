import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ArtificialAnalysisCatalog } from "./artificial-analysis-catalog-core.js";
import {
  CONSERVATIVE_RUNTIME_LIMITS,
  createModelCatalogLoader,
  lookupCatalogModelInfo,
  parseModelCatalog,
  resolveModelInfo,
  resolveProviderRuntimeLimits,
  resolveRuntimeLimits,
} from "./models-catalog-core.js";
import {
  discoverOllamaModels,
  MAX_DISCOVERED_MODELS,
  MAX_MODEL_DISCOVERY_RESPONSE_BYTES,
  normalizeProviderBaseUrl,
  assertOnboardingTailnetBaseUrl,
  testConnection,
} from "./models.js";
import { canonicalGoogleProvider } from "./google-provider.js";

const lmStudioProvider = {
  id: "lmstudio",
  kind: "openai" as const,
  label: "LM Studio (local)",
  baseUrl: "http://127.0.0.1:1234/v1",
  models: [],
  needsKey: false,
  isPreset: true,
};

test("Google discovery validates the native endpoint and returns only Pi-supported models", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.deepEqual(init?.headers, { "x-goog-api-key": "google-key" });
    assert.equal(init?.redirect, "error");
    if (url.endsWith("pageSize=1000")) {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-embedding-001",
              supportedGenerationMethods: ["embedContent"],
            },
            {
              name: "models/unpinned-future-model",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
          nextPageToken: "second page",
        }),
        { status: 200 },
      );
    }
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=second+page",
    );
    return new Response(
      JSON.stringify({
        models: [
          {
            name: "models/gemini-2.5-pro",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await testConnection(canonicalGoogleProvider(), "google-key");
  assert.deepEqual(result.models, ["gemini-2.5-pro"]);
  assert.equal(result.modelCount, 1);
  assert.equal(result.modelMetadata["gemini-2.5-pro"]?.reasoning, true);
  assert.equal(result.modelMetadata["gemini-2.5-pro"]?.vision, true);
  assert.equal(requests.length, 2);
});

function snapshot(models: ArtificialAnalysisCatalog["models"]): ArtificialAnalysisCatalog {
  return {
    schema_version: 1,
    source: {
      name: "Artificial Analysis",
      url: "https://artificialanalysis.ai/data-api",
      fetched_at: "2026-07-20T12:00:00.000Z",
      intelligence_index_version: 4.1,
    },
    models,
  };
}

test("LM Studio custom connections use native metadata and exclude embeddings", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:1234/api/v1/models");
    assert.deepEqual(init?.headers, {});
    return new Response(
      JSON.stringify({
        models: [
          {
            type: "llm",
            key: "google/gemma-4-e2b",
            display_name: "Gemma 4 E2B",
            quantization: { name: "MLX 4-bit" },
            params_string: "4B-A2B",
            max_context_length: 131_072,
            format: "mlx",
            loaded_instances: [{ id: "gemma-loaded" }],
            capabilities: {
              vision: true,
              trained_for_tool_use: true,
              reasoning: { allowed_options: ["on"], default: "on" },
            },
          },
          {
            type: "embedding",
            key: "nomic-embed",
            display_name: "Nomic Embed",
            max_context_length: 2_048,
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await testConnection({ ...lmStudioProvider, id: "custom:lmstudio" }, null);
  assert.deepEqual(result.models, ["google/gemma-4-e2b"]);
  assert.equal(result.modelCount, 1);
  assert.equal(result.recommendedModel, "google/gemma-4-e2b");
  assert.deepEqual(result.modelMetadata["google/gemma-4-e2b"], {
    source: "lmstudio",
    name: "Gemma 4 E2B",
    type: "llm",
    vision: true,
    toolCall: true,
    reasoning: true,
    contextLength: 131_072,
    parameterCount: "4B-A2B",
    format: "MLX 4-bit",
  });
  assert.equal(result.modelMetadata["nomic-embed"]?.type, "embedding");
});

test("LM Studio falls back to the OpenAI-compatible list only when its native route is absent", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    if (String(input).endsWith("/api/v1/models")) return new Response("", { status: 404 });
    return new Response(
      JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await testConnection(lmStudioProvider, null);
  assert.deepEqual(requests, [
    "http://127.0.0.1:1234/api/v1/models",
    "http://127.0.0.1:1234/v1/models",
  ]);
  assert.deepEqual(result.models, ["a-model", "z-model"]);
  assert.equal(result.modelMetadata["a-model"]?.source, "provider");
});

test("generic discovery preserves and excludes provider-declared non-chat model types", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), "https://models.example.test/v1/models");
    return new Response(
      JSON.stringify({
        data: [
          { id: "chat-v1", type: "llm" },
          { id: "opaque-score-v1", type: "reranker" },
          { id: "opaque-capability-score", capabilities: ["reranking"] },
          { id: "opaque-pixels-v1", type: "image" },
          { id: "opaque-sound-v1", type: "audio" },
          { id: "opaque-motion-v1", type: "video" },
          {
            id: "conflicting-pixels-array",
            type: "text-generation",
            capabilities: ["image_generation"],
          },
          {
            id: "conflicting-motion-object",
            type: "llm",
            capabilities: { video_generation: true },
          },
          {
            id: "conflicting-sound-object",
            type: "chat",
            capabilities: { audio_generation: true },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await testConnection(
    {
      id: "custom:openai",
      kind: "openai",
      label: "Custom",
      baseUrl: "https://models.example.test/v1",
      models: [],
      needsKey: false,
    },
    null,
  );
  assert.deepEqual(result.models, ["chat-v1"]);
  assert.equal(result.modelCount, 1);
  assert.equal(result.modelMetadata["opaque-score-v1"]?.type, "reranker");
  assert.equal(result.modelMetadata["opaque-capability-score"]?.type, "reranker");
  assert.equal(result.modelMetadata["opaque-pixels-v1"]?.type, "image");
  assert.equal(result.modelMetadata["opaque-sound-v1"]?.type, "audio");
  assert.equal(result.modelMetadata["opaque-motion-v1"]?.type, "video");
  assert.equal(result.modelMetadata["conflicting-pixels-array"]?.type, "image");
  assert.equal(result.modelMetadata["conflicting-motion-object"]?.type, "video");
  assert.equal(result.modelMetadata["conflicting-sound-object"]?.type, "audio");
});

test("Ollama custom connections enrich chat models with show metadata and filter embeddings", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [
            {
              model: "llava:latest",
              details: { format: "gguf", parameter_size: "7B", quantization_level: "Q4_K_M" },
            },
            { model: "nomic-embed:latest", details: { parameter_size: "137M" } },
          ],
        }),
        { status: 200 },
      );
    }
    assert.equal(url, "http://127.0.0.1:11434/api/show");
    const body = JSON.parse(String(init?.body)) as { model: string };
    return body.model === "llava:latest"
      ? new Response(
          JSON.stringify({
            capabilities: ["completion", "vision", "tools", "thinking"],
            model_info: { "llama.context_length": 32_768 },
          }),
          { status: 200 },
        )
      : new Response(JSON.stringify({ capabilities: ["embedding"] }), { status: 200 });
  }) as typeof fetch;

  const result = await testConnection(
    {
      ...lmStudioProvider,
      id: "custom:ollama",
      label: "Ollama (local)",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    null,
  );
  assert.deepEqual(result.models, ["llava:latest"]);
  assert.deepEqual(result.modelMetadata["llava:latest"], {
    source: "ollama",
    name: "llava:latest",
    type: "llm",
    vision: true,
    toolCall: true,
    reasoning: true,
    contextLength: 32_768,
    parameterCount: "7B",
    format: "Q4_K_M",
  });
  assert.equal(result.modelMetadata["nomic-embed:latest"]?.type, "embedding");
});

test("Ollama detail enrichment shares one deadline and keeps safe partial tag metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const signals = new Set<AbortSignal | null | undefined>();
  const tags = Array.from({ length: 20 }, (_, index) => ({
    model: `model-${index}`,
    details: { parameter_size: `${index + 1}B`, quantization_level: "Q4_K_M" },
  }));
  globalThis.fetch = (async (input, init) => {
    signals.add(init?.signal);
    if (String(input).endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: tags }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === "model-0") {
      return new Response(
        JSON.stringify({
          capabilities: ["completion", "vision"],
          model_info: { "llama.context_length": 16_384 },
        }),
        { status: 200 },
      );
    }
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  const startedAt = Date.now();
  const result = await discoverOllamaModels(
    {
      ...lmStudioProvider,
      id: "custom:ollama",
      label: "Ollama (local)",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    {},
    80,
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result);
  assert.ok(
    elapsedMs < 300,
    `one 80ms deadline should not multiply by model count (${elapsedMs}ms)`,
  );
  assert.equal(signals.size, 1, "tags and every detail request share one AbortSignal");
  assert.deepEqual(result.models, ["model-0"]);
  assert.deepEqual(result.modelMetadata["model-0"], {
    source: "ollama",
    name: "model-0",
    type: "llm",
    vision: true,
    toolCall: false,
    reasoning: false,
    contextLength: 16_384,
    parameterCount: "1B",
    format: "Q4_K_M",
  });
  assert.deepEqual(result.modelMetadata["model-19"], {
    source: "ollama",
    name: "model-19",
    type: undefined,
    vision: undefined,
    toolCall: undefined,
    reasoning: undefined,
    contextLength: undefined,
    parameterCount: "20B",
    format: "Q4_K_M",
  });
});

test("Ollama does not expose an embedding model as chat-capable when show times out", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [
            {
              model: "nomic-embed-text:latest",
              details: { parameter_size: "137M", quantization_level: "F16" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    const signal = init?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  const startedAt = Date.now();
  const result = await discoverOllamaModels(
    {
      ...lmStudioProvider,
      id: "custom:ollama",
      label: "Ollama (local)",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    {},
    80,
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(result);
  assert.ok(elapsedMs < 300, `one 80ms deadline should bound the detail request (${elapsedMs}ms)`);
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.modelMetadata["nomic-embed-text:latest"], {
    source: "ollama",
    name: "nomic-embed-text:latest",
    type: undefined,
    vision: undefined,
    toolCall: undefined,
    reasoning: undefined,
    contextLength: undefined,
    parameterCount: "137M",
    format: "F16",
  });
});

test("keyless Anthropic discovery omits x-api-key while retaining its protocol version", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input, init) => {
    assert.deepEqual(init?.headers, { "anthropic-version": "2023-06-01" });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  assert.deepEqual(
    await testConnection(
      {
        ...lmStudioProvider,
        id: "anthropic-local",
        kind: "anthropic",
        label: "Anthropic-compatible local server",
      },
      null,
    ),
    { ok: true, modelCount: 0, models: [], modelMetadata: {} },
  );
});

test("hosted onboarding discovery sends provider-native credential headers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), headers: init?.headers });
    return new Response(JSON.stringify({ data: [{ id: "supported-model" }] }), {
      status: 200,
    });
  }) as typeof fetch;

  await testConnection(
    {
      ...lmStudioProvider,
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
    },
    "openai-secret",
  );
  await testConnection(
    {
      ...lmStudioProvider,
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    },
    "anthropic-secret",
  );

  assert.deepEqual(requests, [
    {
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: "Bearer openai-secret" },
    },
    {
      url: "https://api.anthropic.com/v1/models",
      headers: {
        "x-api-key": "anthropic-secret",
        "anthropic-version": "2023-06-01",
      },
    },
  ]);
});

test("generic discovery ignores malformed and blank model identifiers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: {} },
          { id: 42 },
          { id: "   " },
          { id: "  valid-model  " },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  const result = await testConnection(
    { ...lmStudioProvider, id: "custom:hosted", baseUrl: "https://provider.example/v1" },
    null,
  );
  assert.deepEqual(result.models, ["valid-model"]);
  assert.equal(result.modelCount, 1);
});

test("credential-bearing discovery rejects redirects and never exposes upstream error bodies", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.redirect, "error");
    return new Response('{"secret":"upstream-account-detail"}', { status: 401 });
  }) as typeof fetch;

  await assert.rejects(
    testConnection(
      {
        ...lmStudioProvider,
        id: "custom:hosted",
        baseUrl: "https://provider.example/v1",
        needsKey: true,
      },
      "candidate-key",
    ),
    (error: unknown) => {
      assert.match(String(error), /rejected those credentials/u);
      assert.doesNotMatch(String(error), /upstream-account-detail|candidate-key/u);
      return true;
    },
  );
});

test("model discovery bounds response bytes, model count, and identifier length", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let oversized = true;
  globalThis.fetch = (async () => {
    if (oversized) {
      return new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_MODEL_DISCOVERY_RESPONSE_BYTES + 1) },
      });
    }
    return new Response(
      JSON.stringify({
        data: [
          ...Array.from({ length: MAX_DISCOVERED_MODELS + 25 }, (_, index) => ({
            id: `model-${index}`,
          })),
          { id: "x".repeat(300) },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  await assert.rejects(testConnection(lmStudioProvider, null), /catalog is too large/u);
  oversized = false;
  const result = await testConnection(lmStudioProvider, null);
  assert.equal(result.models.length, MAX_DISCOVERED_MODELS);
  assert.equal(
    result.models.some((id) => id.length > 256),
    false,
  );
});

test("normalizes safe provider URLs and rejects credentials or request decorations", () => {
  assert.equal(
    normalizeProviderBaseUrl(" https://tailnet.example.ts.net/v1/// "),
    "https://tailnet.example.ts.net/v1",
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://key:secret@example.test/v1"),
    /API key field/u,
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://example.test/v1?key=secret"),
    /query string/u,
  );
  assert.throws(() => normalizeProviderBaseUrl("ftp://example.test/v1"), /HTTP or HTTPS/u);
  for (const target of [
    "http://169.254.169.254/latest",
    "http://169.254.170.2/credentials",
    "http://metadata.google.internal/v1",
    "http://[fe80::1]/v1",
    "http://[::ffff:169.254.169.254]/v1",
  ]) {
    assert.throws(() => normalizeProviderBaseUrl(target), /metadata service/u);
  }
  assert.doesNotThrow(() => assertOnboardingTailnetBaseUrl("https://model.tailnet.ts.net/v1"));
  assert.doesNotThrow(() => assertOnboardingTailnetBaseUrl("http://100.64.20.5:11434/v1"));
  assert.throws(
    () => assertOnboardingTailnetBaseUrl("http://foo.100.100.100.200.nip.io/v1"),
    /Tailscale/u,
  );
});

test("transport failures never echo credential material", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "missing";
    throw new Error(`transport rejected ${authorization}`);
  }) as typeof fetch;
  const canary = "CANARY_PROVIDER_SECRET";
  await assert.rejects(
    testConnection(
      { ...lmStudioProvider, id: "custom:hosted", baseUrl: "https://provider.example/v1" },
      canary,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Couldn't reach the provider model endpoint.");
      assert.doesNotMatch(error.message, new RegExp(canary, "u"));
      return true;
    },
  );
});

test("models.dev lookups retain unknown flags for unmatched model ids", () => {
  assert.throws(() => parseModelCatalog(null), /must be an object/u);
  assert.throws(() => parseModelCatalog([]), /must be an object/u);
  assert.throws(
    () =>
      parseModelCatalog({
        broken: {
          models: {
            unsafe: { name: "Unsafe", modalities: { input: { length: 1 } } },
          },
        },
      }),
    /modalities\.input must be a string array/u,
  );

  const catalog = parseModelCatalog({
    local: {
      models: {
        "vision-model": {
          name: "Vision Model",
          attachment: true,
          tool_call: true,
          reasoning: true,
          open_weights: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 32_000, output: 4_096 },
        },
      },
    },
  });
  assert.deepEqual(lookupCatalogModelInfo(catalog, "lmstudio", "vision-model"), {
    id: "vision-model",
    name: "Vision Model",
    vision: true,
    toolCall: true,
    reasoning: true,
    openWeights: true,
    contextLength: 32_000,
    outputLimit: 4_096,
    inputModalities: ["text", "image"],
    knowledge: undefined,
    releaseDate: undefined,
    metadataSource: "models-dev",
    matched: true,
  });
  assert.deepEqual(lookupCatalogModelInfo({}, "ollama", "qwen-local"), {
    id: "qwen-local",
    metadataSource: "fallback",
    matched: false,
  });
});

test("models.dev preserves authoritative non-chat families and descriptions", () => {
  const catalog = parseModelCatalog({
    local: {
      models: {
        "all-mini-lm-l6-v2": {
          name: "All-MiniLM-L6-v2",
          family: "text-embedding",
        },
        "nvidia--llama-3.2-nv-embedqa-1b": {
          name: "NV EmbedQA",
          description: "Embedding model for semantic search and retrieval",
        },
        "ordinary-chat": {
          name: "Ordinary Chat",
          description: "Chat model that can discuss embedding models",
        },
        "voyage/rerank-2.5-lite": {
          name: "Voyage Rerank 2.5 Lite",
          description: "Reranking model for improving retrieval quality",
        },
        "black-forest-labs/flux.1-dev": {
          name: "FLUX.1 Dev",
          modalities: { input: ["text"], output: ["image"] },
        },
      },
    },
  });
  assert.equal(
    lookupCatalogModelInfo(catalog, "lmstudio", "all-mini-lm-l6-v2").modelType,
    "embedding",
  );
  assert.equal(
    lookupCatalogModelInfo(catalog, "lmstudio", "nvidia--llama-3.2-nv-embedqa-1b").modelType,
    "embedding",
  );
  assert.equal(
    lookupCatalogModelInfo(catalog, "lmstudio", "ordinary-chat").modelType,
    undefined,
  );
  assert.equal(
    lookupCatalogModelInfo(catalog, "lmstudio", "voyage/rerank-2.5-lite").modelType,
    "reranker",
  );
  assert.equal(
    lookupCatalogModelInfo(catalog, "lmstudio", "black-forest-labs/flux.1-dev").modelType,
    "image",
  );
});

test("runtime limits use provider-scoped bundled metadata with conservative partial fallbacks", () => {
  const catalog = parseModelCatalog({
    google: {
      models: {
        "gemini-2.5-pro": {
          name: "Gemini 2.5 Pro",
          attachment: true,
          reasoning: true,
          modalities: { input: ["text", "image", "audio"] },
          limit: { context: 1_048_576, output: 65_536 },
        },
        "gemini-partial": {
          name: "Gemini Partial",
          reasoning: true,
          modalities: { input: ["text"] },
          limit: { context: 256_000 },
        },
      },
    },
  });

  assert.deepEqual(resolveRuntimeLimits(catalog, "gemini", "gemini-2.5-pro"), {
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
  });
  assert.deepEqual(resolveRuntimeLimits(catalog, "gemini", "gemini-partial"), {
    contextWindow: 256_000,
    maxTokens: 8_192,
    reasoning: true,
    input: ["text"],
  });
  assert.deepEqual(
    resolveRuntimeLimits(catalog, "custom-openai", "gemini-2.5-pro"),
    CONSERVATIVE_RUNTIME_LIMITS,
  );
  assert.deepEqual(
    resolveRuntimeLimits(catalog, "gemini", "missing-model"),
    CONSERVATIVE_RUNTIME_LIMITS,
  );
});

test("exact Pi metadata wins field by field over bundled runtime metadata", () => {
  const catalog = parseModelCatalog({
    google: {
      models: {
        "gemini-exact": {
          name: "Gemini Exact",
          attachment: true,
          reasoning: true,
          limit: { context: 1_000_000, output: 64_000 },
        },
      },
    },
  });

  assert.deepEqual(
    resolveRuntimeLimits(catalog, "gemini", "gemini-exact", {
      contextWindow: 2_000_000,
      reasoning: false,
      input: ["text"],
    }),
    {
      contextWindow: 2_000_000,
      maxTokens: 64_000,
      reasoning: false,
      input: ["text"],
    },
  );
});

test("provider-scoped Pi metadata survives proxy routing with discovered overrides", () => {
  const catalog = parseModelCatalog({
    google: {
      models: {
        "gemini-2.5-pro": {
          name: "Gemini 2.5 Pro",
          attachment: true,
          reasoning: true,
          limit: { context: 1_048_576, output: 65_536 },
        },
      },
    },
  });
  const canonical = {
    id: "gemini",
    kind: "openai" as const,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  };
  const edited = {
    ...canonical,
    baseUrl: "https://models.example.test/v1",
    modelMetadata: {
      "gemini-2.5-pro": {
        source: "provider" as const,
        vision: false,
        reasoning: false,
        contextLength: 16_384,
      },
    },
  };
  const piExact = {
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
  };

  assert.deepEqual(
    resolveProviderRuntimeLimits(catalog, canonical, "gemini-2.5-pro", {
      ...piExact,
      input: ["text"],
    }),
    {
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text"],
    },
  );
  assert.deepEqual(resolveProviderRuntimeLimits(catalog, edited, "gemini-2.5-pro", piExact), {
    contextWindow: 16_384,
    maxTokens: 65_536,
    reasoning: false,
    input: ["text"],
  });
  assert.deepEqual(
    resolveProviderRuntimeLimits(
      catalog,
      {
        id: "custom-openai",
        kind: "openai",
        baseUrl: "https://models.example.test/v1",
      },
      "gemini-2.5-pro",
      piExact,
    ),
    CONSERVATIVE_RUNTIME_LIMITS,
  );
});

test("connection-bound discovery enables local vision without trusting a colliding catalog id", () => {
  const catalog = parseModelCatalog({
    google: {
      models: {
        "gemini-2.5-pro": {
          name: "Gemini 2.5 Pro",
          attachment: false,
          reasoning: false,
          limit: { context: 1_048_576, output: 65_536 },
        },
      },
    },
  });
  const local = {
    id: "lmstudio",
    kind: "openai" as const,
    baseUrl: "http://localhost:1234/v1",
    modelMetadata: {
      "gemini-2.5-pro": {
        source: "lmstudio" as const,
        vision: true,
        reasoning: true,
        contextLength: 32_768,
      },
    },
  };

  assert.deepEqual(resolveProviderRuntimeLimits(catalog, local, "gemini-2.5-pro"), {
    contextWindow: 32_768,
    maxTokens: 8_192,
    reasoning: true,
    input: ["text", "image"],
  });
});

test("bundled catalog loader fails closed and shares one concurrent load", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const missing = createModelCatalogLoader(async () => {
    attempts += 1;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }, errors.push.bind(errors));

  const [first, second, third] = await Promise.all([missing(), missing(), missing()]);
  assert.deepEqual(first, {});
  assert.strictEqual(second, first);
  assert.strictEqual(third, first);
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(
    resolveRuntimeLimits(first, "gemini", "gemini-2.5-pro"),
    CONSERVATIVE_RUNTIME_LIMITS,
  );

  const malformed = createModelCatalogLoader(async () => ({
    google: { models: { broken: { name: "", limit: { context: "many" } } } },
  }));
  assert.deepEqual(await malformed(), {});

  const throwingDiagnostic = createModelCatalogLoader(
    async () => {
      throw new Error("unavailable");
    },
    () => {
      throw new Error("diagnostic failed");
    },
  );
  assert.deepEqual(await throwingDiagnostic(), {});
});

test("local discovery metadata takes precedence over catalog metadata", () => {
  const catalog = parseModelCatalog({
    google: {
      models: {
        "gemma-4-e2b": {
          name: "Hosted Gemma",
          attachment: false,
          tool_call: false,
          reasoning: false,
          open_weights: true,
          limit: { context: 32_768, output: 8_192 },
        },
      },
    },
  });
  const artificialAnalysis = snapshot([
    {
      id: "aa-gemma",
      slug: "gemma-4-e2b",
      name: "Artificial Analysis Gemma",
      creator: "Google",
      context_window_tokens: 65_536,
      input_modalities: ["text"],
      ranking: {
        capability_percentile: 0.8,
        response_time_percentile: 0.4,
        pace_metric: "median_end_to_end_response_time_seconds",
      },
    },
  ]);

  const info = resolveModelInfo(
    catalog,
    artificialAnalysis,
    {
      id: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      modelMetadata: {
        "google/gemma-4-e2b": {
          source: "lmstudio",
          name: "Gemma 4 E2B MLX",
          type: "llm",
          vision: true,
          toolCall: true,
          reasoning: true,
          contextLength: 131_072,
          parameterCount: "4B-A2B",
          format: "MLX 4-bit",
        },
      },
    },
    "google/gemma-4-e2b",
  );

  assert.equal(info.metadataSource, "local");
  assert.equal(info.name, "Gemma 4 E2B MLX");
  assert.equal(info.contextLength, 131_072);
  assert.equal(info.vision, true);
  assert.equal(info.toolCall, true);
  assert.equal(info.parameterCount, "4B-A2B");
  assert.equal(info.outputLimit, 8_192);
  assert.equal(info.openWeights, true);
  assert.equal(info.ranking, undefined);
});

test("catalog non-chat types survive a local provider's generic LLM classification", () => {
  const catalog = parseModelCatalog({
    local: {
      models: {
        "opaque-embedding": {
          name: "Opaque Embedding",
          family: "text-embedding",
        },
        "voyage/rerank-2.5-lite": {
          name: "Voyage Rerank 2.5 Lite",
          description: "Reranking model for improving retrieval quality",
        },
      },
    },
  });
  const provider = {
    id: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    modelMetadata: {
      "opaque-embedding": { source: "lmstudio" as const, type: "llm" as const },
      "voyage/rerank-2.5-lite": { source: "lmstudio" as const, type: "llm" as const },
    },
  };

  assert.equal(
    resolveModelInfo(catalog, snapshot([]), provider, "opaque-embedding").modelType,
    "embedding",
  );
  assert.equal(
    resolveModelInfo(catalog, snapshot([]), provider, "voyage/rerank-2.5-lite").modelType,
    "reranker",
  );
});

test("Artificial Analysis takes precedence for hosted models and models.dev fills gaps", () => {
  const catalog = parseModelCatalog({
    openai: {
      models: {
        "openai/gpt-example": {
          name: "GPT Example",
          attachment: false,
          tool_call: true,
          reasoning: false,
          open_weights: false,
          limit: { context: 8_192, output: 4_096 },
        },
      },
    },
  });
  const info = resolveModelInfo(
    catalog,
    snapshot([
      {
        id: "aa-openai-example",
        slug: "gpt-example",
        name: "GPT Example",
        creator: "OpenAI",
        release_date: "2026-06-01",
        reasoning: true,
        context_window_tokens: 131_072,
        input_modalities: ["text", "image"],
        open_weights: false,
        openrouter_api_id: "openai/gpt-example",
        ranking: {
          capability_percentile: 0.9,
          response_time_percentile: 0.2,
          pace_metric: "median_end_to_end_response_time_seconds",
        },
      },
    ]),
    { id: "openai", baseUrl: "https://api.openai.com/v1" },
    "openai/gpt-example",
  );

  assert.equal(info.metadataSource, "artificial-analysis");
  assert.equal(info.contextLength, 131_072);
  assert.equal(info.vision, true);
  assert.equal(info.reasoning, true);
  assert.equal(info.toolCall, true);
  assert.equal(info.outputLimit, 4_096);
  assert.equal(info.ranking?.capabilityPercentile, 0.9);
  assert.equal(info.ranking?.responseTimePercentile, 0.2);
  assert.equal(info.ranking?.sourceUrl, "https://artificialanalysis.ai");
});

test("runtime metadata stays offline and only models.dev data is packaged", async () => {
  const runtimeSource = await readFile(new URL("./models-catalog.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtimeSource, /\bfetch\s*\(/u);

  const modelsDevSnapshot = JSON.parse(
    await readFile(new URL("../../resources/model-capabilities.json", import.meta.url), "utf8"),
  ) as unknown;
  const catalog = parseModelCatalog(modelsDevSnapshot);
  const namedModels = Object.values(catalog).flatMap((provider) =>
    Object.values(provider.models ?? {}).filter((model) => Boolean(model.name?.trim())),
  );
  assert.ok(namedModels.length > 0, "the release snapshot should include model display names");
  assert.deepEqual(resolveRuntimeLimits(catalog, "gemini", "gemini-2.5-pro"), {
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: true,
    input: ["text", "image"],
  });

  await assert.rejects(
    readFile(new URL("../../resources/artificial-analysis-models.json", import.meta.url), "utf8"),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    },
  );

  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { build?: { files?: string[] }; scripts?: Record<string, string> };
  assert.ok(packageJson.build?.files?.includes("resources/model-capabilities.json"));
  assert.equal(
    packageJson.build?.files?.includes("resources/artificial-analysis-models.json"),
    false,
  );
  assert.equal(packageJson.scripts?.["release:update-model-snapshots"], undefined);
  assert.equal(
    packageJson.scripts?.["release:update-model-capabilities"],
    "npm run models:refresh",
  );
  assert.match(packageJson.scripts?.dist ?? "", /run-macos-distribution/u);
  const distributionRunner = await readFile(
    new URL("../../scripts/run-macos-distribution.mjs", import.meta.url),
    "utf8",
  );
  assert.match(distributionRunner, /npm\("release:update-model-capabilities"\)/u);
  assert.doesNotMatch(distributionRunner, /release:update-model-snapshots/u);

  const capabilityUpdater = await readFile(
    new URL("../../scripts/update-model-capabilities.mjs", import.meta.url),
    "utf8",
  );
  assert.match(capabilityUpdater, /https:\/\/models\.dev\/api\.json/u);
  assert.doesNotMatch(
    capabilityUpdater,
    /ARTIFICIAL_ANALYSIS_API_KEY|AA_API_KEY|AA_REDISTRIBUTION_CONFIRMED|x-api-key/u,
  );
});
