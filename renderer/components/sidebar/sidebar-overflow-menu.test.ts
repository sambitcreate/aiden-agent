import assert from "node:assert/strict";
import test from "node:test";
import { overflowMenuPlacement } from "./sidebar-overflow-menu.js";

// A 260px sidebar in an 800px-tall window; row triggers are 28px tall and end 20px inside the sidebar.
const VIEWPORT = 800;
const SIDEBAR = { right: 260 };
const trigger = (top: number) => ({ top, bottom: top + 28, right: 240 });

test("a menu opened in the top half grows downward from the trigger, just past the sidebar's edge", () => {
  assert.deepEqual(overflowMenuPlacement(trigger(100), SIDEBAR, VIEWPORT), {
    sideOffset: 28,
    align: "start",
    alignOffset: 0,
    // From the trigger's top to 8px above the window's bottom.
    maxHeight: 692,
  });
});

test("a menu opened in the bottom half grows upward from the trigger's bottom", () => {
  assert.deepEqual(overflowMenuPlacement(trigger(600), SIDEBAR, VIEWPORT), {
    sideOffset: 28,
    align: "end",
    alignOffset: 0,
    // From the trigger's bottom to 8px below the window's top.
    maxHeight: 620,
  });
});

test("a trigger scrolled partly above the window keeps the menu 8px inside it", () => {
  assert.deepEqual(overflowMenuPlacement(trigger(-10), SIDEBAR, VIEWPORT), {
    sideOffset: 28,
    align: "start",
    alignOffset: 18,
    maxHeight: 784,
  });
});

test("a trigger scrolled partly below the window keeps the menu 8px inside it", () => {
  assert.deepEqual(overflowMenuPlacement(trigger(790), SIDEBAR, VIEWPORT), {
    sideOffset: 28,
    align: "end",
    alignOffset: 26,
    maxHeight: 784,
  });
});

test("a trigger at the sidebar's edge still leaves an 8px gap, and a tiny window keeps a usable height", () => {
  assert.equal(overflowMenuPlacement({ top: 100, bottom: 128, right: 260 }, SIDEBAR, VIEWPORT).sideOffset, 8);
  assert.equal(overflowMenuPlacement({ top: 0, bottom: 28, right: 240 }, SIDEBAR, 10).maxHeight, 1);
});
