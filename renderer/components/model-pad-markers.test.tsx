import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { positionSavedModels, type ModelEntry } from "../lib/model-picker-data";
import { ModelPickerPad } from "./model-picker-pad";
import { ModelPadLegend } from "./settings/model-pad-legend";

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

test("the settings legend shows one marker per placement source, with matching wording", () => {
  const { container } = render(<ModelPadLegend />);
  const markers = [...container.querySelectorAll<HTMLElement>("[data-placement-source]")];
  assert.deepEqual(
    markers.map((marker) => [marker.dataset.placementSource, marker.parentElement?.textContent]),
    [
      ["personal", "Placed by you"],
      ["benchmark", "Benchmark-assisted"],
    ],
  );
  for (const marker of markers) assert.equal(marker.getAttribute("aria-hidden"), "true");
  assert.match(container.textContent ?? "", /Hover, focus, or select a marker to see its model/u);
});
