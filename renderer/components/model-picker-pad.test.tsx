import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { positionSavedModels, type ModelEntry } from "../lib/model-picker-data";
import { ModelPickerPad } from "./model-picker-pad";

afterEach(cleanup);

function entry(value: string, label: string, providerLabel: string): ModelEntry {
  return {
    value,
    providerId: "test",
    model: value,
    label,
    format: null,
    providerLabel,
    isLocal: false,
  };
}

const models = positionSavedModels(
  [
    entry("middle", "Middle Model", "Acme Cloud"),
    entry("east", "East Model", "Eastern AI"),
    entry("north", "North Model", "Northern Labs"),
    entry("southwest", "Southwest Model", "Corner Co"),
  ],
  {
    middle: { x: 0.5, y: 0.5, xSource: "user", ySource: "user" },
    east: { x: 1, y: 0.5, xSource: "user", ySource: "user" },
    north: { x: 0.5, y: 1, xSource: "user", ySource: "user" },
    southwest: { x: 0, y: 0, xSource: "user", ySource: "user" },
  },
);

function knobTag(container: HTMLElement): HTMLElement {
  const tag = container.querySelector<HTMLElement>("[data-model-pad-knob-tag]");
  assert.ok(tag, "the knob tag is rendered");
  return tag;
}

function ControlledPad({ selectedValue }: { selectedValue?: string }) {
  const [previewValue, setPreviewValue] = React.useState<string>();
  return (
    <ModelPickerPad
      models={models}
      gridSize={7}
      selectedValue={selectedValue}
      previewValue={previewValue}
      onPreview={setPreviewValue}
      onCommit={() => {}}
    />
  );
}

test("the knob tag names the previewed model and its provider", () => {
  const { container } = render(
    <ModelPickerPad
      models={models}
      gridSize={7}
      selectedValue="middle"
      previewValue="southwest"
      onPreview={() => {}}
      onCommit={() => {}}
    />,
  );
  const tag = knobTag(container);
  assert.match(tag.textContent ?? "", /Southwest Model/u);
  assert.match(tag.textContent ?? "", /Corner Co/u);
  assert.doesNotMatch(tag.textContent ?? "", /Middle Model/u);
  // The listbox already announces the active option; the tag is visual only.
  assert.equal(tag.getAttribute("aria-hidden"), "true");
});

test("the knob tag rests on the selected model and follows arrow-key preview", () => {
  const { container } = render(<ControlledPad selectedValue="middle" />);
  assert.match(knobTag(container).textContent ?? "", /Middle Model.*Acme Cloud/u);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowRight" });
  assert.match(knobTag(container).textContent ?? "", /East Model.*Eastern AI/u);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  assert.match(knobTag(container).textContent ?? "", /Middle Model/u);
});

test("the knob tag stays inside the Pad near its edges", () => {
  const cases: Array<[string, string, string]> = [
    ["middle", "center", "top"],
    ["east", "end", "top"],
    ["north", "center", "bottom"],
    ["southwest", "start", "top"],
  ];
  for (const [value, align, side] of cases) {
    const { container, unmount } = render(
      <ModelPickerPad
        models={models}
        gridSize={7}
        selectedValue={value}
        onPreview={() => {}}
        onCommit={() => {}}
      />,
    );
    const tag = knobTag(container);
    assert.equal(tag.dataset.labelAlign, align, `${value} alignment`);
    assert.equal(tag.dataset.labelSide, side, `${value} side`);
    unmount();
  }
});
