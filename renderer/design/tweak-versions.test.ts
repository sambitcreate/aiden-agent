// Show all: one copy of a page frame per Tweaks version, side by side in a new group.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_CANVAS_LIMITS,
  DESIGN_FIRST_PAGE_ID,
  emptyDesignCanvas,
  parseDesignCanvas,
  type DesignCanvas,
  type DesignFrame,
} from "../shared/design-canvas/schema";
import {
  DESIGN_TWEAK_V1,
  designTweakVersionPicture,
  showDesignTweakVersions,
  takeDesignTweakVersionPicture,
} from "./tweak-versions";

function page(overrides: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id: "page",
    kind: "file",
    title: "Picker",
    path: "design/picker.html",
    x: 100,
    y: 200,
    w: 390,
    h: 800,
    designWidth: 390,
    pageId: DESIGN_FIRST_PAGE_ID,
    createdBy: "aiden",
    tweaks: { "--accent": "#ff0055" },
    tweakVersions: [
      { id: "v-2", name: "V2", tweaks: { "data-density": "compact" } },
      { id: "v-3", name: "Night", dark: true },
    ],
    ...overrides,
  };
}

function canvas(...frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), frames };
}

function counter() {
  let n = 0;
  return () => `new-${++n}`;
}

const inside = (outer: DesignFrame, inner: DesignFrame) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlap = (a: DesignFrame, b: DesignFrame) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("Show all lays out V1 and each saved version as its own page, in a group beside the original", () => {
  const original = page();
  const shown = showDesignTweakVersions(canvas(original), "page", counter());
  assert.ok(shown);
  const group = shown.doc.frames.find((frame) => frame.id === shown.groupId)!;
  const copies = shown.ids.map((id) => shown.doc.frames.find((frame) => frame.id === id)!);
  assert.equal(group.kind, "group");
  assert.deepEqual(
    copies.map((copy) => [copy.title, copy.tweaks, copy.dark]),
    [
      ["Picker · V1", undefined, undefined],
      ["Picker · V2", { "data-density": "compact" }, undefined],
      ["Picker · Night", undefined, true],
    ],
  );
  for (const copy of copies) {
    assert.equal(copy.path, original.path);
    assert.equal(copy.groupId, group.id);
    assert.equal(copy.tweakVersions, undefined, "a copy shows one version; it doesn't carry the list");
    assert.ok(inside(group, copy), `${copy.title} sits inside the group`);
    assert.ok(!overlap(copy, original), `${copy.title} doesn't cover the original`);
  }
  assert.ok(!overlap(group, original));
  assert.ok(!overlap(copies[0]!, copies[1]!) && !overlap(copies[1]!, copies[2]!));
  // The original keeps what it showed, and the result is a canvas the store accepts as is.
  assert.deepEqual(shown.doc.frames.find((frame) => frame.id === "page"), original);
  const parsed = parseDesignCanvas(shown.doc);
  assert.ok(parsed.ok);
  assert.equal(parsed.dropped, 0);
  assert.deepEqual(
    parsed.doc.frames.filter((frame) => frame.groupId === group.id).map((frame) => frame.id),
    shown.ids,
  );
});

test("many versions of a wide page wrap into rows that stay within a group's largest size", () => {
  const versions = Array.from({ length: 12 }, (_, index) => ({ id: `v-${index + 2}`, name: `V${index + 2}` }));
  const shown = showDesignTweakVersions(canvas(page({ w: 1440, h: 900, tweakVersions: versions })), "page", counter());
  assert.ok(shown);
  const group = shown.doc.frames.find((frame) => frame.id === shown.groupId)!;
  assert.ok(group.w <= DESIGN_CANVAS_LIMITS.maxSize && group.h <= DESIGN_CANVAS_LIMITS.maxSize);
  const copies = shown.doc.frames.filter((frame) => frame.groupId === group.id);
  assert.equal(copies.length, 13);
  for (const [index, copy] of copies.entries()) {
    assert.ok(inside(group, copy));
    for (const other of copies.slice(index + 1)) assert.ok(!overlap(copy, other), `${copy.title} and ${other.title} overlap`);
  }
});

test("Show all needs saved versions and room on the canvas", () => {
  assert.equal(showDesignTweakVersions(canvas(page({ tweakVersions: undefined })), "page", counter()), null);
  assert.equal(showDesignTweakVersions(canvas(page({ kind: "artifact" })), "page", counter()), null);
  assert.equal(showDesignTweakVersions(canvas(page()), "missing", counter()), null);
  const crowd = Array.from({ length: DESIGN_CANVAS_LIMITS.framesPerPage - 2 }, (_, index): DesignFrame => ({
    id: `note-${index}`,
    kind: "note",
    title: "Note",
    x: 0,
    y: 5000 + index * 10,
    w: 100,
    h: 100,
    pageId: DESIGN_FIRST_PAGE_ID,
    createdBy: "person",
  }));
  assert.equal(showDesignTweakVersions(canvas(page(), ...crowd), "page", counter()), null);
});

test("Show all steps past whatever already sits to the page's right, so nothing on the page is covered", () => {
  const original = page();
  const neighbour: DesignFrame = { ...page({ tweakVersions: undefined }), id: "neighbour", title: "Pricing", x: original.x + original.w + 64 };
  const note: DesignFrame = {
    id: "note",
    kind: "note",
    title: "Note",
    x: neighbour.x + neighbour.w + 40,
    y: 300,
    w: 240,
    h: 160,
    pageId: DESIGN_FIRST_PAGE_ID,
    createdBy: "person",
  };
  const shown = showDesignTweakVersions(canvas(original, neighbour, note), "page", counter());
  assert.ok(shown);
  const group = shown.doc.frames.find((frame) => frame.id === shown.groupId)!;
  for (const other of [original, neighbour, note]) assert.ok(!overlap(group, other), `the group covers ${other.title}`);
  for (const id of shown.ids) {
    const copy = shown.doc.frames.find((frame) => frame.id === id)!;
    assert.ok(inside(group, copy));
  }
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a version's picture checks the canvas's frame as it is when taken, whoever asked for it", async () => {
  // The canvas's frame, read fresh each time; no editor is involved after the ask.
  let current: DesignFrame | undefined = page({ id: "shot-a", tweaks: { "data-density": "compact" } });
  const frameNow = () => current;
  let resolveShot: (picture: string) => void = () => undefined;
  let shots = 0;
  const capture = () => {
    shots += 1;
    return new Promise<string | null>((resolve) => (resolveShot = resolve));
  };

  // The panel asked for V2's picture, then closed; the page moved on to another value before it was taken.
  takeDesignTweakVersionPicture("shot-a", "v-2", 20, frameNow, capture);
  current = { ...current, tweaks: { "data-density": "roomy" } };
  await settle(40);
  assert.equal(shots, 0, "no picture of a look that isn't V2");

  // Back on V2: the picture is started, and while it is taken the page switches to Night.
  current = { ...current, tweaks: { "data-density": "compact" } };
  takeDesignTweakVersionPicture("shot-a", "v-2", 0, frameNow, capture);
  await settle(10);
  assert.equal(shots, 1);
  current = { ...current, tweaks: undefined, dark: true };
  resolveShot("data:image/png;base64,TkIHVA==");
  await settle(10);
  assert.equal(designTweakVersionPicture("shot-a", "v-2"), undefined, "Night's look isn't filed under V2");

  // V2 deleted while its picture is taken: nothing is kept for it.
  current = { ...current, dark: undefined, tweaks: { "data-density": "compact" } };
  takeDesignTweakVersionPicture("shot-a", "v-2", 0, frameNow, capture);
  await settle(10);
  current = { ...current, tweakVersions: current.tweakVersions?.filter((version) => version.id !== "v-2") };
  resolveShot("data:image/png;base64,VjI=");
  await settle(10);
  assert.equal(designTweakVersionPicture("shot-a", "v-2"), undefined);

  // The frame left the canvas: nothing is taken.
  current = undefined;
  takeDesignTweakVersionPicture("shot-a", DESIGN_TWEAK_V1, 0, frameNow, capture);
  await settle(10);
  assert.equal(shots, 2, "no picture once the frame is gone");

  // Left alone on V1, it gets its picture.
  current = page({ id: "shot-a", tweaks: undefined });
  takeDesignTweakVersionPicture("shot-a", DESIGN_TWEAK_V1, 0, frameNow, capture);
  await settle(10);
  resolveShot("data:image/png;base64,VjE=");
  await settle(10);
  assert.equal(designTweakVersionPicture("shot-a", DESIGN_TWEAK_V1), "data:image/png;base64,VjE=");
});
