import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModelPace,
  measuredPacePlacements,
  paceScoreMs,
} from "./model-pad-pace";
import { modelPadPointKey, reflowVisibleModelPadPlacements } from "./model-pad-layout";
import type { ModelPadPlacements } from "../shared/model-pad-preferences";
import type { ModelPaceSummary } from "../shared/model-pace";

function pace(medianTtftMs: number, medianTokensPerSecond: number, sampleCount = 3): ModelPaceSummary {
  return { medianTtftMs, medianTokensPerSecond, sampleCount, lastSampledAt: 1 };
}

// Three or four placed models keep the Pad at its 7 × 7 base grid (six divisions).
const step = 1 / 6;

test("pace score is the time to a 500-token answer, and needs a positive token rate", () => {
  assert.equal(paceScoreMs(pace(400, 50)), 400 + 10_000);
  assert.equal(paceScoreMs(pace(1_000, 100)), 6_000);
  assert.equal(paceScoreMs(pace(400, 0)), undefined);
  assert.equal(paceScoreMs(pace(400, -3)), undefined);
  assert.equal(paceScoreMs(pace(400, Number.NaN)), undefined);
  assert.equal(paceScoreMs(pace(Number.POSITIVE_INFINITY, 50)), undefined);
});

test("measured models spread from fastest (left) to slowest (right); height and its source stay", () => {
  const placements: ModelPadPlacements = {
    "p::fast": { x: 0.5, y: 1, xSource: "user", ySource: "user" },
    "p::mid": { x: 0.5, y: 4 * step, xSource: "neutral", ySource: "benchmark" },
    "p::slow": { x: 0.5, y: 2 * step, xSource: "user", ySource: "benchmark" },
    "p::new": { x: 0.5, y: 0, xSource: "user", ySource: "user" },
  };
  const summaries = {
    // Fast to first token but slow to stream loses to a steady streamer.
    "p::slow": pace(200, 10),
    "p::fast": pace(900, 250),
    "p::mid": pace(400, 100),
    // Too few chats yet: untouched.
    "p::new": pace(100, 500, 2),
  };
  const visible = Object.keys(placements);
  const result = measuredPacePlacements(placements, visible, summaries);

  assert.deepEqual(result.updated.sort(), ["p::fast", "p::mid", "p::slow"]);
  assert.deepEqual(result.lacking, ["p::new"]);
  assert.deepEqual(result.placements["p::fast"], { x: 0, y: 1, xSource: "measured", ySource: "user" });
  assert.deepEqual(result.placements["p::mid"], {
    x: 0.5,
    y: 4 * step,
    xSource: "measured",
    ySource: "benchmark",
  });
  assert.deepEqual(result.placements["p::slow"], {
    x: 1,
    y: 2 * step,
    xSource: "measured",
    ySource: "benchmark",
  });
  assert.deepEqual(result.placements["p::new"], placements["p::new"]);
});

test("models without enough samples are listed as lacking, and nothing moves when none qualify", () => {
  const placements: ModelPadPlacements = {
    "p::a": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    "p::b": { x: 0, y: 0, xSource: "user", ySource: "user" },
  };
  const result = measuredPacePlacements(placements, ["p::a", "p::b"], {
    "p::a": pace(300, 80, 1),
    "p::b": pace(300, 0, 9),
  });
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.lacking.sort(), ["p::a", "p::b"]);
  assert.equal(result.placements, placements);
});

test("one measured model sits in the middle; tied scores share the average rank", () => {
  const single = measuredPacePlacements(
    { "p::only": { x: 0, y: 0.5, xSource: "user", ySource: "user" } },
    ["p::only"],
    { "p::only": pace(500, 50) },
  );
  assert.equal(single.placements["p::only"].x, 0.5);

  const placements: ModelPadPlacements = {
    "p::a": { x: 0, y: 0, xSource: "user", ySource: "user" },
    "p::b": { x: 0, y: 0.5, xSource: "user", ySource: "user" },
    "p::c": { x: 0, y: 1, xSource: "user", ySource: "user" },
  };
  const tied = measuredPacePlacements(placements, Object.keys(placements), {
    "p::a": pace(500, 50),
    "p::b": pace(500, 50),
    "p::c": pace(2_000, 50),
  });
  // Ranks 0 and 1 average to 0.5 of two steps: a quarter of the way, which snaps to column 2.
  assert.equal(Math.round(tied.placements["p::a"].x * 6), 2);
  assert.equal(Math.round(tied.placements["p::b"].x * 6), 2);
  assert.equal(tied.placements["p::c"].x, 1);
});

test("a taken dot pushes a measured model sideways in its own row, never onto another model", () => {
  const placements: ModelPadPlacements = {
    // A placed-by-you model already holds the slow end of the middle row.
    "p::anchor": { x: 1, y: 0.5, xSource: "user", ySource: "user" },
    "p::fast": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    "p::slow": { x: 0.5 - step, y: 0.5, xSource: "user", ySource: "user" },
  };
  const visible = Object.keys(placements);
  const result = measuredPacePlacements(placements, visible, {
    "p::fast": pace(200, 200),
    "p::slow": pace(3_000, 20),
  });

  assert.deepEqual(result.placements["p::anchor"], placements["p::anchor"]);
  assert.equal(result.placements["p::fast"].x, 0);
  assert.equal(result.placements["p::slow"].x, 1 - step);
  assert.equal(result.placements["p::slow"].y, 0.5);
  const keys = visible.map((value) => modelPadPointKey(result.placements[value], 7));
  assert.equal(new Set(keys).size, keys.length);
  // Already collision-free on the lattice, so the Pad shows it exactly as saved.
  assert.deepEqual(reflowVisibleModelPadPlacements(result.placements, visible), result.placements);
});

test("measured models sharing a crowded row keep their pace order", () => {
  const placements: ModelPadPlacements = {};
  for (let column = 2; column <= 6; column += 1) {
    placements[`p::fixed${column}`] = { x: column * step, y: 0, xSource: "user", ySource: "user" };
  }
  placements["p::slow"] = { x: 0, y: 0, xSource: "user", ySource: "user" };
  placements["p::fast"] = { x: step, y: 0, xSource: "user", ySource: "user" };
  const visible = Object.keys(placements);
  const result = measuredPacePlacements(placements, visible, {
    "p::slow": pace(5_000, 10),
    "p::fast": pace(100, 400),
  });
  // Only the two dots they leave are free in their row, so they trade places.
  assert.equal(result.placements["p::fast"].x, 0);
  assert.equal(result.placements["p::slow"].x, step);
  assert.equal(result.placements["p::slow"].y, 0);
  const keys = visible.map((value) => modelPadPointKey(result.placements[value], 7));
  assert.equal(new Set(keys).size, keys.length);
});

test("hidden placements are kept as saved and reserve no dot", () => {
  const placements: ModelPadPlacements = {
    "p::hidden": { x: 0, y: 0.5, xSource: "user", ySource: "user" },
    "p::a": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    "p::b": { x: 0.5, y: 1, xSource: "user", ySource: "user" },
  };
  const result = measuredPacePlacements(placements, ["p::a", "p::b"], {
    "p::hidden": pace(10, 1_000),
    "p::a": pace(100, 200),
    "p::b": pace(4_000, 20),
  });
  assert.deepEqual(result.placements["p::hidden"], placements["p::hidden"]);
  assert.deepEqual(result.updated.sort(), ["p::a", "p::b"]);
  assert.equal(result.placements["p::a"].x, 0);
});

test("pace reads as seconds to the first token and a rounded token rate", () => {
  assert.equal(formatModelPace(pace(420, 61.6)), "0.4 s first token · 62 tok/s");
  assert.equal(formatModelPace(pace(9_960, 8.2)), "10 s first token · 8 tok/s");
  assert.equal(formatModelPace(pace(12_340, 140)), "12 s first token · 140 tok/s");
});
