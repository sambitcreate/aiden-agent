import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelEntry } from "../lib/model-picker-data";
import type { ModelInfo } from "../lib/types";
import { ModelHoverDetails } from "./model-list-panel";

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

test("the detail card shows the list price as plain text", () => {
  const details = render({
    model: entry({}, { cost: { input: 3, output: 15, cacheRead: 0.3 } }),
    metadataLoading: false,
  });
  assert.equal(details.get("List price"), "$3 / $15 per 1M");
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

test("the card shows models.dev facts and no score or measured-speed rows", () => {
  const details = render({
    model: entry({}, { contextLength: 200_000, knowledge: "2025-03", releaseDate: "2025-05-01" }),
    metadataLoading: false,
  });
  assert.equal(details.get("Context"), "200K");
  assert.equal(details.get("Knowledge"), "2025-03");
  assert.equal(details.get("Released"), "2025-05-01");
  for (const retired of ["Your speed", "Intelligence", "Coding", "Agentic", "Benchmark as of"]) {
    assert.equal(details.has(retired), false, retired);
  }
});

test("without a price the card has no price row", () => {
  const details = render({ model: entry(), metadataLoading: false });
  assert.equal(details.has("List price"), false);
});
