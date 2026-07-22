import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ArtificialAnalysisCatalog } from "./artificial-analysis-catalog-core.js";
import {
  lookupCatalogModelInfo,
  parseModelCatalog,
  resolveModelInfo,
} from "./models-catalog-core.js";
import { normalizeProviderBaseUrl, testConnection } from "./models.js";

const lmStudioProvider = {
  id: "lmstudio",
  kind: "openai" as const,
  label: "LM Studio (local)",
  baseUrl: "http://127.0.0.1:1234/v1",
  models: [],
  needsKey: false,
  isPreset: true,
};

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

test("LM Studio discovery uses its native metadata and excludes embeddings", async (t) => {
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

  const result = await testConnection(lmStudioProvider, null);
  assert.deepEqual(result.models, ["google/gemma-4-e2b"]);
  assert.equal(result.modelCount, 1);
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

test("Ollama discovery enriches chat models with show metadata and filters embeddings", async (t) => {
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
      id: "ollama",
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
