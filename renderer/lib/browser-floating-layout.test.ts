import assert from "node:assert/strict";
import test from "node:test";
import { browserFloatingContentBounds, browserFloatingFrame, resizeBrowserFloatingFrame, type BrowserFloatingEdge } from "./browser-floating-layout.js";

const source = { width: 1280, height: 720 };
const container = { width: 780, height: 650 };
const chromeHeight = 114;

test("floating browser preserves source aspect ratio and anchors above chat", () => {
  assert.deepEqual(browserFloatingFrame({ source, container, chromeHeight }), { x: 448, y: 12, width: 320, height: 294 });
});

test("dragging clamps every edge to the chat column and window shrink fits saved size", () => {
  assert.deepEqual(browserFloatingFrame({ source, container, chromeHeight, width: 320, position: { x: -100, y: 9999 } }), { x: 12, y: 344, width: 320, height: 294 });
  const smaller = browserFloatingFrame({ source, container: { width: 220, height: 320 }, chromeHeight, width: 900, position: { x: 500, y: 400 } });
  assert.equal(smaller.width, 196); assert.equal(smaller.x, 12); assert.ok(smaller.y + smaller.height <= 308);
  // Resolving smaller bounds never changes the user's remembered preferred width.
  assert.equal(browserFloatingFrame({ source, container, chromeHeight, width: 900 }).width, 756);
});

test("all resize edges preserve opposite anchors, page ratio and container bounds", () => {
  const start = browserFloatingFrame({ source, container, chromeHeight, width: 320, position: { x: 230, y: 160 } });
  for (const edge of ["north", "south", "east", "west", "northwest", "northeast", "southwest", "southeast"] as BrowserFloatingEdge[]) {
    const next = resizeBrowserFloatingFrame({ start, source, container, chromeHeight, edge, delta: { x: edge.includes("west") ? -90 : 90, y: edge.includes("north") ? -70 : 70 } });
    assert.ok(next.x >= 12 && next.y >= 12, edge);
    assert.ok(next.x + next.width <= container.width - 12 && next.y + next.height <= container.height - 12, edge);
    assert.ok(Math.abs((next.height - chromeHeight) - next.width * source.height / source.width) < 1, edge);
    if (edge.includes("west")) assert.equal(next.x + next.width, start.x + start.width, edge);
    if (edge.includes("north")) assert.equal(next.y + next.height, start.y + start.height, edge);
  }
});

test("portrait pages and constrained windows never grow beyond their source", () => {
  const portrait = browserFloatingFrame({ source: { width: 390, height: 844 }, container, chromeHeight });
  assert.ok(portrait.height <= container.height - 24);
  assert.ok(portrait.width <= 390);
  const huge = browserFloatingFrame({ source: { width: 320, height: 180 }, container: { width: 2000, height: 2000 }, chromeHeight, width: 1000 });
  assert.equal(huge.width, 320);
});

test("floating over chat cannot cover the app toolbar or an overlaid Environment close button", () => {
  const content = browserFloatingContentBounds({ viewport: { x: 272, y: 0, width: 1008, height: 800 }, toolbar: { x: 272, y: 0, width: 1008, height: 52 }, sideSurfaces: [{ x: 708, y: 12, width: 560, height: 776 }] });
  assert.deepEqual(content, { x: 272, y: 52, width: 436, height: 748 });
  const player = browserFloatingFrame({ source, container: content, chromeHeight });
  assert.ok(content.x + player.x + player.width < 708);
  assert.ok(content.y + player.y > 52);
  // Dragging/resizing toward the sidebar still keeps the native page out of it.
  const dragged = browserFloatingFrame({ source, container: content, chromeHeight, position: { x: 9999, y: -1000 }, width: 9999 });
  assert.ok(content.x + dragged.x + dragged.width < 708);
  assert.ok(content.y + dragged.y > 52);
});

test("closing side surfaces expands usable chat bounds while terminal and composer stay excluded", () => {
  const viewport = { x: 272, y: 0, width: 1008, height: 600 };
  const toolbar = { x: 272, y: 0, width: 1008, height: 52 };
  const composer = { x: 350, y: 420, width: 700, height: 180 };
  const closed = browserFloatingContentBounds({ viewport, toolbar, composer });
  assert.deepEqual(closed, { x: 272, y: 52, width: 1008, height: 368 });
  const quickView = browserFloatingContentBounds({ viewport, toolbar, composer, sideSurfaces: [{ x: 960, y: 56, width: 300, height: 200 }] });
  assert.equal(quickView.width, 688);
  const pinned = browserFloatingContentBounds({ viewport: { ...viewport, width: 448 }, toolbar: { ...toolbar, width: 448 }, sideSurfaces: [{ x: 720, y: 0, width: 560, height: 800 }] });
  assert.equal(pinned.width, 448);
});

test("an empty chat composer reserves space before a tall page is fitted or resized", () => {
  const composer = { x: 400, y: 625, width: 800, height: 124 };
  const content = browserFloatingContentBounds({ viewport: { x: 272, y: 0, width: 1008, height: 780 }, toolbar: { x: 272, y: 0, width: 1008, height: 52 }, composer });
  const tallSource = { width: 560, height: 1200 };
  const player = browserFloatingFrame({ source: tallSource, container: content, chromeHeight });
  assert.ok(content.y + player.y + player.height <= composer.y - 12);
  const expanded = resizeBrowserFloatingFrame({ start: player, source: tallSource, container: content, chromeHeight, edge: "southeast", delta: { x: 1000, y: 1000 } });
  assert.ok(content.y + expanded.y + expanded.height <= composer.y - 12);
});
