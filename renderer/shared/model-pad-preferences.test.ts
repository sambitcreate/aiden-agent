import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MODEL_PAD_PLACEMENTS,
  MAX_PINNED_MODELS,
  MAX_RECENT_MODELS,
  normalizeModelPadPlacements,
  normalizePinnedModels,
  normalizeRecentModels,
  parseModelPadPreferencesPatch,
  recordRecentModel,
  remapModelPadPlacementsProvider,
  remapPinnedModelsProvider,
  remapRecentModelsProvider,
  withoutProviderModelPadPlacements,
  withoutProviderPinnedModels,
  withoutProviderRecentModels,
} from "./model-pad-preferences.js";

const user = { xSource: "user", ySource: "user" } as const;

test("placements keep only bounded provider::model keys with in-range coordinates and known sources", () => {
  assert.equal(normalizeModelPadPlacements(undefined), undefined);
  assert.equal(normalizeModelPadPlacements([]), undefined);
  assert.deepEqual(
    normalizeModelPadPlacements({
      "openai::gpt": { x: 0.2, y: 0.8, ...user },
      "anthropic::claude": { x: 1, y: 0, xSource: "neutral", ySource: "benchmark" },
      "bad::range": { x: 4, y: 0.2, ...user },
      "bad::nan": { x: Number.NaN, y: 0.2, ...user },
      "bad::source": { x: 0.2, y: 0.2, xSource: "generated", ySource: "user" },
      "bad::legacy-v1": { x: 0.2, y: 0.2, source: "user" },
      "no-separator": { x: 0.2, y: 0.2, ...user },
      "::missing-provider": { x: 0.2, y: 0.2, ...user },
      "missing-model::": { x: 0.2, y: 0.2, ...user },
      [`openai::${"m".repeat(1_024)}`]: { x: 0.2, y: 0.2, ...user },
    }),
    {
      "openai::gpt": { x: 0.2, y: 0.8, ...user },
      "anthropic::claude": { x: 1, y: 0, xSource: "neutral", ySource: "benchmark" },
    },
  );
});

test("placements are capped at the documented entry limit", () => {
  const raw = Object.fromEntries(
    Array.from({ length: MAX_MODEL_PAD_PLACEMENTS + 5 }, (_, index) => [
      `p::m${index}`,
      { x: 0.5, y: 0.5, ...user },
    ]),
  );
  assert.equal(Object.keys(normalizeModelPadPlacements(raw) ?? {}).length, MAX_MODEL_PAD_PLACEMENTS);
});

test("pins are distinct provider::model strings capped at the documented limit", () => {
  assert.equal(normalizePinnedModels("openai::gpt"), undefined);
  assert.deepEqual(
    normalizePinnedModels(["openai::gpt", 7, "openai::gpt", "nope", "::x", "google::gemini"]),
    ["openai::gpt", "google::gemini"],
  );
  const many = Array.from({ length: MAX_PINNED_MODELS + 3 }, (_, index) => `p::m${index}`);
  assert.equal(normalizePinnedModels(many)?.length, MAX_PINNED_MODELS);
});

test("recent models are distinct provider::model strings, newest first, at most five", () => {
  assert.equal(MAX_RECENT_MODELS, 5);
  assert.equal(normalizeRecentModels({ "openai::gpt": true }), undefined);
  assert.deepEqual(
    normalizeRecentModels(["openai::gpt", 7, "openai::gpt", "nope", "google::gemini"]),
    ["openai::gpt", "google::gemini"],
  );
  assert.deepEqual(
    normalizeRecentModels(["p::1", "p::2", "p::3", "p::4", "p::5", "p::6", "p::7"]),
    ["p::1", "p::2", "p::3", "p::4", "p::5"],
  );
});

test("recording a recent model moves it to the front and keeps the newest five", () => {
  assert.deepEqual(recordRecentModel([], "openai::gpt"), ["openai::gpt"]);
  assert.deepEqual(recordRecentModel(["a::1", "b::2", "c::3"], "b::2"), ["b::2", "a::1", "c::3"]);
  assert.deepEqual(recordRecentModel(["a::1", "b::2", "c::3", "d::4", "e::5"], "f::6"), [
    "f::6",
    "a::1",
    "b::2",
    "c::3",
    "d::4",
  ]);
  // Re-choosing the newest model leaves the history as it was.
  assert.deepEqual(recordRecentModel(["a::1", "b::2"], "a::1"), ["a::1", "b::2"]);
  // Something that is not a model key is never recorded.
  assert.deepEqual(recordRecentModel(["a::1"], "not-a-model"), ["a::1"]);
});

test("a settings patch accepts valid Pad fields and rejects malformed or oversized ones", () => {
  assert.deepEqual(parseModelPadPreferencesPatch({ exaEnabled: true }), {});
  assert.deepEqual(
    parseModelPadPreferencesPatch({
      modelPadPlacements: {
        "openai::gpt": { x: 0.5, y: 0.5, ...user },
        "bad::range": { x: 2, y: 0.5, ...user },
      },
      pinnedModels: ["openai::gpt", "openai::gpt"],
    }),
    {
      modelPadPlacements: { "openai::gpt": { x: 0.5, y: 0.5, ...user } },
      pinnedModels: ["openai::gpt"],
    },
  );
  assert.deepEqual(parseModelPadPreferencesPatch({ modelPadPlacements: {}, pinnedModels: [] }), {
    modelPadPlacements: {},
    pinnedModels: [],
  });
  assert.deepEqual(
    parseModelPadPreferencesPatch({ recentModels: ["openai::gpt", "bare", "openai::gpt"] }),
    { recentModels: ["openai::gpt"] },
  );
  assert.throws(() => parseModelPadPreferencesPatch({ recentModels: "openai::gpt" }));
  assert.throws(() =>
    parseModelPadPreferencesPatch({
      recentModels: Array.from({ length: MAX_RECENT_MODELS + 1 }, (_, index) => `p::m${index}`),
    }),
  );
  assert.throws(() => parseModelPadPreferencesPatch({ modelPadPlacements: [] }));
  assert.throws(() => parseModelPadPreferencesPatch({ pinnedModels: "openai::gpt" }));
  assert.throws(() =>
    parseModelPadPreferencesPatch({
      pinnedModels: Array.from({ length: MAX_PINNED_MODELS + 1 }, (_, index) => `p::m${index}`),
    }),
  );
  assert.throws(() =>
    parseModelPadPreferencesPatch({
      modelPadPlacements: Object.fromEntries(
        Array.from({ length: MAX_MODEL_PAD_PLACEMENTS + 1 }, (_, index) => [
          `p::m${index}`,
          { x: 0, y: 0, ...user },
        ]),
      ),
    }),
  );
});

test("provider remap moves placement keys and pins while a canonical entry wins", () => {
  const placements = {
    "legacy::a": { x: 0.1, y: 0.1, ...user },
    "legacy::b": { x: 0.2, y: 0.2, ...user },
    "canonical::b": { x: 0.9, y: 0.9, ...user },
    "legacy-other::c": { x: 0.3, y: 0.3, ...user },
  };
  assert.deepEqual(remapModelPadPlacementsProvider(placements, "legacy", "canonical"), {
    "canonical::a": { x: 0.1, y: 0.1, ...user },
    "canonical::b": { x: 0.9, y: 0.9, ...user },
    "legacy-other::c": { x: 0.3, y: 0.3, ...user },
  });
  assert.deepEqual(
    remapPinnedModelsProvider(
      ["legacy::b", "openai::gpt", "canonical::b", "legacy::a"],
      "legacy",
      "canonical",
    ),
    ["openai::gpt", "canonical::b", "canonical::a"],
  );
  assert.deepEqual(
    remapRecentModelsProvider(["legacy::b", "canonical::b", "legacy::a"], "legacy", "canonical"),
    ["canonical::b", "canonical::a"],
  );
  assert.equal(remapRecentModelsProvider(undefined, "legacy", "canonical"), undefined);
  assert.equal(remapModelPadPlacementsProvider(undefined, "legacy", "canonical"), undefined);
  assert.equal(remapPinnedModelsProvider(undefined, "legacy", "canonical"), undefined);
});

test("provider removal drops only that provider's placements and pins", () => {
  assert.deepEqual(
    withoutProviderModelPadPlacements(
      {
        "gone::a": { x: 0.1, y: 0.1, ...user },
        "gone-too::a": { x: 0.2, y: 0.2, ...user },
      },
      "gone",
    ),
    { "gone-too::a": { x: 0.2, y: 0.2, ...user } },
  );
  assert.deepEqual(withoutProviderPinnedModels(["gone::a", "kept::a"], "gone"), ["kept::a"]);
  assert.deepEqual(withoutProviderRecentModels(["kept::a", "gone::b", "gone-too::c"], "gone"), [
    "kept::a",
    "gone-too::c",
  ]);
});
