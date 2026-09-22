import assert from "node:assert/strict";
import test from "node:test";
import { acceptBrowserState, BROWSER_DEVICE_PRESETS, browserAnnotationRegion, browserBoundsFromRect, browserElementAtPoint, enqueueBrowserPresentation, resizeBrowserViewport, savedBrowserScreenshotPath, validBrowserViewport } from "./browser-ui-state.js";
import type { BrowserElement, BrowserState } from "../shared/browser.js";
import { browserAnnotationCropBounds } from "./browser-annotation-capture.js";

test("browser updates reject another workspace and an older revision", () => {
  const current = { workspaceId: "a", revision: 5 } as BrowserState;
  assert.equal(acceptBrowserState(current, { workspaceId: "b", revision: 8 } as BrowserState, "a"), current);
  assert.equal(acceptBrowserState(current, { workspaceId: "a", revision: 4 } as BrowserState, "a"), current);
  const next = { workspaceId: "a", revision: 6 } as BrowserState;
  assert.equal(acceptBrowserState(current, next, "a"), next);
});

test("device dimensions have bounded area and lock ratio without accepting invalid edits", () => {
  assert.equal(BROWSER_DEVICE_PRESETS.length, 17);
  for (const [, width, height] of BROWSER_DEVICE_PRESETS) assert.ok(validBrowserViewport(width, height));
  assert.equal(validBrowserViewport(3840, 3840), false);
  assert.equal(validBrowserViewport(239, 240), false);
  assert.equal(validBrowserViewport(Infinity, 720), false);
  const viewport = { mode: "responsive" as const, width: 800, height: 600, ratioLocked: true };
  assert.deepEqual(resizeBrowserViewport(viewport, 1200, 600), { ...viewport, width: 1200, height: 900 });
  assert.deepEqual(resizeBrowserViewport(viewport, 800, 900, "height"), { ...viewport, width: 1200, height: 900 });
  assert.equal(resizeBrowserViewport(viewport, 200, 600), null);
});

test("annotations normalize reverse drags and pick the smallest enclosing element", () => {
  assert.deepEqual(browserAnnotationRegion({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 60 });
  const outer = { ref: "outer", bounds: { x: 0, y: 0, width: 100, height: 100 } } as BrowserElement;
  const inner = { ref: "inner", bounds: { x: 5, y: 5, width: 20, height: 20 } } as BrowserElement;
  assert.equal(browserElementAtPoint([outer, inner], { x: 10, y: 10 }), inner);
  assert.equal(browserElementAtPoint([outer, inner], { x: 110, y: 110 }), null);
});

test("native presentation never receives empty or nonfinite geometry", () => {
  assert.equal(browserBoundsFromRect({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(browserBoundsFromRect({ x: NaN, y: 0, width: 10, height: 10 }), null);
  assert.deepEqual(browserBoundsFromRect({ x: 12.4, y: 40.6, width: 345.7, height: 299.2 }), { x: 12, y: 41, width: 346, height: 299 });
});

test("an old view's delayed hide cannot overtake its replacement's show", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const old = enqueueBrowserPresentation("owner:tab", async () => { calls.push("old-show"); await blocked; });
  const hide = enqueueBrowserPresentation("owner:tab", async () => { calls.push("old-hide"); });
  const next = enqueueBrowserPresentation("owner:tab", async () => { calls.push("new-show"); });
  await Promise.resolve(); release(); await Promise.all([old, hide, next]);
  assert.deepEqual(calls, ["old-show", "old-hide", "new-show"]);
  await assert.rejects(enqueueBrowserPresentation("owner:tab", async () => { throw new Error("gone"); }));
  await enqueueBrowserPresentation("owner:tab", async () => { calls.push("retry"); });
  assert.equal(calls[calls.length - 1], "retry");
});

test("annotation crops combine scaled DOM bounds with drawn regions and clamp to captured frame", () => {
  const snapshot = { tab: { viewport: { width: 500, height: 400 } } } as import("../shared/browser.js").BrowserSnapshot;
  const annotation = { url: "http://localhost", comment: "", image: { data: "", mimeType: "image/png" as const, width: 1000, height: 800 }, elements: [{ bounds: { x: 10, y: 20, width: 30, height: 40 } } as BrowserElement], regions: [{ x: 200, y: 300, width: 40, height: 30 }], strokes: [] };
  assert.deepEqual(browserAnnotationCropBounds(annotation, snapshot), { x: 12, y: 32, width: 236, height: 306 });
  assert.deepEqual(browserAnnotationCropBounds({ ...annotation, elements: [], regions: [{ x: -10, y: -20, width: 1040, height: 850 }] }, snapshot), { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(browserAnnotationCropBounds({ ...annotation, image: undefined }, snapshot), null);
});

test("canceling a screenshot Save dialog is not reported as a saved file", () => {
  const state = { workspaceId: "workspace", revision: 1 } as BrowserState;
  assert.equal(savedBrowserScreenshotPath(null), null);
  assert.equal(savedBrowserScreenshotPath({ state }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: "" } }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: "   " } }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: 42 } }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: "/tmp/browser-screenshot.png" } }), "/tmp/browser-screenshot.png");
});
