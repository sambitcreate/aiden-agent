import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyModelPadLayout,
  modelPadLayoutsEqual,
  nextModelPadPlacement,
  parseModelPadLayout,
  readModelPadLayout,
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
      schemaVersion: 1,
      placements: { "openai::gpt": { x: 0.2, y: 0.8, source: "user" } },
    },
  );
});

test("model Pad layouts round-trip through device-local storage", () => {
  const storage = memoryStorage();
  const layout = {
    schemaVersion: 1 as const,
    placements: {
      "anthropic::claude": { x: 0.42, y: 0.86, source: "artificial-analysis" as const },
    },
  };
  assert.deepEqual(writeModelPadLayout(layout, storage), layout);
  assert.deepEqual(readModelPadLayout(storage), layout);
  assert.equal(modelPadLayoutsEqual(layout, readModelPadLayout(storage)), true);
});

test("new models receive deterministic, non-overlapping personal positions", () => {
  const first = nextModelPadPlacement({});
  const second = nextModelPadPlacement({ first });
  assert.deepEqual(first, nextModelPadPlacement({}));
  assert.equal(first.source, "user");
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) > 0.08);
});

test("large personal pads keep assigning unique open positions", () => {
  const placements: Record<string, ModelPadPlacement> = {};
  for (let index = 0; index < 80; index += 1) {
    placements[`model-${index}`] = nextModelPadPlacement(placements);
  }
  assert.equal(new Set(Object.values(placements).map(({ x, y }) => `${x}:${y}`)).size, 80);
});
