import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelEntry } from "../lib/model-picker-data";
import type { ModelBenchmarkScores, ModelInfo } from "../lib/types";
import type { ModelPaceSummary } from "../shared/model-pace";
import { ModelHoverDetails } from "./model-picker";

const DAY_MS = 24 * 60 * 60 * 1_000;

function entry(overrides: Partial<ModelEntry> = {}, info: Partial<ModelInfo> = {}): ModelEntry {
  return {
    value: "anthropic::claude-test",
    providerId: "anthropic",
    model: "claude-test",
    label: "Claude Test",
    format: null,
    providerLabel: "Anthropic",
    isLocal: false,
    info: { id: "claude-test", metadataSource: "models-dev", matched: true, ...info },
    ...overrides,
  };
}

function benchmark(asOf: string): ModelBenchmarkScores {
  return {
    source: "openrouter",
    datasetSource: "artificial-analysis",
    sourceLabel: "Artificial Analysis via OpenRouter",
    sourceUrl: "https://openrouter.ai",
    citation: "Artificial Analysis",
    asOf,
    license: "CC BY 4.0",
    coding: 40,
  };
}

function pace(sampleCount: number): ModelPaceSummary {
  return { medianTtftMs: 420, medianTokensPerSecond: 61.6, sampleCount, lastSampledAt: 1 };
}

/** The card's detail rows as label → value. */
function rows(markup: string): Map<string, string> {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return new Map(
    [...container.querySelectorAll("dl > div")].map((row) => [
      row.querySelector("dt")?.textContent ?? "",
      row.querySelector("dd")?.textContent ?? "",
    ]),
  );
}

function render(props: Parameters<typeof ModelHoverDetails>[0]): Map<string, string> {
  return rows(renderToStaticMarkup(<ModelHoverDetails {...props} />));
}

test("the detail card shows the list price and the speed measured on this device", () => {
  const details = render({
    model: entry({}, { cost: { input: 3, output: 15, cacheRead: 0.3 } }),
    pace: pace(4),
    metadataLoading: false,
  });
  assert.equal(details.get("List price"), "$3 / $15 per 1M");
  assert.equal(details.get("Your speed"), "0.4 s first token · 62 tok/s (4 runs)");
});

test("a single measured run is named in the singular", () => {
  const details = render({ model: entry(), pace: pace(1), metadataLoading: false });
  assert.equal(details.get("Your speed"), "0.4 s first token · 62 tok/s (1 run)");
});

test("measured speed shows even when the catalog knows nothing about the model", () => {
  const details = render({
    model: entry({}, { matched: false, metadataSource: "fallback" }),
    pace: pace(2),
    metadataLoading: false,
  });
  assert.equal(details.get("Your speed"), "0.4 s first token · 62 tok/s (2 runs)");
});

test("local and custom endpoints never show an inherited list price", () => {
  const cost = { input: 3, output: 15 };
  const local = render({
    model: entry({ providerId: "ollama", providerLabel: "Ollama", isLocal: true }, { cost }),
    metadataLoading: false,
  });
  assert.equal(local.has("List price"), false);
  const privateOpenAi = render({ model: entry({ providerId: "openai", isLocal: true }, { cost }), metadataLoading: false });
  assert.equal(privateOpenAi.has("List price"), false);
  const custom = render({
    model: entry({ providerId: "my-gateway", providerLabel: "My Gateway" }, { cost }),
    metadataLoading: false,
  });
  assert.equal(custom.has("List price"), false);
});

test("a benchmark snapshot over 60 days old says so; a recent one does not", () => {
  const stale = new Date(Date.now() - 90 * DAY_MS).toISOString();
  const recent = new Date(Date.now() - 5 * DAY_MS).toISOString();
  const staleRow = render({ model: entry({}, { benchmark: benchmark(stale) }), metadataLoading: false }).get(
    "Benchmark as of",
  );
  assert.match(staleRow ?? "", / \(over 60 days old\)$/u);
  const recentRow = render({ model: entry({}, { benchmark: benchmark(recent) }), metadataLoading: false }).get(
    "Benchmark as of",
  );
  assert.ok(recentRow);
  assert.doesNotMatch(recentRow, /days old/u);
});

test("without measurements or a price the card has no speed or price rows", () => {
  const details = render({ model: entry(), pace: pace(0), metadataLoading: false });
  assert.equal(details.has("Your speed"), false);
  assert.equal(details.has("List price"), false);
});
