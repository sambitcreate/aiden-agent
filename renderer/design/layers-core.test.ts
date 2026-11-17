// The side panel's layer list and reordering in it.

import assert from "node:assert/strict";
import test from "node:test";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import { nodesFromCanvas } from "./canvas-adapter-core";
import { bringLayerToFront, designLayers, reorderLayer, sendLayerToBack, stepLayer, type DesignLayer } from "./layers-core";

function frame(id: string, overrides: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, x: 0, y: 0, w: 200, h: 120, text: "", pageId: "page-1", createdBy: "person", ...overrides };
}

function canvas(...frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), frames };
}

const outline = (layers: DesignLayer[]): unknown[] =>
  layers.map((layer) => (layer.children.length > 0 ? [layer.frame.id, outline(layer.children)] : layer.frame.id));
/** What the canvas draws, front-most first: the order the list must show. */
const onScreen = (doc: DesignCanvas) => nodesFromCanvas(doc, new Set()).map((node) => node.id).reverse();

const page = canvas(
  frame("a", { groupId: "board" }),
  frame("board", { kind: "frame" }),
  frame("loose"),
  frame("b", { groupId: "board" }),
  frame("group", { kind: "group" }),
  frame("elsewhere", { pageId: "page-2" }),
);

test("the list is the page's frames front-most first, with an artboard's items under it", () => {
  assert.deepEqual(outline(designLayers(page)), ["loose", "group", ["board", ["b", "a"]]]);
  // Of any two siblings in the list, the one listed first is the one the canvas draws in front.
  const drawn = onScreen(page);
  const check = (layers: DesignLayer[]) => {
    for (let index = 1; index < layers.length; index += 1) {
      assert.ok(drawn.indexOf(layers[index - 1]!.frame.id) < drawn.indexOf(layers[index]!.frame.id));
    }
    for (const layer of layers) check(layer.children);
  };
  check(designLayers(page));
});

test("dragging a layer above another brings it in front, and below sends it behind", () => {
  const front = reorderLayer(page, "a", "b", "above");
  assert.deepEqual(outline(designLayers(front)).slice(-1)[0], ["board", ["a", "b"]]);
  assert.ok(onScreen(front).indexOf("a") < onScreen(front).indexOf("b"));
  const back = reorderLayer(front, "a", "b", "below");
  assert.deepEqual(outline(designLayers(back)).slice(-1)[0], ["board", ["b", "a"]]);
});

test("only siblings trade places: an item never moves into another artboard or behind a container", () => {
  assert.equal(reorderLayer(page, "loose", "a", "above"), page);
  assert.equal(reorderLayer(page, "loose", "group", "below"), page);
  assert.equal(reorderLayer(page, "a", "a", "above"), page);
  assert.equal(reorderLayer(page, "missing", "a", "above"), page);
});

test("one step forward or back trades with the next sibling, and stops at the ends", () => {
  const forward = stepLayer(page, "a", "forward");
  assert.deepEqual(outline(designLayers(forward)).slice(-1)[0], ["board", ["a", "b"]]);
  assert.equal(stepLayer(forward, "a", "forward"), forward);
  assert.equal(stepLayer(page, "loose", "forward"), page);
  assert.deepEqual(outline(designLayers(stepLayer(page, "board", "forward"))).slice(1), [["board", ["b", "a"]], "group"]);
});

test("bringing a layer to the front or back moves it past all its siblings, and only them", () => {
  const front = bringLayerToFront(page, "loose");
  assert.equal(front, page, "already in front of its siblings");
  const back = sendLayerToBack(page, "b");
  assert.deepEqual(outline(designLayers(back)).slice(-1)[0], ["board", ["a", "b"]]);
  const toFront = bringLayerToFront(back, "b");
  assert.deepEqual(outline(designLayers(toFront)).slice(-1)[0], ["board", ["b", "a"]]);
  // A frame on another page reorders among that page's frames.
  const other = canvas(frame("x", { pageId: "page-2" }), frame("y", { pageId: "page-2" }));
  assert.deepEqual(bringLayerToFront(other, "x").frames.map((entry) => entry.id), ["y", "x"]);
  assert.equal(sendLayerToBack(page, "missing"), page);
});
