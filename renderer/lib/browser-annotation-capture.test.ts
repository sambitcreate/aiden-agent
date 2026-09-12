import assert from "node:assert/strict";
import test from "node:test";
import { browserAnnotationCropBounds, paintBrowserAnnotation } from "./browser-annotation-capture.js";
import type { BrowserAnnotation, BrowserElement, BrowserSnapshot } from "../shared/browser.js";

const snapshot = { tab: { viewport: { width: 390, height: 844 } } } as BrowserSnapshot;
const annotation: BrowserAnnotation = {
  url: "http://localhost/", comment: "Change this", elements: [{ bounds: { x: 10, y: 20, width: 60, height: 30 } } as BrowserElement],
  regions: [{ x: 160, y: 200, width: 40, height: 60 }], strokes: [[{ x: 80, y: 100 }, { x: 120, y: 140 }]],
  image: { mimeType: "image/png", data: "", width: 780, height: 1688 },
};

test("responsive annotation crop uses captured CSS viewport, never the host panel width", () => {
  assert.deepEqual(browserAnnotationCropBounds(annotation, snapshot), { x: 12, y: 32, width: 196, height: 236 });
  // The visible panel may be only 300px wide; the captured guest remains 390 CSS px.
  const fillSnapshot = { tab: { viewport: { width: 780, height: 1688 } } } as BrowserSnapshot;
  assert.deepEqual(browserAnnotationCropBounds({ ...annotation, regions: [], strokes: [] }, fillSnapshot), { x: 2, y: 12, width: 76, height: 46 });
});

test("export paints element labels, region boxes and drawings in original image coordinates", () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const methods = ["save", "restore", "translate", "strokeRect", "beginPath", "moveTo", "lineTo", "stroke", "fillText", "strokeText"] as const;
  const context = Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => { calls.push({ method, args }); }])) as unknown as Parameters<typeof paintBrowserAnnotation>[0];
  paintBrowserAnnotation(context, annotation, snapshot, { x: 12, y: 32, width: 196, height: 236 }, { foreground: "black", background: "white" });
  assert.deepEqual(calls.find((call) => call.method === "translate")?.args, [-12, -32]);
  assert.deepEqual(calls.filter((call) => call.method === "strokeRect").map((call) => call.args), [[20, 40, 120, 60], [20, 40, 120, 60], [160, 200, 40, 60], [160, 200, 40, 60]]);
  assert.deepEqual(calls.find((call) => call.method === "fillText")?.args, ["1", 24, 56]);
  assert.deepEqual(calls.filter((call) => call.method === "moveTo").map((call) => call.args), [[80, 100], [80, 100]]);
  assert.deepEqual(calls.filter((call) => call.method === "lineTo").map((call) => call.args), [[120, 140], [120, 140]]);
  assert.equal(calls[calls.length - 1].method, "restore");
});

test("image-less annotations remain useful and do not allocate a canvas", () => {
  const imageLess = { ...annotation, image: undefined };
  assert.equal(browserAnnotationCropBounds(imageLess, snapshot), null);
  paintBrowserAnnotation({} as Parameters<typeof paintBrowserAnnotation>[0], imageLess, snapshot, { x: 0, y: 0, width: 1, height: 1 }, { foreground: "black", background: "white" });
});

test("annotation coordinates follow the cropped page image at fractional scales", () => {
  // A portrait page in a wide native slot is cropped at capture time: the image
  // is 263 × 570, rather than the full 550 × 570 slot with its empty right side.
  const captured = { ...annotation, elements: [{ bounds: { x: 100, y: 200, width: 100, height: 100 } } as BrowserElement], regions: [], strokes: [], image: { ...annotation.image!, width: 263, height: 570 } };
  const crop = browserAnnotationCropBounds(captured, snapshot)!;
  assert.equal(crop.x, Math.floor(100 * 263 / 390 - 8));
  assert.equal(crop.y, Math.floor(200 * 570 / 844 - 8));
  assert.equal(crop.width, Math.ceil(200 * 263 / 390 + 8) - crop.x);
  assert.equal(crop.height, Math.ceil(300 * 570 / 844 + 8) - crop.y);
});
