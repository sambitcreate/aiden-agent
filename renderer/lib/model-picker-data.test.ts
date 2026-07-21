import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelEntries,
  decodeSelection,
  encodeSelection,
  findDirectionalModel,
  modelGridSize,
  nearestModel,
  orderModelEntries,
  parseModel,
  positionModels,
  type ModelEntry,
} from "./model-picker-data";
import type { Provider } from "./types";

function provider(overrides: Partial<Provider> & Pick<Provider, "id" | "label">): Provider {
  return {
    kind: "openai",
    baseUrl: "https://example.test/v1",
    models: [],
    needsKey: false,
    hasKey: true,
    ...overrides,
  };
}

function entry(value: string, model = value): ModelEntry {
  return {
    value,
    providerId: "test",
    model,
    label: model,
    format: null,
    providerLabel: "Test",
    isLocal: false,
  };
}

test("selection encoding preserves model ids and format parsing isolates quantization", () => {
  const encoded = encodeSelection("local", "org/model::variant");
  assert.deepEqual(decodeSelection(encoded), {
    providerId: "local",
    model: "org/model::variant",
  });
  assert.deepEqual(parseModel("qwen2.5-coder-32b Q4_K_M"), {
    label: "qwen2.5-coder-32b",
    format: "Q4_K_M",
  });
  assert.deepEqual(parseModel("gpt-4.1"), { label: "gpt-4.1", format: null });
});

test("entry creation includes every usable model, keeps hosted providers first, and ignores pins", () => {
  const providers = [
    provider({
      id: "local",
      label: "Local",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: ["local-a", "local-b"],
    }),
    provider({ id: "hosted", label: "Hosted", models: ["cloud-a"] }),
    provider({
      id: "locked",
      label: "Locked",
      models: ["hidden"],
      needsKey: true,
      hasKey: false,
    }),
  ];

  const entries = createModelEntries(providers);
  assert.deepEqual(
    entries.map((model) => model.value),
    ["hosted::cloud-a", "local::local-a", "local::local-b"],
  );
  assert.deepEqual(
    orderModelEntries(entries, ["local::local-b", "stale::model"]).map((model) => model.value),
    ["local::local-b", "hosted::cloud-a", "local::local-a"],
  );
  const coordinates = (models: ModelEntry[]) =>
    positionModels(models)
      .map(({ value, x, y }) => ({ value, x, y }))
      .sort((a, b) => a.value.localeCompare(b.value));
  assert.deepEqual(
    coordinates(entries),
    coordinates(orderModelEntries(entries, ["local::local-b"])),
  );
});

test("licensed benchmark percentiles map directly to capability and response-time axes", () => {
  const [fastCapable, slowCapable] = positionModels([
    {
      ...entry("fast-capable"),
      ranking: {
        capabilityPercentile: 0.9,
        responseTimePercentile: 0.1,
        source: "Licensed benchmark",
      },
    },
    {
      ...entry("slow-capable"),
      ranking: {
        capabilityPercentile: 0.86,
        responseTimePercentile: 0.88,
        source: "Licensed benchmark",
      },
    },
  ]);

  assert.equal(fastCapable.confidence, "benchmark");
  assert.equal(fastCapable.positionSource, "Licensed benchmark");
  assert.ok(fastCapable.x < slowCapable.x);
  assert.ok(fastCapable.y > 0.8);
  assert.equal(fastCapable.capabilityLabel, "Advanced");
  assert.equal(fastCapable.paceLabel, "Faster");
});

test("bundled rankings flow into the pad and stale embedding ids stay out of the picker", () => {
  const local = provider({
    id: "local",
    label: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["chat", "embed"],
    modelMetadata: {
      chat: { source: "lmstudio", type: "llm" },
      embed: { source: "lmstudio", type: "embedding" },
    },
  });
  const hosted = provider({ id: "hosted", label: "Hosted", models: ["ranked"] });
  const ranking = {
    capabilityPercentile: 0.92,
    responseTimePercentile: 0.18,
    source: "Artificial Analysis",
    sourceUrl: "https://artificialanalysis.ai",
  };
  const entries = createModelEntries([local, hosted], {
    "hosted::ranked": {
      id: "ranked",
      ranking,
      metadataSource: "artificial-analysis",
      matched: true,
    },
  });

  assert.deepEqual(
    entries.map((model) => model.value),
    ["hosted::ranked", "local::chat"],
  );
  assert.deepEqual(entries[0].ranking, ranking);
  assert.equal(positionModels(entries)[0].confidence, "benchmark");
});

test("explicit model variants create estimates while unknown models stay visibly unranked", () => {
  const positioned = positionModels([
    entry("flash", "gemini-flash"),
    entry("reasoner", "deepseek-reasoner"),
    entry("unknown-a", "private-model-a"),
    entry("unknown-b", "private-model-b"),
  ]);
  const flash = positioned.find((model) => model.value === "flash")!;
  const reasoner = positioned.find((model) => model.value === "reasoner")!;
  const unknownA = positioned.find((model) => model.value === "unknown-a")!;
  const unknownB = positioned.find((model) => model.value === "unknown-b")!;

  assert.equal(flash.confidence, "estimated");
  assert.equal(reasoner.confidence, "estimated");
  assert.ok(flash.x < reasoner.x);
  assert.ok(flash.y < reasoner.y);
  assert.equal(unknownA.confidence, "unranked");
  assert.match(unknownA.positionSource, /Benchmark unavailable/u);
  assert.notDeepEqual({ x: unknownA.x, y: unknownA.y }, { x: unknownB.x, y: unknownB.y });
});

test("every active model occupies a unique, equally spaced lattice point", () => {
  for (const count of [15, 130]) {
    const positioned = positionModels(
      Array.from({ length: count }, (_, index) =>
        entry(`model-${index}`, `private-model-${index}`),
      ),
    );
    const gridDivisions = modelGridSize(count) - 1;
    const cells = positioned.map(({ x, y }) => `${x.toFixed(8)}:${y.toFixed(8)}`);

    assert.equal(new Set(cells).size, positioned.length);
    for (const model of positioned) {
      assert.equal(Number((model.x * gridDivisions).toFixed(8)) % 1, 0);
      assert.equal(Number((model.y * gridDivisions).toFixed(8)) % 1, 0);
    }
  }
});

test("asynchronous capability metadata enriches details without shifting map geometry", () => {
  const base = entry("stable", "private-model");
  const [before] = positionModels([base]);
  const [after] = positionModels([
    {
      ...base,
      info: {
        id: "private-model",
        vision: true,
        toolCall: true,
        reasoning: true,
        openWeights: false,
        metadataSource: "models-dev",
        matched: true,
      },
    },
  ]);

  assert.deepEqual(
    { x: after.x, y: after.y, confidence: after.confidence },
    { x: before.x, y: before.y, confidence: before.confidence },
  );
});

test("nearest selection has hysteresis and directional navigation favors aligned models", () => {
  const models = positionModels([
    {
      ...entry("left"),
      ranking: {
        capabilityPercentile: 0.5,
        responseTimePercentile: 0.2,
        source: "Fixture",
      },
    },
    {
      ...entry("right"),
      ranking: {
        capabilityPercentile: 0.5,
        responseTimePercentile: 0.8,
        source: "Fixture",
      },
    },
    {
      ...entry("up"),
      ranking: {
        capabilityPercentile: 0.9,
        responseTimePercentile: 0.2,
        source: "Fixture",
      },
    },
  ]);

  assert.equal(nearestModel(models, { x: 0.49, y: 0.5 }, "left")?.value, "left");
  assert.equal(nearestModel(models, { x: 0.72, y: 0.5 }, "left")?.value, "right");
  assert.equal(findDirectionalModel(models, "left", "right")?.value, "right");
  assert.equal(findDirectionalModel(models, "left", "up")?.value, "up");
  assert.equal(findDirectionalModel(models, "left", "left")?.value, "left");
});
