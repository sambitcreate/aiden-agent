import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { positionSavedModels, type ModelEntry } from "../lib/model-picker-data";
import type { AppSettings, Provider } from "../lib/types";
import { ModelPickerPad } from "./model-picker-pad";
import { ModelPadSettings } from "./settings/model-pad/model-pad-settings";

afterEach(cleanup);

function entry(value: string): ModelEntry {
  return {
    value,
    providerId: "test",
    model: value,
    label: value,
    format: null,
    providerLabel: "Test",
    isLocal: false,
  };
}

function renderPad(selectedValue?: string, previewValue?: string) {
  const models = positionSavedModels([entry("mine"), entry("assisted"), entry("half")], {
    mine: { x: 0.2, y: 0.8, xSource: "user", ySource: "user" },
    assisted: { x: 0.5, y: 0.3, xSource: "neutral", ySource: "benchmark" },
    half: { x: 0.8, y: 0.5, xSource: "user", ySource: "benchmark" },
  });
  render(
    <ModelPickerPad
      models={models}
      gridSize={7}
      selectedValue={selectedValue}
      previewValue={previewValue}
      onPreview={() => {}}
      onCommit={() => {}}
    />,
  );
}

function option(name: string): HTMLElement {
  return screen.getByRole("option", { name: new RegExp(`^${name},`, "u") });
}

test("picker options use the settings placement-source vocabulary", () => {
  renderPad();
  assert.equal(option("mine").dataset.placementSource, "personal");
  assert.equal(option("assisted").dataset.placementSource, "benchmark");
  // One data-assisted axis is enough to make the placement benchmark-assisted.
  assert.equal(option("half").dataset.placementSource, "benchmark");
});

test("picker options announce placement source in the settings wording", () => {
  renderPad();
  assert.match(option("mine").getAttribute("aria-label") ?? "", /Placed by you$/u);
  assert.match(option("assisted").getAttribute("aria-label") ?? "", /Benchmark-assisted$/u);
});

test("measured pace is announced as measured, not as a benchmark, and still drawn as data-assisted", () => {
  const models = positionSavedModels([entry("paced"), entry("both")], {
    paced: { x: 0, y: 0.5, xSource: "measured", ySource: "user" },
    both: { x: 1, y: 1, xSource: "measured", ySource: "benchmark" },
  });
  render(
    <ModelPickerPad models={models} gridSize={7} onPreview={() => {}} onCommit={() => {}} />,
  );
  assert.match(option("paced").getAttribute("aria-label") ?? "", /, Measured pace$/u);
  assert.match(
    option("both").getAttribute("aria-label") ?? "",
    /, Benchmark height, measured pace$/u,
  );
  assert.equal(option("paced").dataset.placementSource, "benchmark");
  assert.equal(option("both").dataset.placementSource, "benchmark");
});

test("selected and previewed options keep their source and expose a separate state", () => {
  renderPad("mine", "assisted");
  const selected = option("mine");
  const previewed = option("assisted");
  const resting = option("half");
  assert.equal(selected.getAttribute("aria-selected"), "true");
  assert.equal(selected.dataset.placementSource, "personal");
  assert.equal(selected.dataset.state, "selected");
  assert.equal(previewed.dataset.placementSource, "benchmark");
  assert.equal(previewed.dataset.state, "preview");
  assert.equal(resting.dataset.state, "resting");
});

/** Grid dots are aria-hidden spans; return the positions of those sharing a marker's spot. */
function gridDotsUnder(container: HTMLElement, marker: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-grid-cell]")]
    .filter((dot) => dot.style.left === marker.style.left && dot.style.top === marker.style.top)
    .map((dot) => `${dot.style.left} ${dot.style.top}`);
}

test("the picker draws no grid dot inside an occupied marker", () => {
  renderPad();
  const pad = screen.getByRole("listbox");
  const options = screen.getAllByRole("option");
  for (const option of options) assert.deepEqual(gridDotsUnder(pad, option), []);
  // Every other cell keeps its dot.
  assert.equal(pad.querySelectorAll("[data-grid-cell]").length, 7 * 7 - options.length);
});

test("the settings editor draws no grid node inside an occupied marker", async () => {
  const provider: Provider = {
    id: "test",
    label: "Test",
    kind: "openai",
    baseUrl: "https://example.test/v1",
    models: ["mine", "assisted"],
    needsKey: false,
    hasKey: true,
  };
  const settings = {
    modelPadPlacements: {
      "test::mine": { x: 0, y: 1, xSource: "user", ySource: "user" },
      "test::assisted": { x: 0.5, y: 0.5, xSource: "neutral", ySource: "benchmark" },
    },
    pinnedModels: [],
  } as unknown as AppSettings;
  installBotTestIpc({
    "providers:list": () => [provider],
    "models:info": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "settings:get": () => structuredClone(settings),
  });
  const { container } = render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadSettings />
    </QueryClientProvider>,
  );
  const pad = await waitFor(() => {
    const group = screen.getByRole("group", { name: "Personal Model Pad arrangement" });
    assert.equal(group.querySelectorAll("[data-placement-source]").length, 2);
    return group;
  });
  const markers = [...pad.querySelectorAll<HTMLElement>("[data-placement-source]")];
  assert.deepEqual(
    markers.map((marker) => [
      marker.dataset.placementSource,
      /Placed by you|Benchmark-assisted/u.exec(marker.getAttribute("aria-label") ?? "")?.[0],
    ]),
    [
      ["personal", "Placed by you"],
      ["benchmark", "Benchmark-assisted"],
    ],
  );
  for (const marker of markers) assert.deepEqual(gridDotsUnder(container, marker), []);
  // The tray's glyph for each model speaks the same marker language.
  const tray = screen.getByRole("complementary", { name: "On your Pad" });
  assert.deepEqual(
    [...tray.querySelectorAll<HTMLElement>("li[data-value]")].map((row) => [
      row.dataset.value,
      row.querySelector<HTMLElement>("[data-placement-source]")?.dataset.placementSource,
    ]),
    [
      ["test::mine", "personal"],
      ["test::assisted", "benchmark"],
    ],
  );
  const gridSize = Number(pad.dataset.gridSize);
  assert.equal(
    pad.querySelectorAll("[data-grid-cell]").length,
    gridSize * gridSize - markers.length,
  );
});
