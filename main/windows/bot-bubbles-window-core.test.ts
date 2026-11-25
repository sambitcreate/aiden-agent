import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_BOT_BUBBLE_STATE, type BotBubbleState } from "../../renderer/shared/bot-bubbles.js";
import {
  PendingTransitions,
  TRANSITION_STALE_MS,
  allowOverlayRebuild,
  isZoomShortcut,
  overlayCssSize,
  scaleRect,
  botBubbleOverlayWindowOptions,
  bubbleDisplayId,
  captureRect,
  displaysNeedingOverlay,
  growTargetRect,
  overlayIgnoresMouse,
  windowRectToOverlay,
} from "./bot-bubbles-window-core.js";

const displays = [
  { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
  { id: 2, workArea: { x: 1440, y: -200, width: 1920, height: 1080 } },
];

const state = (placements: Array<number | null>, host: BotBubbleState["host"] = "overlay"): BotBubbleState => ({
  ...EMPTY_BOT_BUBBLE_STATE,
  host,
  bubbles: placements.map((displayId, index) => ({ botId: `b${index}`, placement: { side: "right", y: 0.2, displayId } })),
});

test("the overlay page is isolated, can't take focus from other apps, and covers its display's work area", () => {
  const options = botBubbleOverlayWindowOptions({ preload: "/p.cjs", workArea: displays[1]!.workArea });
  // Security: a sandboxed, context-isolated page with no Node.
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  // Heads never take keyboard focus from the app the person is in.
  assert.equal(options.focusable, false);
  // Click-through needs a see-through window over exactly the work area.
  assert.equal(options.transparent, true);
  assert.deepEqual(
    { x: options.x, y: options.y, width: options.width, height: options.height },
    { x: 1440, y: -200, width: 1920, height: 1080 },
  );
});

test("only displays with heads get an overlay, and only while the host is the overlay", () => {
  assert.deepEqual([...displaysNeedingOverlay(state([2, 2]), displays, 1)], [2]);
  assert.deepEqual([...displaysNeedingOverlay(state([null, 2]), displays, 1)].sort(), [1, 2]);
  assert.deepEqual([...displaysNeedingOverlay(state([9]), displays, 1)], [1], "a missing display falls back to the primary");
  assert.equal(displaysNeedingOverlay(state([]), displays, 1).size, 0);
  assert.equal(displaysNeedingOverlay(state([1], "window"), displays, 1).size, 0);
  assert.equal(displaysNeedingOverlay(state([1], "off"), displays, 1).size, 0);
  assert.equal(bubbleDisplayId(9, displays, 1), 1);
  assert.equal(bubbleDisplayId(2, displays, 1), 2);
});

test("a rect in the main window maps into the overlay's own pixels", () => {
  const content = { x: 1500, y: 0, width: 1200, height: 800 };
  assert.deepEqual(windowRectToOverlay({ x: 300, y: 50, width: 600, height: 700 }, content, displays[1]!.workArea), {
    x: 360,
    y: 250,
    width: 600,
    height: 700,
  });
  assert.deepEqual(windowRectToOverlay({ x: 10, y: 10, width: 100, height: 100 }, content, displays[1]!.workArea, 1.25), {
    x: 72.5,
    y: 212.5,
    width: 125,
    height: 125,
  });
  assert.deepEqual(growTargetRect(content, displays[0]!.workArea), { x: 1500, y: -25, width: 1200, height: 800 });
});

test("the capture rect is clamped to the window and empty rects capture nothing", () => {
  assert.deepEqual(captureRect({ x: -10, y: 20.4, width: 500, height: 5000 }, { width: 400, height: 600 }), {
    x: 0,
    y: 20,
    width: 400,
    height: 580,
  });
  assert.equal(captureRect({ x: 500, y: 0, width: 10, height: 10 }, { width: 400, height: 600 }), null);
});

test("clicks pass through unless the pointer is over Aiden or a head is dragging", () => {
  assert.equal(overlayIgnoresMouse({ interactive: false, dragging: false }), true);
  assert.equal(overlayIgnoresMouse({ interactive: true, dragging: false }), false);
  assert.equal(overlayIgnoresMouse({ interactive: false, dragging: true }), false);
});

test("a crashing overlay is rebuilt a few times a minute, then left off", () => {
  let times: number[] = [];
  const results: boolean[] = [];
  for (const now of [0, 1_000, 2_000, 3_000]) {
    const next = allowOverlayRebuild(times, now);
    times = next.times;
    results.push(next.allowed);
  }
  assert.deepEqual(results, [true, true, true, false]);
  assert.equal(allowOverlayRebuild(times, 61_000).allowed, true, "a minute later it may try again");
});

test("transitions wait for the page to listen, and stale ones are dropped", () => {
  const pending = new PendingTransitions<string>();
  assert.equal(pending.offer("old", 0), null);
  assert.equal(pending.offer("shrink", TRANSITION_STALE_MS), null);
  assert.deepEqual(pending.markReady(TRANSITION_STALE_MS + 10), ["shrink"]);
  assert.equal(pending.offer("grow", 5_000), "grow", "once listening, sent at once");
  pending.reset();
  assert.equal(pending.offer("after reload", 6_000), null);
  assert.deepEqual(pending.markReady(6_100), ["after reload"]);
});

test("overlay sizes and rects are reported in the page's CSS pixels", () => {
  assert.deepEqual(overlayCssSize({ x: 0, y: 25, width: 1440, height: 875 }, 1.25), { width: 1152, height: 700 });
  assert.deepEqual(scaleRect({ x: 10, y: 20, width: 100, height: 50 }, 2), { x: 5, y: 10, width: 50, height: 25 });
  assert.deepEqual(overlayCssSize({ x: 0, y: 0, width: 100, height: 100 }, 0), { width: 100, height: 100 });
});

test("zoom shortcuts are recognised, typing is not", () => {
  const key = (k: string, meta = true) => ({ type: "keyDown", key: k, meta, control: false });
  assert.equal(isZoomShortcut(key("=")), true);
  assert.equal(isZoomShortcut(key("-")), true);
  assert.equal(isZoomShortcut(key("0")), true);
  assert.equal(isZoomShortcut(key("=", false)), false);
  assert.equal(isZoomShortcut(key("a")), false);
});
