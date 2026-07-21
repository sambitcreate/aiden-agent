import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArtificialAnalysisSnapshot,
  percentileMap,
  validateModelsDevSnapshot,
} from "./model-snapshot-core.mjs";

function rawModel({ id, intelligence, responseTime, name = id }) {
  return {
    id,
    slug: id,
    name,
    release_date: "2026-07-01",
    model_creator: { id: `creator-${id}`, name: "Example" },
    reasoning_model: true,
    evaluations: {
      artificial_analysis_intelligence_index: intelligence,
      artificial_analysis_coding_index: intelligence - 1,
      artificial_analysis_agentic_index: intelligence - 2,
    },
    performance: {
      median_output_tokens_per_second: 100,
      median_time_to_first_token_seconds: 0.5,
      median_end_to_end_response_time_seconds: responseTime,
    },
    context_window_tokens: 131072,
    parameters: { total: 8 },
    modalities: {
      input: { text: true, image: id === "capable" },
      output: { text: true, image: false },
    },
    licensing: { is_open_weights: true },
    huggingface_url: `https://huggingface.co/example/${id}`,
    openrouter_api_id: `example/${id}`,
  };
}

test("percentiles use average ranks for ties", () => {
  const result = percentileMap(
    [
      { id: "a", score: 1 },
      { id: "b", score: 2 },
      { id: "c", score: 2 },
      { id: "d", score: 4 },
    ],
    (model) => model.score,
  );
  assert.equal(result.get("a"), 0);
  assert.equal(result.get("b"), 0.5);
  assert.equal(result.get("c"), 0.5);
  assert.equal(result.get("d"), 1);
});

test("snapshot normalization ranks capability upward and slower response time to the right", () => {
  const pages = [
    {
      tier: "commercial",
      intelligence_index_version: 4.1,
      pagination: { page: 1, page_size: 2, total_pages: 2, has_more: true },
      data: [
        rawModel({ id: "everyday", intelligence: 10, responseTime: 2 }),
        rawModel({ id: "capable", intelligence: 90, responseTime: 8 }),
      ],
    },
    {
      tier: "commercial",
      intelligence_index_version: 4.1,
      pagination: { page: 2, page_size: 2, total_pages: 2, has_more: false },
      data: [rawModel({ id: "balanced", intelligence: 50, responseTime: 5 })],
    },
  ];
  const snapshot = buildArtificialAnalysisSnapshot(pages, {
    fetchedAt: "2026-07-20T12:00:00.000Z",
    redistributionConfirmed: true,
  });
  const everyday = snapshot.models.find((model) => model.id === "everyday");
  const capable = snapshot.models.find((model) => model.id === "capable");

  assert.equal(snapshot.source.tier, "commercial");
  assert.equal(snapshot.models.length, 3);
  assert.equal(everyday.ranking.capability_percentile, 0);
  assert.equal(everyday.ranking.response_time_percentile, 0);
  assert.equal(capable.ranking.capability_percentile, 1);
  assert.equal(capable.ranking.response_time_percentile, 1);
  assert.deepEqual(capable.input_modalities, ["image", "text"]);
  assert.equal(capable.parameter_count_billions, 8);
});

test("snapshot generation rejects incomplete pages and missing rights confirmation", () => {
  const page = {
    tier: "pro",
    intelligence_index_version: 4.1,
    pagination: { page: 1, page_size: 1, total_pages: 2, has_more: true },
    data: [rawModel({ id: "one", intelligence: 1, responseTime: 1 })],
  };
  assert.throws(
    () =>
      buildArtificialAnalysisSnapshot([page], {
        fetchedAt: "2026-07-20T12:00:00.000Z",
        redistributionConfirmed: true,
      }),
    /inconsistent metadata/u,
  );
  assert.throws(
    () =>
      buildArtificialAnalysisSnapshot([], {
        fetchedAt: "2026-07-20T12:00:00.000Z",
        redistributionConfirmed: false,
      }),
    /Redistribution confirmation/u,
  );
  assert.throws(() => validateModelsDevSnapshot([]), /unexpected payload/u);
});
