import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatModelProviders,
  createModelEntries,
  decodeSelection,
  encodeSelection,
  modelInfoByValue,
  orderModelEntries,
  parseModel,
  recentModelsForList,
  visibleModelEntries,
  resolveExplicitModelSelection,
  alsoViaLabel,
  alsoViaProviders,
  modelIdentityKey,
  modelSiblings,
  type ModelEntry,
} from "./model-picker-data";
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

test("picker entries carry custom provider artwork into the model list", () => {
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

test("entry creation includes every usable model, keeps hosted providers first, and pins lead the list", () => {
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

test("stale embedding ids stay out of the picker", () => {
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
  const hosted = provider({ id: "hosted", label: "Hosted", models: ["cloud"] });
  const entries = createModelEntries([local, hosted]);

  assert.deepEqual(
    entries.map((model) => model.value),
    ["hosted::cloud", "local::chat"],
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

test("catalog details stay with the provider that answered for a shared model id", () => {
  const hosted = provider({
    id: "hosted",
    label: "Hosted",
    models: ["shared-model", "plain-model"],
  });
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
        "retired-model": {
          id: "retired-model",
          metadataSource: "models-dev" as const,
          matched: true,
        },
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

test("model identity is the leaf of the catalog's canonical id, else of the model id", () => {
  assert.equal(
    modelIdentityKey(
      routeEntry("openrouter", "OpenRouter", "openai/gpt-4o-latest", "OpenAI/GPT-4o"),
    ),
    "gpt-4o",
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

test("a canonical id links routes whose ids differ, including an uncatalogued route", () => {
  const vendor = routeEntry("acme", "Acme", "acme-large-v2", "acme/large-2");
  const router = routeEntry("openrouter", "OpenRouter", "acme/large-2-preview", "acme/large-2");
  // No catalog row: its leaf ("large-2") matches the canonical id's leaf.
  const custom = routeEntry("custom", "Custom", "acme/large-2");
  const siblings = modelSiblings([vendor, router, custom]);
  assert.deepEqual(
    siblings.get(vendor.value)?.map((entry) => entry.providerLabel),
    ["OpenRouter", "Custom"],
  );
  assert.deepEqual(
    siblings.get(custom.value)?.map((entry) => entry.providerLabel),
    ["Acme", "OpenRouter"],
  );
});

test("a direct route without catalog data links to catalogued routers of the same model", () => {
  const direct = routeEntry("openai", "OpenAI", "gpt-4o");
  const router = routeEntry("openrouter", "OpenRouter", "openai/gpt-4o", "openai/gpt-4o");
  const azure = routeEntry("azure", "Azure", "gpt-4o", "openai/gpt-4o");
  const siblings = modelSiblings([direct, router, azure]);
  assert.deepEqual(
    siblings.get(direct.value)?.map((entry) => entry.providerLabel),
    ["OpenRouter", "Azure"],
  );
  assert.deepEqual(
    siblings.get(azure.value)?.map((entry) => entry.providerLabel),
    ["OpenAI", "OpenRouter"],
  );
});

test("two different canonical ids that share a leaf stay apart", () => {
  const first = routeEntry("acme", "Acme", "large", "acme/large");
  const second = routeEntry("globex", "Globex", "large", "globex/large");
  assert.equal(modelSiblings([first, second]).size, 0);
  // An uncatalogued route with that leaf links to both; they still do not link to each other.
  const custom = routeEntry("custom", "Custom", "large");
  const siblings = modelSiblings([first, second, custom]);
  assert.deepEqual(
    siblings.get(first.value)?.map((entry) => entry.providerLabel),
    ["Custom"],
  );
  assert.deepEqual(
    siblings.get(custom.value)?.map((entry) => entry.providerLabel),
    ["Acme", "Globex"],
  );
});

test("models from the same provider are never siblings of each other", () => {
  const flash = routeEntry("zai", "Z.AI", "glm-5.3-flash", "zai/glm-5.3-flash");
  const flashx = routeEntry("zai", "Z.AI", "vendor/glm-5.3-flash", "zai/glm-5.3-flash");
  const router = routeEntry("openrouter", "OpenRouter", "zai/glm-5.3-flash", "zai/glm-5.3-flash");
  const alone = modelSiblings([flash, flashx]);
  assert.equal(alone.size, 0);
  const siblings = modelSiblings([flash, flashx, router]);
  assert.deepEqual(
    siblings.get(flash.value)?.map((entry) => entry.providerLabel),
    ["OpenRouter"],
  );
  assert.deepEqual(
    siblings.get(router.value)?.map((entry) => entry.value),
    [flash.value, flashx.value],
  );
  assert.equal(alsoViaLabel(siblings.get(router.value)), "Also via Z.AI");
});

test("three-way groups list every other route, and only the entries passed in count", () => {
  const a = routeEntry("openai", "OpenAI", "gpt-4o");
  const b = routeEntry("openrouter", "OpenRouter", "openai/gpt-4o");
  const c = routeEntry("azure", "Azure", "GPT-4o");
  const all = modelSiblings([a, b, c]);
  assert.deepEqual(
    all.get(a.value)?.map((entry) => entry.providerLabel),
    ["OpenRouter", "Azure"],
  );
  assert.deepEqual(
    all.get(c.value)?.map((entry) => entry.providerLabel),
    ["OpenAI", "OpenRouter"],
  );

  // Callers pass visible entries only, so a hidden route links nothing.
  const visible = visibleModelEntries([a, b, c], {
    openrouter: ["openai/gpt-4o"],
    azure: ["GPT-4o"],
  });
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
  assert.equal(alsoViaProviders(four), "OpenRouter, Azure +2");
  assert.equal(alsoViaProviders([]), undefined);
});
