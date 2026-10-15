import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ARTIFICIAL_ANALYSIS_MODELS,
  parseArtificialAnalysisUserCache,
} from "./artificial-analysis-catalog-core.js";
import type { ArtificialAnalysisSnapshotModel } from "./artificial-analysis-catalog-core.js";

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
