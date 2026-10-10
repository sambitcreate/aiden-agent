import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import {
  modelOptionId,
  modelSiblings,
  positionSavedModels,
  type ModelEntry,
} from "../lib/model-picker-data";
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

test("the knob tag says which other providers also serve the previewed model", () => {
  const direct: ModelEntry = { ...entry("openai::gpt-4o", "GPT-4o", "OpenAI"), model: "gpt-4o" };
  const routed: ModelEntry = {
    ...entry("openrouter::openai/gpt-4o", "GPT-4o", "OpenRouter"),
    providerId: "openrouter",
    model: "openai/gpt-4o",
  };
  const loner = entry("solo", "Solo Model", "Acme Cloud");
  const linked = positionSavedModels([direct, routed, loner], {
    [direct.value]: { x: 0.2, y: 0.5, xSource: "user", ySource: "user" },
    [routed.value]: { x: 0.8, y: 0.5, xSource: "user", ySource: "user" },
    [loner.value]: { x: 0.5, y: 0.2, xSource: "user", ySource: "user" },
  });
  const siblingsByValue = modelSiblings([direct, routed, loner]);
  const renderPreview = (previewValue: string) =>
    render(
      <ModelPickerPad
        models={linked}
        gridSize={7}
        previewValue={previewValue}
        siblingsByValue={siblingsByValue}
        onPreview={() => {}}
        onCommit={() => {}}
      />,
    );

  const first = renderPreview(direct.value);
  assert.match(knobTag(first.container).textContent ?? "", /Also via OpenRouter/u);
  first.unmount();
  const second = renderPreview(routed.value);
  assert.match(knobTag(second.container).textContent ?? "", /Also via OpenAI/u);
  second.unmount();
  const third = renderPreview(loner.value);
  assert.doesNotMatch(knobTag(third.container).textContent ?? "", /Also via/u);
});

test("the knob tag rests on the selected model and follows arrow-key preview", () => {
  const { container } = render(<ControlledPad selectedValue="middle" />);
  assert.match(knobTag(container).textContent ?? "", /Middle Model.*Acme Cloud/u);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowRight" });
  assert.match(knobTag(container).textContent ?? "", /East Model.*Eastern AI/u);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  assert.match(knobTag(container).textContent ?? "", /Middle Model/u);
});

/** happy-dom has no layout; give the Pad and the tag measured sizes for one test. */
function withMeasuredSizes(padSize: number, tagHeight: number, run: () => void) {
  const proto = HTMLElement.prototype;
  const originals = (["clientWidth", "clientHeight", "offsetHeight"] as const).map(
    (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
  );
  const padSide = function (this: HTMLElement) {
    return this.getAttribute("role") === "listbox" ? padSize : 0;
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: padSide });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: padSide });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-model-pad-knob-tag") ? tagHeight : 0;
    },
  });
  try {
    run();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  }
}

function renderSelected(value: string, padModels = models) {
  return render(
    <ModelPickerPad
      models={padModels}
      gridSize={7}
      selectedValue={value}
      onPreview={() => {}}
      onCommit={() => {}}
    />,
  );
}

test("the knob tag hugs the Pad's left and right edges and flips below at the top", () => {
  withMeasuredSizes(300, 38, () => {
    const cases: Array<[string, string, string]> = [
      ["middle", "center", "top"],
      ["east", "end", "top"],
      ["north", "center", "bottom"],
      ["southwest", "start", "top"],
    ];
    for (const [value, align, side] of cases) {
      const { container, unmount } = renderSelected(value);
      const tag = knobTag(container);
      assert.equal(tag.dataset.labelAlign, align, `${value} alignment`);
      assert.equal(tag.dataset.labelSide, side, `${value} side`);
      assert.notEqual(tag.style.visibility, "hidden", `${value} is shown once measured`);
      unmount();
    }
  });
});

test("on a short Pad the knob tag drops below a model that a tall Pad labels above", () => {
  const upper = positionSavedModels([entry("upper", "Upper Model", "Acme Cloud")], {
    upper: { x: 0.5, y: 0.75, xSource: "user", ySource: "user" },
  });
  withMeasuredSizes(300, 38, () => {
    const { container, unmount } = renderSelected("upper", upper);
    assert.equal(knobTag(container).dataset.labelSide, "top");
    unmount();
  });
  withMeasuredSizes(160, 38, () => {
    const { container, unmount } = renderSelected("upper", upper);
    assert.equal(knobTag(container).dataset.labelSide, "bottom");
    unmount();
  });
});

test("an unplaced current model leaves the Pad without an active option, knob or tag", () => {
  const commits: string[] = [];
  const { container } = render(
    <ModelPickerPad
      models={models}
      gridSize={7}
      selectedValue="elsewhere"
      previewValue="elsewhere"
      onPreview={() => {}}
      onCommit={(model) => commits.push(model.value)}
    />,
  );
  const listbox = screen.getByRole("listbox");
  assert.equal(listbox.getAttribute("aria-activedescendant"), null);
  for (const option of screen.getAllByRole("option")) {
    assert.equal(option.getAttribute("aria-selected"), "false");
    assert.equal(option.dataset.state, "resting");
  }
  assert.equal(container.querySelector("[data-model-pad-knob-tag]"), null);
  assert.equal(container.querySelector(".model-pad-knob"), null);

  fireEvent.keyDown(listbox, { key: "Enter" });
  fireEvent.keyDown(listbox, { key: " " });
  assert.deepEqual(commits, []);
});

test("the first arrow press on an unplaced current model starts at the model nearest the center", () => {
  // The center model is listed last so "the first Pad model" would be a different one.
  const centerLast = positionSavedModels(
    [
      entry("southwest", "Southwest Model", "Corner Co"),
      entry("north", "North Model", "Northern Labs"),
      entry("middle", "Middle Model", "Acme Cloud"),
    ],
    {
      southwest: { x: 0, y: 0, xSource: "user", ySource: "user" },
      north: { x: 0.5, y: 1, xSource: "user", ySource: "user" },
      middle: { x: 0.45, y: 0.55, xSource: "user", ySource: "user" },
    },
  );
  for (const key of ["ArrowUp", "ArrowLeft"]) {
    const previews: Array<string | undefined> = [];
    const { unmount } = render(
      <ModelPickerPad
        models={centerLast}
        gridSize={7}
        selectedValue="elsewhere"
        onPreview={(value) => previews.push(value)}
        onCommit={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole("listbox"), { key });
    assert.deepEqual(previews, ["middle"], `${key} starts at the center model`);
    unmount();
  }
});

test("leaving the Pad after previewing returns to no active model when the current one is unplaced", () => {
  const { container } = render(<ControlledPad selectedValue="elsewhere" />);
  const listbox = screen.getByRole("listbox");
  fireEvent.keyDown(listbox, { key: "ArrowRight" });
  assert.equal(listbox.getAttribute("aria-activedescendant"), modelOptionId("middle"));
  assert.ok(container.querySelector(".model-pad-knob"));

  fireEvent.pointerLeave(listbox);

  assert.equal(listbox.getAttribute("aria-activedescendant"), null);
  assert.equal(container.querySelector(".model-pad-knob"), null);
  assert.equal(container.querySelector("[data-model-pad-knob-tag]"), null);
});

test("the Pad captions its axes without exposing them to assistive tech", () => {
  const { container } = renderSelected("middle");
  const listbox = screen.getByRole("listbox");
  for (const caption of ["More capable", "Faster", "More deliberate"]) {
    const element = Array.from(container.querySelectorAll<HTMLElement>("*")).find(
      (node) => node.textContent === caption && node.children.length === 0,
    );
    assert.ok(element, `${caption} is shown on the Pad`);
    assert.ok(listbox.contains(element), `${caption} sits inside the Pad`);
    assert.ok(element.closest('[aria-hidden="true"]'), `${caption} is hidden from assistive tech`);
  }
});

/** Pixel position on a 300px Pad for a normalized model point. */
function padPixel(point: { x: number; y: number }) {
  const size = 300;
  return {
    clientX: (0.08 + point.x * 0.84) * size,
    clientY: (0.08 + (1 - point.y) * 0.84) * size,
  };
}

function renderPointerPad(onCommit: (value: string) => void) {
  const previews: Array<string | undefined> = [];
  render(
    <ModelPickerPad
      models={models}
      gridSize={7}
      selectedValue="middle"
      onPreview={(value) => previews.push(value)}
      onCommit={(model) => onCommit(model.value)}
    />,
  );
  const listbox = screen.getByRole("listbox");
  listbox.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300 }) as DOMRect;
  listbox.setPointerCapture = () => {};
  listbox.hasPointerCapture = () => false;
  return { listbox, previews };
}

test("a pointer release far from every model commits nothing", () => {
  const commits: string[] = [];
  const { listbox, previews } = renderPointerPad((value) => commits.push(value));
  // The top-left corner is empty: the nearest model is more than 0.4 away.
  const empty = padPixel({ x: 0.05, y: 0.95 });
  fireEvent.pointerDown(listbox, { button: 0, pointerId: 1, ...empty });
  fireEvent.pointerUp(listbox, { button: 0, pointerId: 1, ...empty });
  assert.deepEqual(commits, []);
  assert.deepEqual(previews, [], "the preview stays where it was");

  // Previewing a model and then letting go in the empty corner chooses nothing either.
  fireEvent.pointerDown(listbox, { button: 0, pointerId: 2, ...padPixel({ x: 0.5, y: 0.97 }) });
  fireEvent.pointerUp(listbox, { button: 0, pointerId: 2, ...empty });
  assert.deepEqual(previews, ["north"]);
  assert.deepEqual(commits, []);
});

test("a pointer release near a model commits it", () => {
  const commits: string[] = [];
  const { listbox, previews } = renderPointerPad((value) => commits.push(value));
  fireEvent.pointerDown(listbox, { button: 0, pointerId: 1, ...padPixel({ x: 0.55, y: 0.93 }) });
  assert.deepEqual(previews, ["north"]);
  fireEvent.pointerUp(listbox, { button: 0, pointerId: 1, ...padPixel({ x: 0.55, y: 0.93 }) });
  assert.deepEqual(commits, ["north"]);
});
