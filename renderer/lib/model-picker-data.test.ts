import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatModelProviders,
  createModelEntries,
  decodeSelection,
  encodeSelection,
  findDirectionalModel,
  modelGridSize,
  nearestModel,
  orderModelEntries,
  parseModel,
  positionSavedModels,
  positionModels,
  visibleModelEntries,
  resolveExplicitModelSelection,
  type ModelEntry,
} from "./model-picker-data";
import type { Provider } from "./types";
import {
  firstVisibleModelForProvider,
  isModelHidden,
  normalizeHiddenModelsByProvider,
  remapHiddenModelProvider,
  withModelVisibility,
  withoutProviderVisibility,
} from "../shared/model-visibility";
import { normalizeProviderArtwork } from "../shared/provider-artwork";

test("provider artwork accepts only bounded normalized PNG payloads", () => {
  const artwork = normalizeProviderArtwork({
    mimeType: "image/png",
    dataBase64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });
  assert.equal(artwork?.mimeType, "image/png");
  assert.equal(normalizeProviderArtwork({ mimeType: "image/svg+xml", dataBase64: "PHN2Zz4=" }), undefined);
  assert.equal(normalizeProviderArtwork({ mimeType: "image/png", dataBase64: "not base64" }), undefined);
});

test("new defaults skip hidden preferred models while explicit execution stays separate", () => {
  assert.equal(
    firstVisibleModelForProvider(
      { google: ["gemini-pro"] },
      "google",
      ["gemini-pro", "gemini-flash"],
      ["gemini-pro"],
    ),
    "gemini-flash",
  );
  assert.equal(
    firstVisibleModelForProvider({ google: ["gemini-pro", "gemini-flash"] }, "google", [
      "gemini-pro",
      "gemini-flash",
    ]),
    undefined,
  );
});

test("model visibility normalizes invalid, duplicate, and empty entries", () => {
  assert.deepEqual(
    normalizeHiddenModelsByProvider({
      google: ["gemini-pro", "gemini-pro", " gemini-flash", 3],
      empty: [],
      "": ["model"],
    }),
    { google: ["gemini-pro"] },
  );
  assert.equal(normalizeHiddenModelsByProvider({}), undefined);
});

test("model visibility toggles one model without dropping other preferences", () => {
  let hidden = withModelVisibility(undefined, "google", "gemini-pro", true);
  hidden = withModelVisibility(hidden, "anthropic", "claude-sonnet", true);
  hidden = withModelVisibility(hidden, "google", "gemini-flash", true);
  hidden = withModelVisibility(hidden, "google", "gemini-pro", false);

  assert.equal(isModelHidden(hidden, "google", "gemini-pro"), false);
  assert.equal(isModelHidden(hidden, "google", "gemini-flash"), true);
  assert.equal(isModelHidden(hidden, "anthropic", "claude-sonnet"), true);
});

test("provider removal and identity migration keep visibility scoped correctly", () => {
  const hidden = { old: ["alpha", "beta"], target: ["beta", "gamma"], keep: ["delta"] };
  assert.deepEqual(remapHiddenModelProvider(hidden, "old", "target"), {
    keep: ["delta"],
    target: ["alpha", "beta", "gamma"],
  });
  assert.deepEqual(withoutProviderVisibility(hidden, "old"), {
    keep: ["delta"],
    target: ["beta", "gamma"],
  });
});

test("picker entries omit hidden models without mutating the full catalog", () => {
  const entries = createModelEntries([
    provider({ id: "google", label: "Google", models: ["gemini-pro", "gemini-flash"] }),
  ]);
  const visible = visibleModelEntries(entries, { google: ["gemini-pro"] });

  assert.deepEqual(
    visible.map((entry) => entry.model),
    ["gemini-flash"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    ["gemini-pro", "gemini-flash"],
  );
});

function provider(overrides: Partial<Provider> & Pick<Provider, "id" | "label">): Provider {
  return {
    kind: "openai",
    baseUrl: "https://example.test/v1",
    models: [],
    needsKey: false,
    hasKey: true,
    ...overrides,
  };
}

function entry(value: string, model = value): ModelEntry {
  return {
    value,
    providerId: "test",
    model,
    label: model,
    format: null,
    providerLabel: "Test",
    isLocal: false,
  };
}

test("selection encoding preserves model ids and format parsing isolates quantization", () => {
  const encoded = encodeSelection("local", "org/model::variant");
  assert.deepEqual(decodeSelection(encoded), {
    providerId: "local",
    model: "org/model::variant",
  });
  assert.deepEqual(parseModel("qwen2.5-coder-32b Q4_K_M"), {
    label: "qwen2.5-coder-32b",
    format: "Q4_K_M",
  });
  assert.deepEqual(parseModel("gpt-4.1"), { label: "gpt-4.1", format: null });
});

test("entry creation includes every usable model, keeps hosted providers first, and ignores pins", () => {
  const providers = [
    provider({
      id: "local",
      label: "Local",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: ["local-a", "local-b"],
    }),
    provider({ id: "hosted", label: "Hosted", models: ["cloud-a"] }),
    provider({
      id: "locked",
      label: "Locked",
      models: ["hidden"],
      needsKey: true,
      hasKey: false,
    }),
  ];

  const entries = createModelEntries(providers);
  assert.deepEqual(
    entries.map((model) => model.value),
    ["hosted::cloud-a", "local::local-a", "local::local-b"],
  );
  assert.deepEqual(
    orderModelEntries(entries, ["local::local-b", "stale::model"]).map((model) => model.value),
    ["local::local-b", "hosted::cloud-a", "local::local-a"],
  );
  const coordinates = (models: ModelEntry[]) =>
    positionModels(models)
      .map(({ value, x, y }) => ({ value, x, y }))
      .sort((a, b) => a.value.localeCompare(b.value));
  assert.deepEqual(
    coordinates(entries),
    coordinates(orderModelEntries(entries, ["local::local-b"])),
  );
});

test("licensed benchmark percentiles map directly to capability and response-time axes", () => {
  const [fastCapable, slowCapable] = positionModels([
    {
      ...entry("fast-capable"),
      ranking: {
        capabilityPercentile: 0.9,
        responseTimePercentile: 0.1,
        source: "Licensed benchmark",
      },
    },
    {
      ...entry("slow-capable"),
      ranking: {
        capabilityPercentile: 0.86,
        responseTimePercentile: 0.88,
        source: "Licensed benchmark",
      },
    },
  ]);

  assert.equal(fastCapable.confidence, "benchmark");
  assert.equal(fastCapable.positionSource, "Licensed benchmark");
  assert.ok(fastCapable.x < slowCapable.x);
  assert.ok(fastCapable.y > 0.8);
  assert.equal(fastCapable.capabilityLabel, "Advanced");
  assert.equal(fastCapable.paceLabel, "Faster");
});

test("bundled rankings flow into the pad and stale embedding ids stay out of the picker", () => {
  const local = provider({
    id: "local",
    label: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["chat", "embed"],
    modelMetadata: {
      chat: { source: "lmstudio", type: "llm" },
      embed: { source: "lmstudio", type: "embedding" },
    },
  });
  const hosted = provider({ id: "hosted", label: "Hosted", models: ["ranked"] });
  const ranking = {
    capabilityPercentile: 0.92,
    responseTimePercentile: 0.18,
    source: "Artificial Analysis",
    sourceUrl: "https://artificialanalysis.ai",
  };
  const entries = createModelEntries([local, hosted], {
    "hosted::ranked": {
      id: "ranked",
      ranking,
      metadataSource: "artificial-analysis",
      matched: true,
    },
  });

  assert.deepEqual(
    entries.map((model) => model.value),
    ["hosted::ranked", "local::chat"],
  );
  assert.deepEqual(entries[0].ranking, ranking);
  assert.equal(positionModels(entries)[0].confidence, "benchmark");
});

test("saved personal placements alone determine membership and exact Pad geometry", () => {
  const entries = [entry("first"), entry("second")];
  const positioned = positionSavedModels(entries, {
    first: { x: 0.17, y: 0.83, source: "user" },
  });
  assert.deepEqual(
    positioned.map(({ value, x, y, confidence }) => ({ value, x, y, confidence })),
    [{ value: "first", x: 0.17, y: 0.83, confidence: "personal" }],
  );
});

test("embedding-like ids stay out when stale discovery metadata is unavailable", () => {
  const local = provider({
    id: "local",
    label: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["chat-model", "text-embedding-nomic-embed-text-v1.5"],
  });
  assert.deepEqual(
    createModelEntries([local]).map((model) => model.model),
    ["chat-model"],
  );
});

test("known embedding families stay out without excluding harmless similar chat ids", () => {
  const local = provider({
    id: "local",
    label: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [
      "intfloat/multilingual-e5-large-instruct",
      "baai/bge-m3",
      "thenlper/gte-large",
      "nvidia--llama-3.2-nv-embedqa-1b",
      "nvidia/nv-embedcode-7b-v1",
      "all-mini-lm-l6-v2",
      "multi-qa-mpnet-base-dot-v1",
      "hkunlp/instructor-large",
      "acme/bgeography-e5x-chat",
    ],
  });
  assert.deepEqual(
    createChatModelProviders([local]).flatMap(({ models }) => models),
    ["acme/bgeography-e5x-chat"],
  );
});

test("rerank-only models stay out while authoritative chat classifications override names", () => {
  const local = provider({
    id: "local",
    label: "Local",
    models: [
      "voyage/rerank-2.5-lite",
      "qwen3-reranker-4b",
      "rerank-discussion-chat",
      "opaque-score-v1",
      "ordinary-chat",
    ],
    modelMetadata: {
      "rerank-discussion-chat": { source: "provider", type: "llm" },
      "opaque-score-v1": { source: "provider", type: "reranker" },
    },
  });
  const catalogInfo = {
    local: {
      "qwen3-reranker-4b": {
        id: "qwen3-reranker-4b",
        modelType: "reranker" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "rerank-discussion-chat": {
        id: "rerank-discussion-chat",
        modelType: "llm" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
    },
  };
  assert.deepEqual(
    createChatModelProviders([local], catalogInfo).flatMap(({ models }) => models),
    ["rerank-discussion-chat", "ordinary-chat"],
  );
});

test("offline catalog types close embedding ids that have no reliable name marker", () => {
  const local = provider({
    id: "local",
    label: "Local",
    models: ["all-mini-lm-l6-v2", "multi-qa-mpnet-base-dot-v1", "ordinary-chat"],
  });
  const catalogInfo = {
    local: {
      "all-mini-lm-l6-v2": {
        id: "all-mini-lm-l6-v2",
        modelType: "embedding" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "multi-qa-mpnet-base-dot-v1": {
        id: "multi-qa-mpnet-base-dot-v1",
        modelType: "embedding" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
    },
  };
  assert.deepEqual(
    createChatModelProviders([local], catalogInfo).flatMap(({ models }) => models),
    ["ordinary-chat"],
  );
});

test("authoritative LLM types override heuristics while any non-chat type fails closed", () => {
  const local = provider({
    id: "local",
    label: "Local",
    models: [
      "ordinary-embedding-discussion-chat",
      "acme/gte-chat",
      "conflicting-catalog",
      "conflicting-provider",
      "conflicting-reranker",
      "conflicting-media",
    ],
    modelMetadata: {
      "ordinary-embedding-discussion-chat": { source: "provider", type: "llm" },
      "acme/gte-chat": { source: "provider", type: "llm" },
      "conflicting-catalog": { source: "provider", type: "llm" },
      "conflicting-provider": { source: "provider", type: "embedding" },
      "conflicting-reranker": { source: "provider", type: "llm" },
      "conflicting-media": { source: "provider", type: "llm" },
    },
  });
  const catalogInfo = {
    local: {
      "ordinary-embedding-discussion-chat": {
        id: "ordinary-embedding-discussion-chat",
        modelType: "llm" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "acme/gte-chat": {
        id: "acme/gte-chat",
        modelType: "llm" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "conflicting-catalog": {
        id: "conflicting-catalog",
        modelType: "embedding" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "conflicting-provider": {
        id: "conflicting-provider",
        modelType: "llm" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "conflicting-reranker": {
        id: "conflicting-reranker",
        modelType: "reranker" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
      "conflicting-media": {
        id: "conflicting-media",
        modelType: "image" as const,
        metadataSource: "models-dev" as const,
        matched: true,
      },
    },
  };
  assert.deepEqual(
    createChatModelProviders([local], catalogInfo).flatMap(({ models }) => models),
    ["ordinary-embedding-discussion-chat", "acme/gte-chat"],
  );
});

test("face-generation selection excludes embeddings and never reroutes stale providers", () => {
  const local = provider({
    id: "local",
    label: "Local",
    models: ["chat", "text-embedding-private"],
    defaultModel: "text-embedding-private",
    modelMetadata: {
      chat: { source: "provider", type: "llm" },
      "text-embedding-private": { source: "provider", type: "embedding" },
    },
  });
  const hosted = provider({ id: "hosted", label: "Hosted", models: ["cloud-chat"] });
  const choices = createChatModelProviders([local, hosted]);
  assert.deepEqual(
    choices.map(({ provider: item, models }) => ({ id: item.id, models })),
    [
      { id: "local", models: ["chat"] },
      { id: "hosted", models: ["cloud-chat"] },
    ],
  );
  assert.deepEqual(resolveExplicitModelSelection({ providerId: "", model: "" }, choices), {
    providerId: "local",
    model: "chat",
  });
  assert.deepEqual(
    resolveExplicitModelSelection({ providerId: "removed-local", model: "private-chat" }, choices),
    { providerId: "", model: "" },
  );
  assert.deepEqual(
    resolveExplicitModelSelection(
      { providerId: "local", model: "text-embedding-private" },
      choices,
    ),
    { providerId: "local", model: "" },
  );
});

test("explicit model variants create estimates while unknown models stay visibly unranked", () => {
  const positioned = positionModels([
    entry("flash", "gemini-flash"),
    entry("reasoner", "deepseek-reasoner"),
    entry("unknown-a", "private-model-a"),
    entry("unknown-b", "private-model-b"),
  ]);
  const flash = positioned.find((model) => model.value === "flash")!;
  const reasoner = positioned.find((model) => model.value === "reasoner")!;
  const unknownA = positioned.find((model) => model.value === "unknown-a")!;
  const unknownB = positioned.find((model) => model.value === "unknown-b")!;

  assert.equal(flash.confidence, "estimated");
  assert.equal(reasoner.confidence, "estimated");
  assert.ok(flash.x < reasoner.x);
  assert.ok(flash.y < reasoner.y);
  assert.equal(unknownA.confidence, "unranked");
  assert.match(unknownA.positionSource, /Benchmark unavailable/u);
  assert.notDeepEqual({ x: unknownA.x, y: unknownA.y }, { x: unknownB.x, y: unknownB.y });
});

test("every active model occupies a unique, equally spaced lattice point", () => {
  for (const count of [15, 130]) {
    const positioned = positionModels(
      Array.from({ length: count }, (_, index) =>
        entry(`model-${index}`, `private-model-${index}`),
      ),
    );
    const gridDivisions = modelGridSize(count) - 1;
    const cells = positioned.map(({ x, y }) => `${x.toFixed(8)}:${y.toFixed(8)}`);

    assert.equal(new Set(cells).size, positioned.length);
    for (const model of positioned) {
      assert.equal(Number((model.x * gridDivisions).toFixed(8)) % 1, 0);
      assert.equal(Number((model.y * gridDivisions).toFixed(8)) % 1, 0);
    }
  }
});

test("asynchronous capability metadata enriches details without shifting map geometry", () => {
  const base = entry("stable", "private-model");
  const [before] = positionModels([base]);
  const [after] = positionModels([
    {
      ...base,
      info: {
        id: "private-model",
        vision: true,
        toolCall: true,
        reasoning: true,
        openWeights: false,
        metadataSource: "models-dev",
        matched: true,
      },
    },
  ]);

  assert.deepEqual(
    { x: after.x, y: after.y, confidence: after.confidence },
    { x: before.x, y: before.y, confidence: before.confidence },
  );
});

test("nearest selection has hysteresis and directional navigation favors aligned models", () => {
  const models = positionModels([
    {
      ...entry("left"),
      ranking: {
        capabilityPercentile: 0.5,
        responseTimePercentile: 0.2,
        source: "Fixture",
      },
    },
    {
      ...entry("right"),
      ranking: {
        capabilityPercentile: 0.5,
        responseTimePercentile: 0.8,
        source: "Fixture",
      },
    },
    {
      ...entry("up"),
      ranking: {
        capabilityPercentile: 0.9,
        responseTimePercentile: 0.2,
        source: "Fixture",
      },
    },
  ]);

  assert.equal(nearestModel(models, { x: 0.49, y: 0.5 }, "left")?.value, "left");
  assert.equal(nearestModel(models, { x: 0.72, y: 0.5 }, "left")?.value, "right");
  assert.equal(findDirectionalModel(models, "left", "right")?.value, "right");
  assert.equal(findDirectionalModel(models, "left", "up")?.value, "up");
  assert.equal(findDirectionalModel(models, "left", "left")?.value, "left");
});
