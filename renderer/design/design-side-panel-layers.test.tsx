// The side panel's Layers list: reordering by keyboard and by pointer.
import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import { DesignSidePanel } from "./design-side-panel";
import type { DesignTweakOps } from "./design-tweaks-panel";
import { reorderLayer, stepLayer } from "./layers-core";

const restoreRect = window.HTMLElement.prototype.getBoundingClientRect;
afterEach(() => {
  cleanup();
  window.HTMLElement.prototype.getBoundingClientRect = restoreRect;
});

function note(id: string): DesignFrame {
  const page = emptyDesignCanvas().activePageId;
  return { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: id, pageId: page, createdBy: "person" };
}

/** Layers never reaches the Tweaks tab, so its operations are unused. */
const noTweaks = new Proxy({}, { get: () => () => false }) as DesignTweakOps;

function Harness({ initial, changes }: { initial: DesignCanvas; changes: string[] }) {
  const select = (ids: string[]) => changes.push(`select ${ids.join(" ")}`);
  const [doc, setDoc] = React.useState(initial);
  return (
    <DesignSidePanel
      doc={doc}
      selection={new Set()}
      tab="layers"
      tweaks={noTweaks}
      onTab={() => {}}
      onClose={() => {}}
      readSource={async () => ({ error: "unavailable" })}
      versionOf={() => 0}
      onSelect={select}
      update={() => {}}
      moveTo={() => {}}
      resizeTo={() => {}}
      reorder={(id, target, place) => {
        changes.push(`${id} ${place} ${target}`);
        setDoc((current) => reorderLayer(current, id, target, place));
      }}
      step={(id, direction) => {
        changes.push(`${id} ${direction}`);
        setDoc((current) => stepLayer(current, id, direction));
      }}
    />
  );
}

/** The canvas draws Back first, so the list shows Front, Middle, Back. */
function renderLayers() {
  const changes: string[] = [];
  render(<Harness initial={{ ...emptyDesignCanvas(), frames: [note("Back"), note("Middle"), note("Front")] }} changes={changes} />);
  return changes;
}

const rows = () =>
  within(screen.getByRole("list", { name: "Layers" }))
    .getAllByRole("button", { name: /^Move / })
    .map((grip) => grip.getAttribute("aria-label")!.slice(5));

test("a layer's grip picks it up, moves it in a draft and drops it as one reorder", () => {
  const changes = renderLayers();
  assert.deepEqual(rows(), ["Front", "Middle", "Back"]);
  const grip = () => screen.getByRole("button", { name: "Move Front" });
  act(() => grip().focus());
  fireEvent.keyDown(grip(), { key: " " });
  assert.equal(screen.getByRole("status").textContent, "Picked up Front, position 1 of 3.");
  fireEvent.keyDown(grip(), { key: "ArrowDown" });
  fireEvent.keyDown(grip(), { key: "ArrowDown" });
  assert.deepEqual(rows(), ["Middle", "Back", "Front"]);
  assert.equal(document.activeElement, grip(), "focus follows the moved row's grip");
  assert.deepEqual(changes, [], "the canvas is untouched until the drop");
  fireEvent.keyDown(grip(), { key: "Enter" });
  assert.deepEqual(changes, ["Front below Back"]);
  assert.deepEqual(rows(), ["Middle", "Back", "Front"]);
  assert.equal(document.activeElement, grip());
  assert.equal(screen.getByRole("status").textContent, "Dropped Front at position 3 of 3.");
});

test("Escape puts a held layer back and keeps focus on its grip", () => {
  const changes = renderLayers();
  const grip = () => screen.getByRole("button", { name: "Move Back" });
  act(() => grip().focus());
  fireEvent.keyDown(grip(), { key: "Enter" });
  fireEvent.keyDown(grip(), { key: "Home" });
  assert.deepEqual(rows(), ["Back", "Front", "Middle"]);
  fireEvent.keyDown(grip(), { key: "Escape" });
  assert.deepEqual(rows(), ["Front", "Middle", "Back"]);
  assert.deepEqual(changes, []);
  assert.equal(document.activeElement, grip());
  assert.equal(screen.getByRole("status").textContent, "Moved Back back to position 3 of 3.");
});

test("Option-arrow on a layer's name still steps it at once", () => {
  const changes = renderLayers();
  fireEvent.keyDown(screen.getByRole("button", { name: "Middle" }), { key: "ArrowUp", altKey: true });
  assert.deepEqual(changes, ["Middle forward"]);
  assert.deepEqual(rows(), ["Middle", "Front", "Back"]);
});

/** Rows 32px tall from the top of the list, in list order. */
function stubRowRects() {
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.dataset.layerId;
    const index = id ? rows().indexOf(id) : -1;
    const top = index * 32;
    return { top, bottom: top + 32, height: 32, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
}

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!;
const flushFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));

test("a pointer drag starts past 3px, shows where it lands, and commits once on release", async () => {
  const changes = renderLayers();
  stubRowRects();
  fireEvent.pointerDown(rowOf("Front"), { button: 0, pointerId: 1, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 12, buttons: 1 });
  await flushFrame();
  assert.equal(rowOf("Front").hasAttribute("data-dragging"), false, "under the threshold it is still a click");
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 90, buttons: 1 });
  await flushFrame();
  assert.equal(rowOf("Front").hasAttribute("data-dragging"), true);
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 90 });
  assert.deepEqual(changes, ["Front below Back"]);
  assert.deepEqual(rows(), ["Middle", "Back", "Front"]);
  assert.equal(rowOf("Front").hasAttribute("data-dragging"), false);
});

test("Escape cancels a pointer drag without reordering", async () => {
  const changes = renderLayers();
  stubRowRects();
  fireEvent.pointerDown(rowOf("Back"), { button: 0, pointerId: 2, clientY: 80 });
  fireEvent.pointerMove(window, { pointerId: 2, clientY: 4, buttons: 1 });
  await flushFrame();
  assert.equal(rowOf("Back").hasAttribute("data-dragging"), true);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(window, { pointerId: 2, clientY: 4 });
  assert.deepEqual(changes, []);
  assert.deepEqual(rows(), ["Front", "Middle", "Back"]);
  assert.equal(rowOf("Back").hasAttribute("data-dragging"), false);
});

test("the click that follows an Escape-cancelled drag does not select the row", async () => {
  const changes = renderLayers();
  stubRowRects();
  const name = screen.getByRole("button", { name: "Back" });
  fireEvent.pointerDown(name, { button: 0, pointerId: 3, clientY: 80 });
  fireEvent.pointerMove(window, { pointerId: 3, clientY: 4, buttons: 1 });
  await flushFrame();
  fireEvent.keyDown(window, { key: "Escape" });
  // The person lets go a moment later.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  fireEvent.pointerUp(window, { pointerId: 3, clientY: 4 });
  fireEvent.click(name);
  assert.deepEqual(changes, []);
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  fireEvent.click(name);
  assert.deepEqual(changes, ["select Back"], "a later click selects as usual");
});

test("hovering the dragged row itself shows no landing spot and drops nowhere", async () => {
  const changes = renderLayers();
  stubRowRects();
  fireEvent.pointerDown(rowOf("Middle"), { button: 0, pointerId: 4, clientY: 40 });
  fireEvent.pointerMove(window, { pointerId: 4, clientY: 50, buttons: 1 });
  await flushFrame();
  assert.equal(rowOf("Middle").hasAttribute("data-dragging"), true);
  assert.equal(document.querySelectorAll("[data-layer-id] > span[aria-hidden]").length, 0);
  fireEvent.pointerUp(window, { pointerId: 4, clientY: 50 });
  assert.deepEqual(changes, []);
});
