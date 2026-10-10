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
  assert.deepEqual(result.lacking, ["p::a"]);
  // Enough chats, but no usable token rate: not a matter of chatting more.
  assert.deepEqual(result.unscored, ["p::b"]);
  assert.equal(result.placements, placements);
});

test("setting pace again on an already measured layout changes nothing", () => {
  const placements: ModelPadPlacements = {
    "p::a": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    "p::b": { x: 0.5, y: 1, xSource: "user", ySource: "benchmark" },
  };
  const summaries = { "p::a": pace(100, 200), "p::b": pace(4_000, 20) };
  const first = measuredPacePlacements(placements, ["p::a", "p::b"], summaries);
  assert.notEqual(first.placements, placements);
  const again = measuredPacePlacements(first.placements, ["p::a", "p::b"], summaries);
  assert.equal(again.placements, first.placements);
  assert.deepEqual(again.updated.sort(), ["p::a", "p::b"]);
});

test("in a row with a taken dot, a faster model never lands right of a slower one", () => {
  // Thirteen placed models: a 9 × 9 grid (eight divisions). Twelve are measured,
  // so ranks 1 and 2 both target column 1, which a placed-by-you model holds.
  const placements: ModelPadPlacements = {
    "p::held": { x: 1 / 8, y: 0, xSource: "user", ySource: "user" },
    "p::rank1": { x: 3 / 8, y: 0, xSource: "user", ySource: "user" },
    "p::rank2": { x: 4 / 8, y: 0, xSource: "user", ySource: "user" },
  };
  const summaries: Record<string, ModelPaceSummary> = {
    "p::rank1": pace(1_000, 100),
    "p::rank2": pace(1_100, 100),
  };
  for (let index = 0; index < 10; index += 1) {
    const value = `p::other${index}`;
    // Rows 1–8 of the left edge, then rows 1–2 of the right edge.
    placements[value] =
      index < 8
        ? { x: 0, y: (index + 1) / 8, xSource: "user", ySource: "user" }
        : { x: 1, y: (index - 7) / 8, xSource: "user", ySource: "user" };
    // other0 is the fastest; the rest are slower than rank 1 and rank 2.
    summaries[value] = index === 0 ? pace(10, 1_000) : pace(5_000 + index * 100, 10);
  }
  const visible = Object.keys(placements);
  const result = measuredPacePlacements(placements, visible, summaries);

  assert.equal(result.updated.length, 12);
  const rank1 = result.placements["p::rank1"];
  const rank2 = result.placements["p::rank2"];
  assert.equal(rank1.y, 0);
  assert.equal(rank2.y, 0);
  assert.ok(rank1.x < rank2.x, `faster at ${rank1.x}, slower at ${rank2.x}`);
  assert.deepEqual([rank1.x, rank2.x], [0, 2 / 8]);
  const keys = visible.map((value) => modelPadPointKey(result.placements[value], 9));
  assert.equal(new Set(keys).size, keys.length);
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
