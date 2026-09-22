import assert from "node:assert/strict";
import test from "node:test";
import { browserAnnotationDimensionStyles, browserAnnotationElementBounds, browserAnnotationStylePreview, eraseBrowserAnnotationAtPoint } from "./browser-annotation-editing.js";
import type { BrowserAnnotation, BrowserElement, BrowserSnapshot } from "../shared/browser.js";

const element = { ref: "one", selector: "#one", bounds: { x: 10, y: 10, width: 30, height: 30 } } as BrowserElement;
const snapshot = { tab: { viewport: { width: 100, height: 200 } }, image: { width: 200, height: 300 } } as BrowserSnapshot;
const marks: Pick<BrowserAnnotation, "elements" | "regions" | "strokes"> = { elements: [element, { ...element, ref: "two" }], regions: [{ x: 20, y: 15, width: 60, height: 45 }], strokes: [[{ x: 20, y: 15 }, { x: 80, y: 60 }]] };

test("selected element bounds use both captured image scales", () => {
  assert.deepEqual(browserAnnotationElementBounds(element, snapshot), { x: 20, y: 15, width: 60, height: 45 });
});

test("eraser removes the topmost element, then regions and strokes without disturbing other marks", () => {
  const first = eraseBrowserAnnotationAtPoint(marks, { x: 30, y: 30 }, snapshot);
  assert.deepEqual(first.elements.map((value) => value.ref), ["one"]);
  assert.equal(first.regions, marks.regions); assert.equal(first.strokes, marks.strokes);
  const second = eraseBrowserAnnotationAtPoint(first, { x: 30, y: 30 }, snapshot);
  const third = eraseBrowserAnnotationAtPoint(second, { x: 30, y: 30 }, snapshot);
  assert.equal(third.regions.length, 0); assert.equal(third.strokes.length, 1);
  assert.equal(eraseBrowserAnnotationAtPoint(third, { x: 30, y: 30 }, snapshot).strokes.length, 0);
  assert.equal(eraseBrowserAnnotationAtPoint(marks, { x: 190, y: 250 }, snapshot), marks);
});

test("live style previews target each selected element and restore deselected targets", () => {
  const styles = { one: { color: "blue" }, two: { width: "90px" }, hidden: { opacity: "0" } };
  assert.deepEqual(browserAnnotationStylePreview([element], styles), [{ ref: "one", selector: "#one", styles: { color: "blue" } }]);
  assert.deepEqual(browserAnnotationStylePreview([], styles), []);
  assert.deepEqual(browserAnnotationStylePreview([element], {}), [{ ref: "one", selector: "#one", styles: {} }]);
});

test("locked element dimensions preserve ratio and reject incomplete numbers", () => {
  assert.deepEqual(browserAnnotationDimensionStyles("width", "180", 2), { width: "180px", height: "90px" });
  assert.deepEqual(browserAnnotationDimensionStyles("height", "75", 2), { height: "75px", width: "150px" });
  assert.deepEqual(browserAnnotationDimensionStyles("height", "75", null), { height: "75px" });
  for (const value of ["", "-1", "Infinity", "auto"]) assert.deepEqual(browserAnnotationDimensionStyles("width", value, 2), {});
});
