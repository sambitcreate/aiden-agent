// Download names and PDF layout for design frames, and the order Present walks a page in.

import assert from "node:assert/strict";
import test from "node:test";
import {
  designExportFileName,
  designExportFormats,
  designExportWidth,
  designPdfLayout,
} from "./frame-export";
import { presentationOrder } from "./presentation";
import type { DesignFrame } from "./schema";

const box = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<DesignFrame> = {}) =>
  ({ id, kind: "file", x, y, w, h, ...extra }) as DesignFrame;

test("pages and artifacts save as a picture, a PDF or the original; images only as themselves", () => {
  assert.deepEqual(designExportFormats({ kind: "file" }), ["png", "pdf", "source"]);
  assert.deepEqual(designExportFormats({ kind: "artifact" }), ["png", "pdf", "source"]);
  assert.deepEqual(designExportFormats({ kind: "image" }), ["source"]);
  for (const kind of ["note", "text", "shape", "group", "frame", "connector", "stroke"] as const) {
    assert.deepEqual(designExportFormats({ kind }), [], kind);
  }
});

test("a download is named after the frame, safely, and the original keeps its own name", () => {
  const page = { kind: "file" as const, title: "Checkout: step 2 / mobile", path: "site/checkout v2.html" };
  assert.equal(designExportFileName(page, "png"), "Checkout-step-2-mobile.png");
  assert.equal(designExportFileName(page, "pdf"), "Checkout-step-2-mobile.pdf");
  assert.equal(designExportFileName(page, "source"), "checkout v2.html");
  assert.equal(designExportFileName({ kind: "file", title: "index.html" }, "png"), "index.png");
  assert.equal(designExportFileName({ kind: "artifact", title: "../../etc" }, "source"), "etc.html");
  assert.equal(designExportFileName({ kind: "artifact", title: "???" }, "pdf"), "design.pdf");
  assert.equal(designExportFileName({ kind: "artifact", title: "Ünïcode café" }, "png"), "Ünïcode-café.png");
});

test("a page exports at its design width; an artifact at its box width within sensible bounds", () => {
  assert.equal(designExportWidth({ kind: "file", designWidth: 390, w: 300 }), 390);
  assert.equal(designExportWidth({ kind: "file", w: 300 }), 1280);
  assert.equal(designExportWidth({ kind: "artifact", w: 612.4 }), 612);
  assert.equal(designExportWidth({ kind: "artifact", w: 90 }), 320);
  assert.equal(designExportWidth({ kind: "artifact", w: 5000 }), 1440);
});

test("flow prints at full size; fixed scales the design width to the paper's printable width", () => {
  assert.deepEqual(designPdfLayout({ width: 1280 }), { paper: "letter", pageSize: "Letter", marginInches: 0.4, scale: 1 });
  const letter = designPdfLayout({ width: 1280, printMode: "fixed" });
  const a4 = designPdfLayout({ width: 1280, printMode: "fixed", paper: "a4" });
  assert.equal(a4.pageSize, "A4");
  // Letter is 8.5 in wide and A4 8.27 in: with 0.4 in margins, 739 and 717 CSS px of room.
  assert.ok(Math.abs(letter.scale * 1280 - 739.2) < 1);
  assert.ok(Math.abs(a4.scale * 1280 - 717.1) < 1);
  // A narrow design is scaled up, never more than twice.
  assert.equal(designPdfLayout({ width: 300, printMode: "fixed" }).scale, 2);
});

test("Present reads a page row by row from the top, left to right, and skips lines and grouped items", () => {
  const frames = [
    box("right-top", 600, 0, 400, 300),
    box("left-top", 0, 40, 400, 200),
    box("below", 0, 400),
    box("below-right", 300, 380),
    box("arrow", 50, 50, 300, 5, { kind: "connector" }),
    box("in-group", 10, 10, 50, 50, { groupId: "left-top" }),
  ];
  assert.deepEqual(presentationOrder(frames), ["left-top", "right-top", "below", "below-right"]);
  assert.deepEqual(presentationOrder([]), []);
});

test("a tall frame beside short ones is one row, and a frame below the row's middle starts the next", () => {
  const frames = [box("tall", 0, 0, 100, 1000), box("short", 200, 100, 100, 100), box("later", 400, 600, 100, 100)];
  assert.deepEqual(presentationOrder(frames), ["tall", "short", "later"]);
  // `later` starts below the tall row's middle (500), so it starts a row of its own;
  // `left-later` starts above that row's middle (650), so it joins it, on the left.
  assert.deepEqual(presentationOrder([...frames, box("left-later", -100, 620)]), ["tall", "short", "left-later", "later"]);
});
