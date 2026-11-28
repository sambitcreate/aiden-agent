// Variant sets of live app frames (design mode v2 Phase 3c, S93): where a
// variant goes, which set it joins, and what refuses it.

import assert from "node:assert/strict";
import test from "node:test";
import { placeAppVariant, variantRootOf, type AppVariantInput } from "./app-variants.js";
import { DESIGN_FRAME_GAP } from "./placement.js";
import { DESIGN_CANVAS_LIMITS, DESIGN_FIRST_PAGE_ID, emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

const PAGE = DESIGN_FIRST_PAGE_ID;

function appFrame(id: string, extra: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id,
    kind: "app",
    title: "/pricing",
    pageId: PAGE,
    x: 100,
    y: 200,
    w: 320,
    h: 236,
    createdBy: "aiden",
    appRoot: ".",
    route: "/pricing",
    viewport: { width: 1280, height: 800 },
    scale: 0.25,
    ...extra,
  };
}

function canvas(...frames: DesignFrame[]): DesignCanvas {
  return { ...emptyDesignCanvas(), revision: 1, frames };
}

function input(id: string, extra: Partial<AppVariantInput> = {}): AppVariantInput {
  return {
    id,
    groupId: `group-of-${id}`,
    title: "iPhone",
    route: "/pricing",
    viewport: { width: 390, height: 844 },
    scale: 0.25,
    label: "iPhone",
    createdBy: "person",
    ...extra,
  };
}

function placed(result: ReturnType<typeof placeAppVariant>): { doc: DesignCanvas; frameId: string } {
  assert.ok(!("error" in result), `expected a placement, got ${JSON.stringify(result)}`);
  return result;
}

test("a variant goes right of its set, in a new group titled with the route", () => {
  const original = appFrame("a");
  const { doc, frameId } = placed(placeAppVariant(canvas(original), original, input("v1")));
  const variant = doc.frames.find((frame) => frame.id === frameId)!;
  assert.equal(variant.x, original.x + original.w + DESIGN_FRAME_GAP);
  assert.equal(variant.y, original.y);
  assert.equal(variant.variantOf, "a");
  assert.equal(variant.createdBy, "person");
  assert.equal(variant.label, "iPhone");
  assert.deepEqual(variant.viewport, { width: 390, height: 844 });
  assert.deepEqual({ w: variant.w, h: variant.h }, { w: 98, h: 211 + 36 });
  const group = doc.frames.find((frame) => frame.id === "group-of-v1")!;
  assert.equal(group.kind, "group");
  assert.equal(group.title, "/pricing");
  assert.equal(doc.frames.find((frame) => frame.id === "a")!.groupId, group.id);
  assert.equal(variant.groupId, group.id);
  // The group holds both.
  for (const member of [original, variant]) {
    assert.ok(group.x <= member.x && member.x + member.w <= group.x + group.w);
    assert.ok(group.y <= member.y && member.y + member.h <= group.y + group.h);
  }
});

test("a second variant goes right of the first", () => {
  const original = appFrame("a");
  const first = placed(placeAppVariant(canvas(original), original, input("v1")));
  const root = first.doc.frames.find((frame) => frame.id === "a")!;
  const second = placed(placeAppVariant(first.doc, root, input("v2")));
  const v1 = second.doc.frames.find((frame) => frame.id === "v1")!;
  const v2 = second.doc.frames.find((frame) => frame.id === "v2")!;
  assert.equal(v2.x, v1.x + v1.w + DESIGN_FRAME_GAP);
  assert.equal(v2.groupId, v1.groupId, "it joins the set's group rather than making another");
  assert.equal(second.doc.frames.filter((frame) => frame.kind === "group").length, 1);
});

test("a variant of a variant joins the root's set", () => {
  const original = appFrame("a");
  const first = placed(placeAppVariant(canvas(original), original, input("v1")));
  const v1 = first.doc.frames.find((frame) => frame.id === "v1")!;
  const root = variantRootOf(first.doc, v1);
  assert.equal(root.id, "a");
  const second = placed(placeAppVariant(first.doc, root, input("v2")));
  assert.equal(second.doc.frames.find((frame) => frame.id === "v2")!.variantOf, "a");
});

test("a variant whose original is gone is its own root", () => {
  const orphan = appFrame("v1", { variantOf: "gone" });
  assert.equal(variantRootOf(canvas(orphan), orphan).id, "v1");
  // A variantOf naming a frame that isn't an app frame doesn't count either.
  const note: DesignFrame = { id: "n", kind: "note", title: "Note", pageId: PAGE, x: 0, y: 0, w: 240, h: 160, createdBy: "person" };
  const pointing = appFrame("v2", { variantOf: "n" });
  assert.equal(variantRootOf(canvas(note, pointing), pointing).id, "v2");
});

test("a locked original, a locked group and a full page are refused", () => {
  const locked = appFrame("a", { locked: true });
  const lockedDoc = canvas(locked);
  assert.deepEqual(placeAppVariant(lockedDoc, locked, input("v1")), { error: "locked" });

  const group: DesignFrame = { id: "g", kind: "group", title: "G", pageId: PAGE, x: 0, y: 0, w: 1000, h: 600, createdBy: "person", locked: true };
  const grouped = appFrame("a", { groupId: "g" });
  assert.deepEqual(placeAppVariant(canvas(group, grouped), grouped, input("v1")), { error: "locked-group" });

  const original = appFrame("a");
  const filler = Array.from({ length: DESIGN_CANVAS_LIMITS.framesPerPage - 1 }, (_, index) => ({
    ...appFrame(`f${index}`),
    x: index * 400,
    y: 2000,
  }));
  // One more frame fits on the page, but a variant and its new group need two.
  const full = canvas(original, ...filler);
  const before = structuredClone(full);
  assert.deepEqual(placeAppVariant(full, original, input("v1")), { error: "page-full" });
  assert.deepEqual(full, before, "the document is unchanged");
});
