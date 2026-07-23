import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_ARTIFICIAL_ANALYSIS_CATALOG,
  MAX_ARTIFICIAL_ANALYSIS_MODELS,
  artificialAnalysisRanking,
  findArtificialAnalysisModel,
  parseArtificialAnalysisUserCache,
} from "./artificial-analysis-catalog-core.js";
import type { ArtificialAnalysisCatalog, ArtificialAnalysisSnapshotModel } from "./artificial-analysis-catalog-core.js";

// A minimal, valid model row.
function model(overrides: Partial<ArtificialAnalysisSnapshotModel> = {}): ArtificialAnalysisSnapshotModel {
  return {
    id: "m1",
    slug: "model-one",
    name: "Model One",
    creator: "acme",
    ranking: {
      capability_percentile: 0.9,
      response_time_percentile: 0.3,
      pace_metric: "median_end_to_end_response_time_seconds",
    },
    ...overrides,
  };
}

// A complete, valid user-cache payload (the raw shape produced from a user's
// own API request, before normalization).
function validCachePayload(models: unknown[] = [model()]): Record<string, unknown> {
  return {
    schema_version: 1,
    source: {
      name: "Artificial Analysis",
      url: "https://artificialanalysis.ai/data-api",
      endpoint: "https://artificialanalysis.ai/api/v2/language/models/free",
      generation: "2026-07-15-abc",
      fetched_at: "2026-07-15T12:00:00.000Z",
      tier: "free",
      intelligence_index_version: 2,
    },
    models,
  };
}

// ── parseArtificialAnalysisUserCache ────────────────────────────────────────

test("parseArtificialAnalysisUserCache accepts a well-formed payload", () => {
  const cache = parseArtificialAnalysisUserCache(validCachePayload());
  assert.equal(cache.schema_version, 1);
  assert.equal(cache.source.tier, "free");
  assert.equal(cache.source.intelligence_index_version, 2);
  assert.equal(cache.models.length, 1);
  assert.equal(cache.models[0].id, "m1");
});

test("parseArtificialAnalysisUserCache rejects wrong schema version", () => {
  const bad = validCachePayload();
  bad.schema_version = 2;
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /schema version 1/);
});

test("parseArtificialAnalysisUserCache rejects wrong source name", () => {
  const bad = validCachePayload();
  (bad.source as Record<string, unknown>).name = "Someone Else";
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /invalid source/);
});

test("parseArtificialAnalysisUserCache rejects unexpected endpoint", () => {
  const bad = validCachePayload();
  (bad.source as Record<string, unknown>).endpoint = "https://example.com/api";
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /unexpected endpoint/);
});

test("parseArtificialAnalysisUserCache rejects malformed generation id", () => {
  const bad = validCachePayload();
  (bad.source as Record<string, unknown>).generation = "BAD GEN!"; // spaces/uppercase rejected
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /invalid generation/);
});

test("parseArtificialAnalysisUserCache rejects a non-timestamp fetched_at", () => {
  const bad = validCachePayload();
  (bad.source as Record<string, unknown>).fetched_at = "not-a-date";
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /ISO timestamp/);
});

test("parseArtificialAnalysisUserCache rejects an invalid tier", () => {
  const bad = validCachePayload();
  (bad.source as Record<string, unknown>).tier = "enterprise";
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /invalid tier/);
});

test("parseArtificialAnalysisUserCache rejects empty / oversized models arrays", () => {
  const empty = validCachePayload([]);
  assert.throws(() => parseArtificialAnalysisUserCache(empty), /must contain models/);
  const tooMany = validCachePayload(Array.from({ length: MAX_ARTIFICIAL_ANALYSIS_MODELS + 1 }, () => model()));
  assert.throws(() => parseArtificialAnalysisUserCache(tooMany), /must contain models/);
});

test("parseArtificialAnalysisUserCache rejects duplicate model ids", () => {
  const dup = validCachePayload([model(), model()]);
  assert.throws(() => parseArtificialAnalysisUserCache(dup), /duplicate model identifiers/);
});

test("parseArtificialAnalysisUserCache rejects a snapshot with no usable rankings", () => {
  const noRanking = validCachePayload([model({ ranking: undefined })]);
  assert.throws(() => parseArtificialAnalysisUserCache(noRanking), /no usable benchmark rankings/);
});

test("parseArtificialAnalysisUserCache rejects out-of-range percentiles", () => {
  const bad = validCachePayload([
    model({
      ranking: {
        capability_percentile: 1.5,
        response_time_percentile: 0.3,
        pace_metric: "median_end_to_end_response_time_seconds",
      },
    }),
  ]);
  assert.throws(() => parseArtificialAnalysisUserCache(bad), /between 0 and 1/);
});

test("parseArtificialAnalysisUserCache rejects a missing identity field on a model", () => {
  // Omitting id entirely reaches the aggregate "identity fields" check; an
  // empty string is instead caught earlier by optionalString.
  const { id: _omit, ...noId } = model();
  void _omit;
  const payload = validCachePayload([noId]);
  assert.throws(() => parseArtificialAnalysisUserCache(payload), /identity fields/);
});

test("parseArtificialAnalysisUserCache dedupes repeated modality entries", () => {
  const cache = parseArtificialAnalysisUserCache(
    validCachePayload([model({ input_modalities: ["text", "text", "image"] })]),
  );
  assert.deepEqual(cache.models[0].input_modalities, ["text", "image"]);
});

// ── findArtificialAnalysisModel ─────────────────────────────────────────────

const FIND_SNAPSHOT: ArtificialAnalysisCatalog = {
  schema_version: 1,
  source: {
    name: "Artificial Analysis",
    url: "https://artificialanalysis.ai/data-api",
    fetched_at: "2026-07-15T12:00:00.000Z",
    intelligence_index_version: 2,
  },
  models: [
    model({
      id: "openai/gpt-5",
      slug: "gpt-5",
      name: "GPT-5",
      creator: "openai",
      openrouter_api_id: "openai/gpt-5",
    }),
    model({
      id: "anthropic/claude-opus-5",
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      creator: "anthropic",
      huggingface_url: "https://huggingface.co/anthropic/claude-opus-5",
    }),
  ],
};

test("findArtificialAnalysisModel matches by exact slug alias", () => {
  const found = findArtificialAnalysisModel(FIND_SNAPSHOT, "gpt-5");
  assert.equal(found?.id, "openai/gpt-5");
});

test("findArtificialAnalysisModel matches by openrouter api id", () => {
  const found = findArtificialAnalysisModel(FIND_SNAPSHOT, "openai/gpt-5");
  assert.equal(found?.id, "openai/gpt-5");
});

test("findArtificialAnalysisModel matches by huggingface leaf identity", () => {
  const found = findArtificialAnalysisModel(
    FIND_SNAPSHOT,
    "https://huggingface.co/anthropic/claude-opus-5",
  );
  assert.equal(found?.id, "anthropic/claude-opus-5");
});

test("findArtificialAnalysisModel filters by creator hint", () => {
  // "gpt-5" slug belongs to openai; hinting anthropic excludes it.
  assert.equal(findArtificialAnalysisModel(FIND_SNAPSHOT, "gpt-5", "anthropic"), null);
});

test("findArtificialAnalysisModel falls back to canonical name only when unique + creator matches", () => {
  const found = findArtificialAnalysisModel(FIND_SNAPSHOT, "no-such-id", "openai", "GPT-5");
  assert.equal(found?.id, "openai/gpt-5");
  // No canonical name supplied -> no fallback.
  assert.equal(findArtificialAnalysisModel(FIND_SNAPSHOT, "no-such-id", "openai"), null);
});

test("findArtificialAnalysisModel returns null on ambiguous exact matches", () => {
  // Two models share the same slug via different aliases -> ambiguous -> null.
  const ambiguous: ArtificialAnalysisCatalog = {
    ...FIND_SNAPSHOT,
    models: [
      model({ id: "a", slug: "twin", name: "Twin A", creator: "acme" }),
      model({ id: "b", slug: "twin", name: "Twin B", creator: "acme" }),
    ],
  };
  assert.equal(findArtificialAnalysisModel(ambiguous, "twin"), null);
});

test("findArtificialAnalysisModel returns null on an empty catalog", () => {
  assert.equal(findArtificialAnalysisModel(EMPTY_ARTIFICIAL_ANALYSIS_CATALOG, "gpt-5"), null);
});

// ── artificialAnalysisRanking ───────────────────────────────────────────────

test("artificialAnalysisRanking returns undefined when the model has no ranking", () => {
  assert.equal(
    artificialAnalysisRanking(FIND_SNAPSHOT, model({ ranking: undefined })),
    undefined,
  );
});

test("artificialAnalysisRanking shapes a ModelRanking with the index version label", () => {
  const ranking = artificialAnalysisRanking(FIND_SNAPSHOT, model());
  assert.deepEqual(ranking, {
    capabilityPercentile: 0.9,
    responseTimePercentile: 0.3,
    source: "Artificial Analysis · Intelligence Index v2",
    sourceUrl: "https://artificialanalysis.ai",
    measuredAt: "2026-07-15T12:00:00.000Z",
  });
});

test("artificialAnalysisRanking omits the version label when the index version is null", () => {
  const snapshot: ArtificialAnalysisCatalog = {
    ...FIND_SNAPSHOT,
    source: { ...FIND_SNAPSHOT.source, intelligence_index_version: null },
  };
  const ranking = artificialAnalysisRanking(snapshot, model());
  assert.equal(ranking?.source, "Artificial Analysis");
});
