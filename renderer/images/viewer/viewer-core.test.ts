import assert from "node:assert/strict";
import test from "node:test";
import type { GalleryItem } from "../../shared/images/ipc-types";
import type { ImageModelOption } from "../../shared/images/port";
import {
  actionOutcome,
  canZoom,
  clampPan,
  detailRows,
  filmstripWindow,
  fitScale,
  positionLabel,
  revealLabel,
  stepIndex,
  thrownOutcome,
  zoomAnchorPan,
} from "./viewer-core";

const item = (patch: Partial<GalleryItem> = {}): GalleryItem => ({
  assetId: "a".repeat(64), width: 1024, height: 768, mediaType: "image/png", runId: "r", runState: "succeeded", workflowId: "wf", nodeId: "g",
  variant: 0, index: 0, provider: "openrouter", model: "google/gemini-3.1-flash-image", createdAt: 1_700_000_000_000,
  saved: true, thumbUrl: "aiden-asset://thumb", ...patch,
});
const model: ImageModelOption = {
  provider: "openrouter", providerLabel: "OpenRouter", model: "google/gemini-3.1-flash-image", label: "Nano Banana 2",
  acceptsReferences: true, textOutput: false,
};

test("stepping stops at either end instead of wrapping, and the position counts from one", () => {
  assert.equal(stepIndex(0, -1, 5), 0);
  assert.equal(stepIndex(4, 1, 5), 4);
  assert.equal(stepIndex(2, 1, 5), 3);
  assert.equal(stepIndex(0, 1, 0), 0);
  assert.equal(positionLabel(2, 12), "3 of 12");
});

test("the filmstrip window holds the active image, centred except at the ends, and never runs past the list", () => {
  for (const count of [1, 5, 11, 12, 40]) {
    for (let index = 0; index < count; index += 1) {
      const { start, end } = filmstripWindow(index, count, 11);
      assert.ok(start <= index && index < end, `index ${index} of ${count} is inside [${start}, ${end})`);
      assert.ok(start >= 0 && end <= count);
      assert.equal(end - start, Math.min(11, count));
    }
  }
  const middle = filmstripWindow(20, 40, 11);
  assert.equal(20 - middle.start, middle.end - 1 - 20);
});

test("fit never upscales, and only an image larger than the stage can zoom to 100%", () => {
  assert.equal(fitScale({ width: 200, height: 100 }, { width: 800, height: 600 }), 1);
  assert.equal(canZoom({ width: 200, height: 100 }, { width: 800, height: 600 }), false);
  assert.equal(fitScale({ width: 1600, height: 600 }, { width: 800, height: 600 }), 0.5);
  assert.equal(canZoom({ width: 1600, height: 600 }, { width: 800, height: 600 }), true);
  // Before the stage is measured there is nothing to fit to.
  assert.equal(fitScale({ width: 1600, height: 600 }, { width: 0, height: 0 }), 1);
});

test("an actual-size pan keeps the image covering the stage on each axis it overhangs", () => {
  const natural = { width: 2000, height: 500 };
  const box = { width: 1000, height: 800 };
  assert.deepEqual(clampPan({ x: 900, y: 40 }, natural, box), { x: 500, y: 0 });
  assert.deepEqual(clampPan({ x: -900, y: 0 }, natural, box), { x: -500, y: 0 });
});

test("zooming in keeps the clicked spot of the image under the pointer", () => {
  const natural = { width: 4000, height: 3000 };
  const box = { width: 1000, height: 750 };
  const click = { x: 100, y: -50 };
  const scale = fitScale(natural, box);
  // The image pixel under the click at fit, measured from the image's centre.
  const pixel = { x: click.x / scale, y: click.y / scale };
  const pan = zoomAnchorPan(click, natural, box);
  assert.deepEqual({ x: pixel.x + pan.x, y: pixel.y + pan.y }, click);
  // At the right edge the image moves left only until its right edge meets the stage's.
  const edge = zoomAnchorPan({ x: 500, y: 0 }, natural, box);
  assert.equal(edge.x, -(natural.width - box.width) / 2);
});

test("details name the model and provider from the catalog and leave out what was not recorded", () => {
  const rows = detailRows(item({ workflowTitle: "Poster", nodeTitle: "Hero" }), [model], () => "Nov 14");
  assert.deepEqual(rows, [
    { label: "Model", value: "Nano Banana 2" },
    { label: "Provider", value: "OpenRouter" },
    { label: "Size", value: "1024 × 768" },
    { label: "Format", value: "PNG" },
    { label: "Created", value: "Nov 14" },
    { label: "Workflow", value: "Poster" },
    { label: "Node", value: "Hero" },
  ]);
  const bare = detailRows(item({ provider: "", model: "", createdAt: 0, mediaType: "image/webp" }), [], () => "never");
  assert.deepEqual(bare.map((row) => row.label), ["Size", "Format"]);
  // A model no longer in the catalog shows its id rather than nothing.
  assert.equal(detailRows(item({ model: "someone/retired" }), [model], String)[0]?.value, "someone/retired");
});

test("action outcomes: cancelled says nothing, failures read as plain sentences, saves and copies confirm", () => {
  assert.equal(actionOutcome("save-as", { ok: false, reason: "cancelled" }), null);
  assert.deepEqual(actionOutcome("save-as", { ok: true }), { kind: "success", text: "Image saved" });
  assert.deepEqual(actionOutcome("save-all", { ok: true, count: 4 }), { kind: "success", text: "Saved 4 images" });
  assert.deepEqual(actionOutcome("copy", { ok: true }), { kind: "success", text: "Image copied" });
  // Showing a saved file says nothing on success, and plainly when the session forgot it.
  assert.equal(actionOutcome("reveal-saved", { ok: true }), null);
  assert.deepEqual(actionOutcome("reveal-saved", { ok: false, reason: "not-found" }), { kind: "error", text: "Aiden no longer knows where that was saved." });
  assert.equal(actionOutcome("reveal", { ok: true }), null);
  assert.deepEqual(actionOutcome("copy", { ok: false, reason: "unsupported" }), {
    kind: "error", text: "Copying images isn't available on this computer.",
  });
  assert.deepEqual(actionOutcome("save-as", { ok: false, reason: "failed", message: "The disk is full." }), {
    kind: "error", text: "The disk is full.",
  });
  assert.deepEqual(actionOutcome("save-as", { ok: false, reason: "failed" }), { kind: "error", text: "Aiden couldn't save the image." });
  assert.equal(actionOutcome("reveal", { ok: false, reason: "not-found" })?.kind, "error");
  assert.equal(thrownOutcome("copy")?.kind, "error");
});

test("the file-manager action follows the platform's name for it", () => {
  assert.equal(revealLabel(true), "Show in Finder");
  assert.equal(revealLabel(false), "Show in folder");
});
