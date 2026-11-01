import assert from "node:assert/strict";
import test from "node:test";
import { widenWindowForDesign, widenedBounds, type DesignWindow } from "./design-window-core.js";

const DISPLAY = { x: 0, y: 0, width: 1440, height: 900 };

test("a narrow window widens to 1280 and moves left only as far as the work area needs", () => {
  const next = widenedBounds({ x: 100, y: 40, width: 800, height: 700 }, DISPLAY);
  assert.ok(next);
  assert.equal(next.width, 1280);
  assert.ok(next.x <= 100 && next.x >= DISPLAY.x, "the left edge stays on the display");
  assert.ok(next.x + next.width <= DISPLAY.x + DISPLAY.width, "the right edge fits the work area");
  assert.deepEqual([next.y, next.height], [40, 700], "the height and top are unchanged");

  const nearRight = widenedBounds({ x: 600, y: 0, width: 800, height: 700 }, DISPLAY);
  assert.equal(nearRight?.x, 160, "a window near the right edge slides left to fit");
});

test("a small display gives its whole width, and one that cannot hold 840 px gives nothing", () => {
  assert.deepEqual(
    widenedBounds({ x: 100, y: 0, width: 800, height: 700 }, { x: 0, y: 0, width: 1024, height: 768 }),
    { x: 0, y: 0, width: 1024, height: 700 },
  );
  assert.equal(widenedBounds({ x: 0, y: 0, width: 700, height: 600 }, { x: 0, y: 0, width: 800, height: 600 }), null);
  // A second display to the left of the primary one has negative coordinates.
  assert.deepEqual(
    widenedBounds({ x: -900, y: 0, width: 800, height: 600 }, { x: -1024, y: 0, width: 1024, height: 768 }),
    { x: -1024, y: 0, width: 1024, height: 600 },
  );
});

function fakeWindow(bounds: { x: number; y: number; width: number; height: number }, options: { fullScreen?: boolean } = {}) {
  const calls: Array<typeof bounds> = [];
  const window: DesignWindow = {
    isDestroyed: () => false,
    isFullScreen: () => options.fullScreen === true,
    getBounds: () => bounds,
    setBounds: (next) => {
      calls.push(next);
      bounds = next;
    },
  };
  return { window, calls, current: () => bounds };
}

test("widening resizes the window on its display and reports whether it now fits", () => {
  const narrow = fakeWindow({ x: 100, y: 0, width: 800, height: 700 });
  assert.deepEqual(widenWindowForDesign(narrow.window, () => DISPLAY), { widened: true });
  assert.equal(narrow.current().width, 1280);

  const cramped = fakeWindow({ x: 0, y: 0, width: 700, height: 600 });
  assert.deepEqual(widenWindowForDesign(cramped.window, () => ({ x: 0, y: 0, width: 800, height: 600 })), { widened: false });
  assert.equal(cramped.calls.length, 0, "a window that cannot fit is left alone");

  const fullScreen = fakeWindow({ x: 0, y: 0, width: 800, height: 600 }, { fullScreen: true });
  assert.deepEqual(widenWindowForDesign(fullScreen.window, () => DISPLAY), { widened: false });
  assert.equal(fullScreen.calls.length, 0, "a full-screen window keeps its size");

  assert.deepEqual(widenWindowForDesign(null, () => DISPLAY), { widened: false });
});
