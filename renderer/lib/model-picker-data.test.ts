import assert from "node:assert/strict";
import test from "node:test";
import {
  benchmarkCoverage,
  createChatModelProviders,
  createModelEntries,
  decodeSelection,
  encodeSelection,
  findDirectionalModel,
  MODEL_PAD_CAPTURE_RADIUS,
  modelGridSize,
  nearestModel,
  modelBenchmarkPercentiles,
  modelInfoByValue,
  orderModelEntries,
  parseModel,
  pinnedAndRecentQuickStart,
  positionSavedModels,
  positionModels,
  previewBenchmarkSuggestions,
  recentModelsForList,
  topBenchmarkSuggestions,
  visibleModelEntries,
  resolveExplicitModelSelection,
  alsoViaLabel,
  modelIdentityKey,
  modelSiblings,
  type ModelEntry,
} from "./model-picker-data";
import {
  modelPadGridSizeForPlacements,
  reflowVisibleModelPadPlacements,
  type ModelPadPlacement,
} from "./model-pad-layout";
import type { Provider } from "./types";
import {
  firstVisibleModelForProvider,
  hideAllProviderModels,
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
  assert.equal(
    normalizeProviderArtwork({ mimeType: "image/svg+xml", dataBase64: "PHN2Zz4=" }),
    undefined,
  );
  assert.equal(
    normalizeProviderArtwork({ mimeType: "image/png", dataBase64: "not base64" }),
    undefined,
  );
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
    { google: { defaultVisibility: "shown", exceptions: ["gemini-pro"] } },
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

test("hide all covers future models while explicit shown exceptions remain reversible", () => {
  let hidden = hideAllProviderModels(undefined, "google");
  assert.equal(isModelHidden(hidden, "google", "future-model"), true);
  hidden = withModelVisibility(hidden, "google", "gemini-pro", false);
  assert.equal(isModelHidden(hidden, "google", "gemini-pro"), false);
  assert.equal(isModelHidden(hidden, "google", "future-model"), true);
  hidden = withModelVisibility(hidden, "google", "gemini-pro", true);
  assert.deepEqual(hidden, {
    google: { defaultVisibility: "hidden", exceptions: [] },
  });
});

test("provider removal and identity migration keep visibility scoped correctly", () => {
  const hidden = { old: ["alpha", "beta"], target: ["beta", "gamma"], keep: ["delta"] };
  assert.deepEqual(remapHiddenModelProvider(hidden, "old", "target"), {
    keep: { defaultVisibility: "shown", exceptions: ["delta"] },
    target: { defaultVisibility: "shown", exceptions: ["alpha", "beta", "gamma"] },
  });
  assert.deepEqual(withoutProviderVisibility(hidden, "old"), {
    keep: { defaultVisibility: "shown", exceptions: ["delta"] },
    target: { defaultVisibility: "shown", exceptions: ["beta", "gamma"] },
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

test("picker entries carry custom provider artwork into the model list and pad", () => {
  const artwork = normalizeProviderArtwork({
    mimeType: "image/png",
    dataBase64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });
  const entries = createModelEntries([
    provider({
      id: "custom:connection-abc",
      label: "Home Lab",
      artwork,
      models: ["local-chat"],
    }),
  ]);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.providerArtwork, artwork);
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

test("recent rows are up to three visible models in recency order, skipping the current and pinned models", () => {
  const entries = ["a", "b", "c", "d", "e", "f"].map((value) => entry(`p::${value}`));
  const values = (rows: ModelEntry[]) => rows.map((row) => row.value);

  assert.deepEqual(
    values(
      recentModelsForList(entries, ["p::e", "p::a", "p::gone", "p::b", "p::c", "p::d"], {
        selectedValue: "p::a",
        pinned: ["p::b"],
      }),
    ),
    // The current model, a pinned model and a model no longer visible are skipped,
    // and the slots they leave are filled by older visible history.
    ["p::e", "p::c", "p::d"],
  );
  assert.deepEqual(values(recentModelsForList(entries, [], { selectedValue: "", pinned: [] })), []);
  assert.deepEqual(
    values(recentModelsForList(entries, ["p::a"], { selectedValue: "p::a", pinned: [] })),
    [],
  );
});

test("the pinned & recent quick start takes visible, unplaced pinned models then recent ones, up to the limit", () => {
  const entries = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].map((value) =>
    entry(`p::${value}`),
  );
  const values = (rows: ModelEntry[]) => rows.map((row) => row.value);
  const placed: Record<string, ModelPadPlacement> = {
    "p::b": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
  };

  assert.deepEqual(
    values(
      pinnedAndRecentQuickStart(entries, {
        // Stored order is kept; a placed pin and a pin that is no longer visible are skipped.
        pinned: ["p::c", "p::b", "p::hidden", "p::a"],
        // A recent model that is also pinned appears once, in the pinned slot.
        recent: ["p::e", "p::a", "p::d"],
        placements: placed,
      }),
    ),
    ["p::c", "p::a", "p::e", "p::d"],
  );

  // Stops at eight models by default.
  assert.deepEqual(
    values(
      pinnedAndRecentQuickStart(entries, {
        pinned: ["p::a", "p::b", "p::c", "p::d", "p::e", "p::f"],
        recent: ["p::g", "p::h", "p::i", "p::j", "p::k"],
        placements: {},
      }),
    ),
    ["p::a", "p::b", "p::c", "p::d", "p::e", "p::f", "p::g", "p::h"],
  );
  assert.deepEqual(
    values(
      pinnedAndRecentQuickStart(entries, {
        pinned: ["p::b"],
        recent: ["p::b", "p::gone"],
        placements: placed,
      }),
    ),
    [],
  );
});

test("benchmark quick-start candidates are the most capable unplaced models first, at most eight", () => {
  const entries = Array.from({ length: 12 }, (_, index) => entry(`p::m${index}`));
  // m0 is least capable, m11 most; m3 has no score for the metric.
  const percentiles = new Map(
    entries.flatMap((model, index) => (index === 3 ? [] : [[model.value, index / 11] as const])),
  );
  const placements: Record<string, ModelPadPlacement> = {
    "p::m11": { x: 0.5, y: 1, xSource: "user", ySource: "user" },
  };

  const top = topBenchmarkSuggestions(entries, percentiles, { placements });
  assert.deepEqual(
    top.map((suggestion) => suggestion.value),
    ["p::m10", "p::m9", "p::m8", "p::m7", "p::m6", "p::m5", "p::m4", "p::m2"],
  );
  assert.equal(top[0].capabilityPercentile, 10 / 11);

  assert.deepEqual(
    topBenchmarkSuggestions(entries, percentiles, { placements, limit: 2 }).map(
      (suggestion) => suggestion.value,
    ),
    ["p::m10", "p::m9"],
  );
  // Scores for models that are not visible never become candidates.
  assert.deepEqual(
    topBenchmarkSuggestions([], percentiles, { placements: {} }),
    [],
  );
});

test("previewed suggestions put scored pinned then recent models first, then the most capable, at most eight", () => {
  const entries = Array.from({ length: 14 }, (_, index) => entry(`p::m${index}`));
  // m0 is least capable, m13 most; m3 has no score for the metric.
  const percentiles = new Map(
    entries.flatMap((model, index) => (index === 3 ? [] : [[model.value, index / 13] as const])),
  );
  const placements: Record<string, ModelPadPlacement> = {
    "p::m13": { x: 0.5, y: 1, xSource: "user", ySource: "user" },
  };
  const values = (rows: { value: string }[]) => rows.map((row) => row.value);

  const preview = previewBenchmarkSuggestions(entries, percentiles, {
    placements,
    // m3 is unscored, m13 is already placed and m99 is not visible: none is previewed.
    pinned: ["p::m1", "p::m3", "p::m13", "p::m99"],
    // m1 is pinned too and appears once, in its pinned slot.
    recent: ["p::m0", "p::m1"],
  });
  assert.deepEqual(values(preview), [
    "p::m1",
    "p::m0",
    "p::m12",
    "p::m11",
    "p::m10",
    "p::m9",
    "p::m8",
    "p::m7",
  ]);
  // Each suggestion carries its percentile, which sets its height.
  assert.equal(preview[1].capabilityPercentile, 0);
  assert.equal(preview[2].capabilityPercentile, 12 / 13);

  assert.deepEqual(
    values(
      previewBenchmarkSuggestions(entries, percentiles, {
        placements,
        pinned: [],
        recent: ["p::m2"],
        limit: 3,
      }),
    ),
    ["p::m2", "p::m12", "p::m11"],
  );
  assert.deepEqual(
    previewBenchmarkSuggestions(entries, new Map(), { placements: {}, pinned: ["p::m1"], recent: [] }),
    [],
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

test("saved personal placements alone determine membership and snap to Pad geometry", () => {
  const entries = [entry("first"), entry("second")];
  const positioned = positionSavedModels(entries, {
    first: { x: 0.17, y: 0.83, xSource: "user", ySource: "user" },
  });
  assert.deepEqual(
    positioned.map(({ value, x, y, confidence }) => ({ value, x, y, confidence })),
    [
      {
        value: "first",
        x: 1 / 6,
        y: 5 / 6,
        confidence: "personal",
      },
    ],
  );
});

test("saved geometry is sized by placed, visible models while hidden placements reserve no dot", () => {
  const entries = Array.from({ length: 40 }, (_, index) => entry(`model-${index}`));
  const positioned = positionSavedModels(entries, {
    "model-0": { x: 0.19, y: 0.5, xSource: "user", ySource: "user" },
    hidden: { x: 0.19, y: 0.5, xSource: "user", ySource: "user" },
  });

  // One placed, visible model: the base 7x7 grid, not a 17x17 grid for 40 entries.
  assert.deepEqual(
    positioned.map(({ value, x, y }) => ({ value, x, y })),
    [{ value: "model-0", x: 1 / 6, y: 0.5 }],
  );
});

test("unplaced catalog models never move placed models on the Pad", () => {
  const placements: Record<string, ModelPadPlacement> = {
    "model-0": { x: 0.31, y: 0.72, xSource: "user", ySource: "user" },
    "model-1": { x: 0.9, y: 0.1, xSource: "neutral", ySource: "benchmark" },
    "model-2": { x: 0.31, y: 0.7, xSource: "user", ySource: "benchmark" },
  };
  const geometry = (count: number) =>
    positionSavedModels(
      Array.from({ length: count }, (_, index) => entry(`model-${index}`)),
      placements,
    ).map(({ value, x, y }) => ({ value, x, y }));

  const small = geometry(5);
  assert.equal(small.length, 3);
  assert.deepEqual(geometry(300), small);
  // Hiding unplaced models (dropping them from the visible entries) changes nothing either.
  assert.deepEqual(geometry(3), small);
});

test("the composer Pad and the settings editor reflow agree on placed positions", () => {
  const entries = Array.from({ length: 120 }, (_, index) => entry(`model-${index}`));
  const visibleValues = entries.map(({ value }) => value);
  const placements: Record<string, ModelPadPlacement> = {
    "model-3": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    "model-7": { x: 0.52, y: 0.49, xSource: "neutral", ySource: "benchmark" },
    "model-9": { x: 0.12, y: 0.95, xSource: "user", ySource: "user" },
    offline: { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
  };
  const gridSize = modelPadGridSizeForPlacements(placements, visibleValues);
  const editor = reflowVisibleModelPadPlacements(placements, visibleValues, gridSize);
  const picker = positionSavedModels(entries, placements);

  assert.equal(gridSize, modelGridSize(3));
  assert.deepEqual(
    picker.map(({ value, x, y }) => ({ value, x, y })),
    ["model-3", "model-7", "model-9"].map((value) => ({
      value,
      x: editor[value].x,
      y: editor[value].y,
    })),
  );
  assert.deepEqual(editor.offline, placements.offline);
});

test("colliding OpenRouter suggestions snap to distinct dots without outranking personal geometry", () => {
  const entries = [entry("a-suggested"), entry("b-suggested"), entry("z-personal")];
  const positioned = positionSavedModels(entries, {
    "a-suggested": { x: 0.5, y: 0.92, xSource: "neutral", ySource: "benchmark" },
    "b-suggested": { x: 0.5, y: 0.92, xSource: "neutral", ySource: "benchmark" },
    "z-personal": { x: 0.5, y: 0.92, xSource: "user", ySource: "user" },
  });
  const personal = positioned.find(({ value }) => value === "z-personal")!;
  const cells = positioned.map(({ x, y }) => `${x}:${y}`);

  assert.deepEqual({ x: personal.x, y: personal.y }, { x: 0.5, y: 1 });
  assert.equal(new Set(cells).size, positioned.length);
});

test("OpenRouter benchmark percentiles average ties and axis-aware suggestions disclose neutral pace", () => {
  const models = [entry("low"), entry("tied-a"), entry("tied-b"), entry("high")];
  const values = [10, 20, 20, 40];
  models.forEach((model, index) => {
    model.info = {
      id: model.model,
      matched: true,
      metadataSource: "models-dev",
      benchmark: {
        source: "openrouter",
        datasetSource: "artificial-analysis",
        sourceLabel: "Artificial Analysis via OpenRouter",
        sourceUrl: "https://artificialanalysis.ai",
        citation: "Source: Artificial Analysis via OpenRouter.",
        asOf: "2026-06-03T12:00:00.000Z",
        license: "CC BY 4.0",
        coding: values[index],
      },
    };
  });
  assert.deepEqual(Object.fromEntries(modelBenchmarkPercentiles(models, "coding")), {
    low: 0,
    "tied-a": 0.5,
    "tied-b": 0.5,
    high: 1,
  });
  const [suggested] = positionSavedModels(models, {
    low: { x: 0.5, y: 0.08, xSource: "neutral", ySource: "benchmark" },
  });
  assert.equal(suggested.confidence, "suggested");
  assert.equal(suggested.positionSource, "Benchmark capability · pace unmeasured");
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

test("catalog details stay with the provider that answered for a shared model id", () => {
  const hosted = provider({ id: "hosted", label: "Hosted", models: ["shared-model", "plain-model"] });
  const local = provider({ id: "local", label: "Local", models: ["shared-model"] });
  const entries = createModelEntries(
    [hosted, local],
    modelInfoByValue([hosted, local], {
      hosted: {
        "shared-model": {
          id: "shared-model",
          name: "Shared Model Pro",
          metadataSource: "models-dev" as const,
          matched: true,
        },
        // A stale answer for a model the provider no longer lists adds nothing.
        "retired-model": { id: "retired-model", metadataSource: "models-dev" as const, matched: true },
      },
    }),
  );
  assert.deepEqual(
    entries.map((entry) => [entry.value, entry.info?.matched ?? false]),
    [
      ["hosted::shared-model", true],
      ["hosted::plain-model", false],
      ["local::shared-model", false],
    ],
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

test("nearest selection ignores points beyond the capture radius of every model", () => {
  const models = positionSavedModels([entry("center"), entry("corner")], {
    center: { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    corner: { x: 0, y: 0, xSource: "user", ySource: "user" },
  });
  // About 0.32 from the center model and 0.45 from the corner one.
  const empty = { x: 0.95, y: 0.95 };
  assert.equal(nearestModel(models, empty, undefined, 0.025, MODEL_PAD_CAPTURE_RADIUS), undefined);
  assert.equal(nearestModel(models, empty, "center", 0.025, MODEL_PAD_CAPTURE_RADIUS), undefined);
  // Without a limit the nearest model still wins, as keyboard fallbacks expect.
  assert.equal(nearestModel(models, empty)?.value, "center");
  // Within the radius the nearest model is returned.
  assert.equal(
    nearestModel(models, { x: 0.12, y: 0.1 }, undefined, 0.025, MODEL_PAD_CAPTURE_RADIUS)?.value,
    "corner",
  );
  assert.equal(
    nearestModel(models, { x: 0.6, y: 0.62 }, "corner", 0.025, MODEL_PAD_CAPTURE_RADIUS)?.value,
    "center",
  );
});

test("benchmark coverage counts scored Pad and visible models and explains unmatched Pad models", () => {
  const scores = {
    source: "openrouter",
    datasetSource: "artificial-analysis",
    sourceLabel: "Artificial Analysis via OpenRouter",
    sourceUrl: "https://openrouter.ai",
    citation: "Artificial Analysis",
    asOf: "2026-10-01",
    license: "CC BY 4.0",
  } as const;
  const scored = (value: string): ModelEntry => ({
    ...entry(value),
    info: {
      id: value,
      metadataSource: "fallback",
      matched: true,
      benchmark: { ...scores, coding: 40 },
    },
  });
  const entries: ModelEntry[] = [
    scored("test::placed-scored"),
    { ...entry("test::placed-hosted"), label: "Hosted One" },
    { ...entry("ollama::placed-local"), label: "Local One", providerLabel: "Ollama", isLocal: true },
    // A benchmark record without a finite score is not a match.
    {
      ...entry("test::placed-empty"),
      info: { id: "empty", metadataSource: "fallback", matched: true, benchmark: { ...scores } },
    },
    scored("test::unplaced-scored"),
    entry("test::unplaced-unscored"),
  ];
  const at: ModelPadPlacement = { x: 0.5, y: 0.5, xSource: "user", ySource: "user" };
  const coverage = benchmarkCoverage(entries, {
    "test::placed-scored": at,
    "test::placed-hosted": at,
    "ollama::placed-local": at,
    "test::placed-empty": at,
    // A placement for a model that is no longer visible is not counted.
    "gone::model": at,
  });

  assert.deepEqual(coverage.pad, { matched: 1, total: 4 });
  assert.deepEqual(coverage.visible, { matched: 2, total: 6 });
  assert.deepEqual(coverage.unmatchedPad, [
    { value: "test::placed-hosted", label: "Hosted One", providerLabel: "Test", reason: "no-row" },
    { value: "ollama::placed-local", label: "Local One", providerLabel: "Ollama", reason: "local" },
    {
      value: "test::placed-empty",
      label: "test::placed-empty",
      providerLabel: "Test",
      reason: "no-row",
    },
  ]);
});

test("benchmark coverage of an empty Pad has nothing unmatched", () => {
  assert.deepEqual(benchmarkCoverage([entry("test::a")], {}), {
    pad: { matched: 0, total: 0 },
    visible: { matched: 0, total: 1 },
    unmatchedPad: [],
  });
});

function routeEntry(
  providerId: string,
  providerLabel: string,
  model: string,
  canonicalModelId?: string,
): ModelEntry {
  return {
    value: encodeSelection(providerId, model),
    providerId,
    model,
    label: model,
    format: null,
    providerLabel,
    isLocal: false,
    ...(canonicalModelId
      ? { info: { id: model, metadataSource: "models-dev", matched: true, canonicalModelId } }
      : {}),
  };
}

test("model identity prefers the catalog's canonical id and falls back to the id leaf", () => {
  assert.equal(
    modelIdentityKey(routeEntry("openrouter", "OpenRouter", "openai/GPT-4o", "OpenAI/gpt-4o")),
    "openai/gpt-4o",
  );
  // Without a canonical id the text after the last slash is the identity, date stamp kept.
  assert.equal(
    modelIdentityKey(routeEntry("router", "Router", "vendor/Claude-Sonnet-4-20250514")),
    "claude-sonnet-4-20250514",
  );
  assert.equal(modelIdentityKey(routeEntry("openai", "OpenAI", "gpt-4o")), "gpt-4o");
});

test("model siblings link other routes to the same model, never the entry itself", () => {
  const direct = routeEntry("openai", "OpenAI", "gpt-4o");
  const routed = routeEntry("openrouter", "OpenRouter", "openai/GPT-4o");
  const dated = routeEntry("azure", "Azure", "gpt-4o-2024-08-06");
  const loner = routeEntry("anthropic", "Anthropic", "claude-sonnet-4");
  const siblings = modelSiblings([direct, routed, dated, loner]);

  assert.deepEqual(
    siblings.get(direct.value)?.map((entry) => entry.value),
    [routed.value],
  );
  assert.deepEqual(
    siblings.get(routed.value)?.map((entry) => entry.value),
    [direct.value],
  );
  // A different date stamp is a different model, and entries without a sibling are absent.
  assert.equal(siblings.has(dated.value), false);
  assert.equal(siblings.has(loner.value), false);
});

test("a canonical id links routes whose ids differ, and an unmatched leaf stays apart", () => {
  const vendor = routeEntry("acme", "Acme", "acme-large-v2", "acme/large-2");
  const router = routeEntry("openrouter", "OpenRouter", "acme/large-2-preview", "acme/large-2");
  // No catalog row: its leaf ("large-2") is not the canonical "acme/large-2".
  const custom = routeEntry("custom", "Custom", "acme/large-2");
  const siblings = modelSiblings([vendor, router, custom]);
  assert.deepEqual(siblings.get(vendor.value)?.map((entry) => entry.providerLabel), [
    "OpenRouter",
  ]);
  assert.equal(siblings.has(custom.value), false);
});

test("three-way groups list every other route, and only the entries passed in count", () => {
  const a = routeEntry("openai", "OpenAI", "gpt-4o");
  const b = routeEntry("openrouter", "OpenRouter", "openai/gpt-4o");
  const c = routeEntry("azure", "Azure", "GPT-4o");
  const all = modelSiblings([a, b, c]);
  assert.deepEqual(all.get(a.value)?.map((entry) => entry.providerLabel), ["OpenRouter", "Azure"]);
  assert.deepEqual(all.get(c.value)?.map((entry) => entry.providerLabel), ["OpenAI", "OpenRouter"]);

  // Callers pass visible entries only, so a hidden route links nothing.
  const visible = visibleModelEntries([a, b, c], { openrouter: ["openai/gpt-4o"], azure: ["GPT-4o"] });
  assert.equal(modelSiblings(visible).size, 0);
});

test("the also-via label names one or two providers and counts the rest", () => {
  const one = [routeEntry("openrouter", "OpenRouter", "x")];
  const two = [...one, routeEntry("azure", "Azure", "x")];
  const four = [...two, routeEntry("groq", "Groq", "x"), routeEntry("vertex", "Vertex", "x")];
  assert.equal(alsoViaLabel(undefined), undefined);
  assert.equal(alsoViaLabel([]), undefined);
  assert.equal(alsoViaLabel(one), "Also via OpenRouter");
  assert.equal(alsoViaLabel(two), "Also via OpenRouter, Azure");
  assert.equal(alsoViaLabel(four), "Also via OpenRouter, Azure +2");
});
