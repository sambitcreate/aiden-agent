import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PINNED_MODELS,
  MAX_RECENT_MODELS,
  normalizePinnedModels,
  normalizeRecentModels,
  parseModelPreferencesPatch,
  recordRecentModel,
  remapPinnedModelsProvider,
  remapRecentModelsProvider,
  withoutProviderPinnedModels,
  withoutProviderRecentModels,
} from "./model-preferences.js";

test("pins are distinct provider::model strings capped at the documented limit", () => {
  assert.equal(normalizePinnedModels("openai::gpt"), undefined);
  assert.deepEqual(
    normalizePinnedModels(["openai::gpt", 7, "openai::gpt", "nope", "::x", "google::gemini"]),
    ["openai::gpt", "google::gemini"],
  );
  assert.deepEqual(normalizePinnedModels([`openai::${"m".repeat(1_024)}`, "a::b"]), ["a::b"]);
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

test("a settings patch accepts valid pin and recent fields and rejects malformed or oversized ones", () => {
  assert.deepEqual(parseModelPreferencesPatch({ exaEnabled: true }), {});
  // Retired Model Pad fields are not part of this patch.
  assert.deepEqual(
    parseModelPreferencesPatch({ modelPadPlacements: {}, modelPadMetric: "coding" }),
    {},
  );
  assert.deepEqual(parseModelPreferencesPatch({ pinnedModels: ["openai::gpt", "openai::gpt"] }), {
    pinnedModels: ["openai::gpt"],
  });
  assert.deepEqual(parseModelPreferencesPatch({ pinnedModels: [] }), { pinnedModels: [] });
  assert.deepEqual(
    parseModelPreferencesPatch({ recentModels: ["openai::gpt", "bare", "openai::gpt"] }),
    { recentModels: ["openai::gpt"] },
  );
  assert.throws(() => parseModelPreferencesPatch({ recentModels: "openai::gpt" }));
  assert.throws(() =>
    parseModelPreferencesPatch({
      recentModels: Array.from({ length: MAX_RECENT_MODELS + 1 }, (_, index) => `p::m${index}`),
    }),
  );
  assert.throws(() => parseModelPreferencesPatch({ pinnedModels: "openai::gpt" }));
  assert.throws(() =>
    parseModelPreferencesPatch({
      pinnedModels: Array.from({ length: MAX_PINNED_MODELS + 1 }, (_, index) => `p::m${index}`),
    }),
  );
});

test("provider remap moves pins and recents while a canonical entry wins", () => {
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
  assert.deepEqual(remapPinnedModelsProvider(["legacy-other::c"], "legacy", "canonical"), [
    "legacy-other::c",
  ]);
  assert.equal(remapRecentModelsProvider(undefined, "legacy", "canonical"), undefined);
  assert.equal(remapPinnedModelsProvider(undefined, "legacy", "canonical"), undefined);
});

test("provider removal drops only that provider's pins and recents", () => {
  assert.deepEqual(withoutProviderPinnedModels(["gone::a", "kept::a"], "gone"), ["kept::a"]);
  assert.deepEqual(withoutProviderRecentModels(["kept::a", "gone::b", "gone-too::c"], "gone"), [
    "kept::a",
    "gone-too::c",
  ]);
});
