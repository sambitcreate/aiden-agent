import assert from "node:assert/strict";
import test from "node:test";
import {
  distributeCapabilityOnlyModelPadSuggestions,
  measureModelPadAvailableSize,
  MODEL_PAD_MIN_SIZE_PX,
  modelPadGridSize,
  modelPadGridSizeForPlacements,
  addModelPadPlacement,
  MODEL_PAD_KNOB_TAG_GUTTER_PX,
  modelPadKnobTagLayout,
  modelPadKnobTagSide,
  modelPadLabelPlacement,
  modelPadLeftPercent,
  modelPadTopPercent,
  modelPadPointKey,
  moveModelPadPoint,
  nearestAvailableModelPadPoint,
  nextModelPadPlacement,
  parseModelPadLayout,
  reflowVisibleModelPadPlacements,
  snapToModelPadGrid,
  type ModelPadPlacement,
} from "./model-pad-layout.js";

test("model Pad layouts fail closed and retain only valid axis-aware placements", () => {
  assert.deepEqual(parseModelPadLayout(null), { placements: {} });
  assert.deepEqual(parseModelPadLayout([]), { placements: {} });
  assert.deepEqual(parseModelPadLayout({ placements: [] }), { placements: {} });
  const layout = parseModelPadLayout({
    placements: {
      "openai::gpt": { x: 0.2, y: 0.8, xSource: "user", ySource: "benchmark" },
      "bad::range": { x: 4, y: 0.2, xSource: "user", ySource: "user" },
      "bad::source": { x: 0.2, y: 0.2, xSource: "generated", ySource: "user" },
      // Retired v1 single-source placements are not migrated.
      "anthropic::claude": { x: 0.42, y: 0.86, source: "artificial-analysis" },
    },
  });
  assert.deepEqual(layout, {
    placements: {
      "openai::gpt": { x: 0.2, y: 0.8, xSource: "user", ySource: "benchmark" },
    },
  });
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

test("the Pad grid counts only placed, visible models", () => {
  const placements: Record<string, ModelPadPlacement> = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `placed-${index}`,
      { x: 0.5, y: 0.5, xSource: "user", ySource: "user" } satisfies ModelPadPlacement,
    ]),
  );
  const placedValues = Object.keys(placements);
  const catalog = [
    ...placedValues,
    ...Array.from({ length: 290 }, (_, index) => `unplaced-${index}`),
  ];

  assert.equal(modelPadGridSizeForPlacements(placements, catalog), 9);
  assert.equal(modelPadGridSizeForPlacements(placements, placedValues), 9);
  // Hidden or unavailable placements do not grow the grid.
  assert.equal(modelPadGridSizeForPlacements(placements, placedValues.slice(0, 8)), 7);
  assert.equal(modelPadGridSizeForPlacements({}, catalog), 7);
});

test("adding a model places it against the grid for one more placed model", () => {
  const placements: Record<string, ModelPadPlacement> = {};
  for (let index = 0; index < 9; index += 1) {
    placements[`model-${index}`] = nextModelPadPlacement(placements);
  }
  // With nine models already placed, the tenth is placed on the 9x9 grid for ten models.
  const tenth = nextModelPadPlacement(placements, 10);
  const nineByNine = modelPadGridSize(10);
  assert.equal(nineByNine, 9);
  assert.deepEqual(snapToModelPadGrid(tenth, nineByNine), { x: tenth.x, y: tenth.y });
  assert.notDeepEqual(snapToModelPadGrid(tenth, 7), { x: tenth.x, y: tenth.y });
});

test("adding after a removal keeps existing dots on the grid they will share with the new one", () => {
  const ninth = (column: number, row: number): ModelPadPlacement => ({
    x: column / 8,
    y: row / 8,
    xSource: "user",
    ySource: "user",
  });
  // Nine models laid out on the 9x9 lattice; one is then removed (eight placed -> 7x7 grid).
  const placements: Record<string, ModelPadPlacement> = {
    m1: ninth(2, 4),
    m2: ninth(6, 4),
    m3: ninth(4, 1),
    m4: ninth(4, 7),
    m5: ninth(0, 0),
    m6: ninth(8, 8),
    m7: ninth(1, 6),
    m8: ninth(7, 2),
    offline: { x: 0.33, y: 0.66, xSource: "user", ySource: "benchmark" },
  };
  const visibleValues = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "new"];
  assert.equal(modelPadGridSizeForPlacements(placements, visibleValues), 7);

  const next = addModelPadPlacement(placements, visibleValues, "new");

  // Back to nine placed models on the 9x9 grid: every existing dot returns to where it was.
  for (const value of ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]) {
    assert.deepEqual(next[value], placements[value], value);
  }
  assert.deepEqual(next.offline, placements.offline);
  assert.equal(next.new.xSource, "user");
  assert.deepEqual(snapToModelPadGrid(next.new, 9), { x: next.new.x, y: next.new.y });
  const cells = visibleValues.map((value) => modelPadPointKey(next[value], 9));
  assert.equal(new Set(cells).size, visibleValues.length);
  // An already placed model is left alone.
  assert.equal(addModelPadPlacement(placements, visibleValues, "m1"), placements);
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

test("Model Pad available size leaves room for the suggestion bar and never exceeds the scrollport", () => {
  // 480px from the canvas top to the viewport bottom: the square, then the
  // suggestion bar row under it (48px) and the 24px gutter.
  assert.equal(
    measureModelPadAvailableSize({
      viewportBottom: 600,
      canvasTop: 120,
      canvasWidth: 1_000,
      scrollportClientHeight: 1_000,
    }),
    408,
  );
  // A narrow column caps it at the column width.
  assert.equal(
    measureModelPadAvailableSize({
      viewportBottom: 600,
      canvasTop: 120,
      canvasWidth: 300,
      scrollportClientHeight: 1_000,
    }),
    300,
  );
  assert.equal(
    measureModelPadAvailableSize({
      viewportBottom: 800,
      canvasTop: 100,
      canvasWidth: 500,
      scrollportClientHeight: 140,
    }),
    139,
  );
  assert.ok(
    measureModelPadAvailableSize({
      viewportBottom: 400,
      canvasTop: 280,
      canvasWidth: 400,
      scrollportClientHeight: 500,
    }) >= MODEL_PAD_MIN_SIZE_PX,
  );
});

test("keyboard movement advances by nodes and skips occupied points on its axis", () => {
  const next = moveModelPadPoint({ x: 0.5, y: 0.5 }, "right", 1, 7, [{ x: 4 / 6, y: 0.5 }]);
  assert.deepEqual(next, { x: 5 / 6, y: 0.5 });
  assert.deepEqual(moveModelPadPoint(next, "up", 3, 7, []), { x: 5 / 6, y: 1 });
});

test("marker labels flip below near the top edge and hug the left and right edges", () => {
  assert.deepEqual(modelPadLabelPlacement({ x: 0.5, y: 0.5 }), { align: "center", side: "top" });
  assert.deepEqual(modelPadLabelPlacement({ x: 0, y: 0 }), { align: "start", side: "top" });
  assert.deepEqual(modelPadLabelPlacement({ x: 1, y: 1 }), { align: "end", side: "bottom" });
  assert.deepEqual(modelPadLabelPlacement({ x: 0.2, y: 0.8 }), { align: "center", side: "top" });
});

test("marker label thresholds are exclusive at the edges", () => {
  assert.equal(modelPadLabelPlacement({ x: 0.16, y: 0.5 }).align, "center");
  assert.equal(modelPadLabelPlacement({ x: 0.84, y: 0.5 }).align, "center");
  assert.equal(modelPadLabelPlacement({ x: 0.1599, y: 0.5 }).align, "start");
  assert.equal(modelPadLabelPlacement({ x: 0.8401, y: 0.5 }).align, "end");
  assert.equal(modelPadLabelPlacement({ x: 0.5, y: 0.82 }).side, "top");
  assert.equal(modelPadLabelPlacement({ x: 0.5, y: 0.8201 }).side, "bottom");
});

/** Knob center in pixels for a normalized capability on a Pad of the given height. */
function knobTopPx(y: number, padHeight: number): number {
  return (modelPadTopPercent(y) / 100) * padHeight;
}

test("the knob tag drops below when a short Pad has no room above the knob", () => {
  // Minimum composer Pad (160px) with a two-line tag at a 14px UI font (38px).
  assert.equal(modelPadKnobTagSide({ knobTop: knobTopPx(0.75, 160), padHeight: 160, tagHeight: 38 }), "bottom");
  assert.equal(modelPadKnobTagSide({ knobTop: knobTopPx(0.8, 160), padHeight: 160, tagHeight: 38 }), "bottom");
  // An 18px UI font (46px tag) clips even on the second row of a seven-column grid.
  assert.equal(
    modelPadKnobTagSide({ knobTop: knobTopPx(5 / 6, 160), padHeight: 160, tagHeight: 46 }),
    "bottom",
  );
  // The same rows keep the tag above on a full-size Pad.
  assert.equal(modelPadKnobTagSide({ knobTop: knobTopPx(0.75, 300), padHeight: 300, tagHeight: 38 }), "top");
  // Near the bottom edge above is preferred, and it fits.
  assert.equal(modelPadKnobTagSide({ knobTop: knobTopPx(0, 160), padHeight: 160, tagHeight: 52 }), "top");
  // When neither side fits, the roomier side wins.
  assert.equal(modelPadKnobTagSide({ knobTop: 20, padHeight: 60, tagHeight: 50 }), "bottom");
  assert.equal(modelPadKnobTagSide({ knobTop: 40, padHeight: 60, tagHeight: 50 }), "top");
});

test("the knob tag stays inside the Pad gutters on every side and size", () => {
  const gutter = MODEL_PAD_KNOB_TAG_GUTTER_PX;
  const epsilon = 1e-9;
  for (const padSize of [160, 216, 300]) {
    // 90px is a three-line tag (name, provider, "Also via") that fits on neither side
    // of a mid-height knob on the smallest Pad, so it is clamped inside the gutters.
    for (const tagHeight of [38, 46, 60, 90]) {
      for (const x of [0, 0.1, 0.1599, 0.16, 0.3, 0.5, 0.7, 0.84, 0.8401, 0.9, 1]) {
        for (const y of [0, 1 / 6, 0.5, 0.75, 0.8, 5 / 6, 1]) {
          const layout = modelPadKnobTagLayout({
            point: { x, y },
            padWidth: padSize,
            padHeight: padSize,
            tagHeight,
          });
          const width = layout.maxWidth;
          const [left, right] =
            layout.align === "start"
              ? [layout.x, layout.x + width]
              : layout.align === "end"
                ? [layout.x - width, layout.x]
                : [layout.x - width / 2, layout.x + width / 2];
          const [top, bottom] =
            layout.side === "top" ? [layout.y - tagHeight, layout.y] : [layout.y, layout.y + tagHeight];
          const where = `${padSize}px pad, ${tagHeight}px tag at (${x}, ${y})`;
          assert.ok(width > 0, `${where} has room for text`);
          assert.ok(left >= gutter - epsilon, `${where} left edge`);
          assert.ok(right <= padSize - gutter + epsilon, `${where} right edge`);
          assert.ok(top >= gutter - epsilon, `${where} top edge`);
          assert.ok(bottom <= padSize - gutter + epsilon, `${where} bottom edge`);
        }
      }
    }
  }
});

test("edge-aligned knob tags line up with the knob's outer edge when there is room", () => {
  const padWidth = 300;
  const start = modelPadKnobTagLayout({ point: { x: 0, y: 0.5 }, padWidth, padHeight: 300, tagHeight: 38 });
  const end = modelPadKnobTagLayout({ point: { x: 1, y: 0.5 }, padWidth, padHeight: 300, tagHeight: 38 });
  const knobLeft = (modelPadLeftPercent(0) / 100) * padWidth;
  const knobRight = (modelPadLeftPercent(1) / 100) * padWidth;
  assert.equal(start.align, "start");
  assert.equal(start.x, knobLeft - 12);
  assert.equal(end.align, "end");
  assert.equal(end.x, knobRight + 12);
});
