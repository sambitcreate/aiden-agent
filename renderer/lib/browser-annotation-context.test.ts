import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserAnnotation } from "../shared/browser";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_INLINE_BYTES } from "../shared/attachment-contract";
import { browserAnnotationAttachments, browserAnnotationContext } from "./browser-annotation-context";

const annotation: BrowserAnnotation = {
  url: "http://localhost:3000/settings", selectedText: "Save settings", comment: "Make this easier to find",
  elements: [{ ref: "e1", tag: "button", text: "Save settings", selector: "#save", bounds: { x: 10, y: 20, width: 100, height: 30 }, source: "Settings.tsx:42" }],
  regions: [], strokes: [], styleChanges: { color: "red" },
  image: { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", mimeType: "image/png", width: 1, height: 1 },
};

test("browser context retains selected text, selector, source and user-requested styling as untrusted evidence", () => {
  const context = browserAnnotationContext(annotation);
  assert.match(context, /untrusted reference material/);
  for (const value of ["Save settings", "#save", "Settings.tsx:42", "requestedStyleChanges"]) assert.ok(context.includes(value));
});

test("text-only models receive browser context without an unsupported image", () => {
  const result = browserAnnotationAttachments(annotation, [], false, "test");
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].kind, "text");
  assert.equal(result.imageSkipped, true);
});

test("style changes retain separate element targets and previous/current CSS values", () => {
  const context = browserAnnotationContext({ ...annotation, elementStyleChanges: [
    { ref: "1", selector: "#save", changes: { color: { previous: "black", current: "blue" } } },
    { ref: "2", selector: "#cancel", changes: { color: { previous: "black", current: "gray" } } },
  ] });
  for (const value of ["#save", "#cancel", '"previous": "black"', '"current": "blue"', '"current": "gray"']) assert.ok(context.includes(value));
});

test("browser attachments respect both remaining slots and inline byte limits", () => {
  const full = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) => ({ id: `${i}`, name: "file", kind: "text" as const, mimeType: "text/plain", text: "a", size: 1 }));
  assert.equal(browserAnnotationAttachments(annotation, full, true, "test").attachments.length, 0);
  const oneSlot = browserAnnotationAttachments(annotation, full.slice(1), true, "test");
  assert.equal(oneSlot.attachments.length, 1);
  assert.equal(oneSlot.attachments[0].kind, "text");
  assert.equal(oneSlot.imageSkipped, true);
  const large = [{ id: "full", name: "image", kind: "image" as const, mimeType: "image/png", size: MAX_ATTACHMENT_INLINE_BYTES }];
  assert.equal(browserAnnotationAttachments(annotation, large, true, "test").attachments.length, 0);
});

test("oversized page context is bounded before entering the composer", () => {
  const huge = { ...annotation, selectedText: "x".repeat(100_000), elements: Array.from({ length: 500 }, () => ({ ...annotation.elements[0], text: "y".repeat(100_000) })) };
  assert.ok(browserAnnotationContext(huge).length <= 48_000);
});
