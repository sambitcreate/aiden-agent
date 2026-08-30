import assert from "node:assert/strict";
import test from "node:test";
import {
  distributeCapabilityOnlyModelPadSuggestions,
  emptyModelPadLayout,
  modelPadGridSize,
  modelPadLayoutsEqual,
  modelPadPointKey,
  moveModelPadPoint,
  nearestAvailableModelPadPoint,
  nextModelPadPlacement,
  parseModelPadLayout,
  readModelPadLayout,
  reflowVisibleModelPadPlacements,
  snapToModelPadGrid,
  writeModelPadLayout,
  type ModelPadPlacement,
} from "./model-pad-layout.js";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

test("model Pad layouts fail closed and retain only valid placements", () => {
  assert.deepEqual(parseModelPadLayout(null), emptyModelPadLayout());
  assert.deepEqual(
    parseModelPadLayout({
      schemaVersion: 1,
      placements: {
        "openai::gpt": { x: 0.2, y: 0.8, source: "user" },
        "bad::range": { x: 4, y: 0.2, source: "user" },
        "bad::source": { x: 0.2, y: 0.2, source: "generated" },
      },
    }),
    {
      schemaVersion: 2,
      placements: {
        "openai::gpt": { x: 0.2, y: 0.8, xSource: "user", ySource: "user" },
      },
    },
  );
});

test("v1 model Pad layouts migrate and round-trip as axis-aware v2 layouts", () => {
  const storage = memoryStorage();
  const layout = parseModelPadLayout({
    schemaVersion: 1,
    placements: {
      "anthropic::claude": { x: 0.42, y: 0.86, source: "artificial-analysis" },
    },
  });
  assert.deepEqual(layout, {
    schemaVersion: 2,
    placements: {
      "anthropic::claude": {
        x: 0.42,
        y: 0.86,
        xSource: "benchmark",
        ySource: "benchmark",
      },
    },
  });
  assert.deepEqual(writeModelPadLayout(layout, storage), layout);
  assert.deepEqual(readModelPadLayout(storage), layout);
  assert.equal(modelPadLayoutsEqual(layout, readModelPadLayout(storage)), true);
});

test("new models receive deterministic, non-overlapping personal positions", () => {
  const first = nextModelPadPlacement({});
  const second = nextModelPadPlacement({ first });
  assert.deepEqual(first, nextModelPadPlacement({}));
  assert.equal(first.xSource, "user");
  assert.equal(first.ySource, "user");
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) > 0.08);
});

test("large personal pads keep assigning unique open positions", () => {
  const placements: Record<string, ModelPadPlacement> = {};
  for (let index = 0; index < 80; index += 1) {
    placements[`model-${index}`] = nextModelPadPlacement(placements);
  }
  assert.equal(new Set(Object.values(placements).map(({ x, y }) => `${x}:${y}`)).size, 80);
});

test("adaptive grids start at seven and scale by visible model count", () => {
  assert.equal(modelPadGridSize(0), 7);
  assert.equal(modelPadGridSize(8), 7);
  assert.equal(modelPadGridSize(10), 9);
  assert.equal(modelPadGridSize(40), 17);
  assert.equal(modelPadGridSize(100), 25);
});

test("pointer targets snap to nodes and choose the nearest free node", () => {
  assert.deepEqual(snapToModelPadGrid({ x: 0.18, y: 0.81 }, 7), {
    x: 1 / 6,
    y: 5 / 6,
  });
  const center = nearestAvailableModelPadPoint({ x: 0.51, y: 0.49 }, 7, []);
  assert.deepEqual(center, { x: 0.5, y: 0.5 });
  const neighbor = nearestAvailableModelPadPoint({ x: 0.5, y: 0.5 }, 7, [center]);
  assert.notEqual(modelPadPointKey(neighbor, 7), modelPadPointKey(center, 7));
});

test("visible reflow prioritizes personal placements and leaves hidden positions untouched", () => {
  const placements: Record<string, ModelPadPlacement> = {
    personal: { x: 0.49, y: 0.51, xSource: "user", ySource: "user" },
    suggested: { x: 0.5, y: 0.5, xSource: "neutral", ySource: "benchmark" },
    hidden: { x: 0.51, y: 0.51, xSource: "user", ySource: "user" },
  };
  const reflowed = reflowVisibleModelPadPlacements(placements, ["personal", "suggested"], 7);
  assert.deepEqual({ x: reflowed.personal.x, y: reflowed.personal.y }, { x: 0.5, y: 0.5 });
  assert.notEqual(modelPadPointKey(reflowed.suggested, 7), "3:3");
  assert.deepEqual(reflowed.hidden, placements.hidden);
});

test("reflow is deterministic, collision-free, and gives personal placements first choice", () => {
  const placements: Record<string, ModelPadPlacement> = {
    "a-suggestion": { x: 0.5, y: 0.5, xSource: "neutral", ySource: "benchmark" },
    "z-personal": { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
  };
  const forward = reflowVisibleModelPadPlacements(placements, ["a-suggestion", "z-personal"], 7);
  const reversed = reflowVisibleModelPadPlacements(placements, ["z-personal", "a-suggestion"], 7);

  assert.deepEqual(forward, reversed);
  assert.equal(modelPadPointKey(forward["z-personal"], 7), "3:3");
  assert.notEqual(
    modelPadPointKey(forward["a-suggestion"], 7),
    modelPadPointKey(forward["z-personal"], 7),
  );
});

test("large visible reflows keep every shown model on a unique grid dot", () => {
  const count = 500;
  const visibleValues = Array.from({ length: count }, (_, index) => `model-${index}`);
  const placements = Object.fromEntries(
    visibleValues.map((value) => [
      value,
      { x: 0.5, y: 0.5, xSource: "neutral", ySource: "benchmark" } satisfies ModelPadPlacement,
    ]),
  );
  const gridSize = modelPadGridSize(visibleValues.length);
  const reflowed = reflowVisibleModelPadPlacements(placements, visibleValues, gridSize);
  const occupied = visibleValues.map((value) => modelPadPointKey(reflowed[value], gridSize));

  assert.equal(new Set(occupied).size, count);
  assert.ok(gridSize * gridSize >= count);
});

test("capability-only suggestions spread across columns instead of forming a center stack", () => {
  const count = 63;
  const gridSize = 35;
  const suggestions = Array.from({ length: count }, (_, index) => ({
    value: `model-${index.toString().padStart(2, "0")}`,
    capabilityPercentile: 0.5,
  }));

  const placements = distributeCapabilityOnlyModelPadSuggestions(suggestions, gridSize, []);
  const points = Object.values(placements);
  const columns = points.map((point) => Math.round(point.x * (gridSize - 1)));

  assert.equal(points.length, count);
  assert.equal(new Set(points.map((point) => modelPadPointKey(point, gridSize))).size, count);
  assert.equal(new Set(columns).size, gridSize);
  assert.ok(Math.min(...columns) === 0 && Math.max(...columns) === gridSize - 1);
  assert.ok(
    points.every(({ xSource, ySource }) => xSource === "neutral" && ySource === "benchmark"),
  );
});

test("capability-only distribution is deterministic and preserves capability order on Y", () => {
  const suggestions = [
    { value: "most-capable", capabilityPercentile: 0.92 },
    { value: "middle-b", capabilityPercentile: 0.54 },
    { value: "least-capable", capabilityPercentile: 0.12 },
    { value: "middle-a", capabilityPercentile: 0.54 },
  ];
  const occupied = [{ x: 0.5, y: 0.5 }];
  const forward = distributeCapabilityOnlyModelPadSuggestions(suggestions, 7, occupied);
  const reversed = distributeCapabilityOnlyModelPadSuggestions(
    [...suggestions].reverse(),
    7,
    occupied,
  );

  assert.deepEqual(forward, reversed);
  assert.ok(forward["least-capable"].y <= forward["middle-a"].y);
  assert.ok(forward["middle-a"].y <= forward["middle-b"].y);
  assert.ok(forward["middle-b"].y <= forward["most-capable"].y);
  assert.ok(
    Object.values(forward).every(
      (point) => modelPadPointKey(point, 7) !== modelPadPointKey(occupied[0], 7),
    ),
  );
});

test("capability-only distribution fails closed for invalid and duplicate suggestions", () => {
  const placements = distributeCapabilityOnlyModelPadSuggestions(
    [
      { value: "valid", capabilityPercentile: 0.4 },
      { value: "valid", capabilityPercentile: 0.8 },
      { value: "invalid", capabilityPercentile: Number.NaN },
      { value: "", capabilityPercentile: 0.2 },
    ],
    7,
    [],
  );

  assert.deepEqual(Object.keys(placements), ["valid"]);
  assert.equal(placements.valid.y, 5 / 6);
});

test("keyboard movement advances by nodes and skips occupied points on its axis", () => {
  const next = moveModelPadPoint({ x: 0.5, y: 0.5 }, "right", 1, 7, [{ x: 4 / 6, y: 0.5 }]);
  assert.deepEqual(next, { x: 5 / 6, y: 0.5 });
  assert.deepEqual(moveModelPadPoint(next, "up", 3, 7, []), { x: 5 / 6, y: 1 });
});
