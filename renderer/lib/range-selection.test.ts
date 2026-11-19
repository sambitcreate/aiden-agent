import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_SELECTION,
  extendSelection,
  idsBetween,
  retainSelection,
  toggleSelection,
} from "./range-selection";

const ORDER = ["a", "b", "c", "d", "e", "f"];

test("idsBetween runs either way and is empty for an id not in the list", () => {
  assert.deepEqual(idsBetween(ORDER, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(idsBetween(ORDER, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(idsBetween(ORDER, "c", "c"), ["c"]);
  assert.deepEqual(idsBetween(ORDER, "x", "c"), []);
});

test("a toggle adds or removes one row and moves the anchor to it", () => {
  const one = toggleSelection(EMPTY_SELECTION, "b");
  assert.deepEqual(one.ids, ["b"]);
  const two = toggleSelection(one, "e");
  assert.deepEqual(two.ids, ["b", "e"]);
  const back = toggleSelection(two, "b");
  assert.deepEqual(back.ids, ["e"]);
  assert.equal(back.anchor?.id, "b");
});

test("a second Shift range from the same anchor replaces the first range, not the base", () => {
  // ⌘-click a, then ⌘-click c: c is the anchor and {a, c} the base.
  const base = toggleSelection(toggleSelection(EMPTY_SELECTION, "a"), "c");
  const down = extendSelection(base, ORDER, "e");
  assert.deepEqual(down.ids, ["a", "c", "d", "e"]);
  // Shrinking the range back toward the anchor drops d and e again, keeping a.
  const shrink = extendSelection(down, ORDER, "d");
  assert.deepEqual(shrink.ids, ["a", "c", "d"]);
  // Crossing over the anchor selects the other side instead.
  const up = extendSelection(shrink, ORDER, "b");
  assert.deepEqual(up.ids, ["a", "c", "b"]);
});

test("with no anchor the range starts from the fallback, adding to what is selected", () => {
  assert.deepEqual(extendSelection(EMPTY_SELECTION, ORDER, "d", "b").ids, ["b", "c", "d"]);
  // A fallback that is not listed starts the range at the target itself.
  assert.deepEqual(extendSelection(EMPTY_SELECTION, ORDER, "d", "gone").ids, ["d"]);
  // An anchor whose row has left the list is replaced by the fallback.
  const stale = { ids: ["f"], anchor: { id: "gone", base: ["f"] } };
  assert.deepEqual(extendSelection(stale, ORDER, "b", "a").ids, ["f", "a", "b"]);
});

test("retaining keeps the same object when every id is still listed", () => {
  const selection = toggleSelection(toggleSelection(EMPTY_SELECTION, "a"), "b");
  assert.equal(retainSelection(selection, new Set(ORDER)), selection);
});

test("retaining drops ids that left the list, and the anchor with its row", () => {
  const selection = extendSelection(toggleSelection(EMPTY_SELECTION, "b"), ORDER, "d");
  const kept = retainSelection(selection, new Set(["a", "b", "d"]));
  assert.deepEqual(kept.ids, ["b", "d"]);
  assert.equal(kept.anchor?.id, "b");
  const anchorGone = retainSelection(selection, new Set(["c", "d"]));
  assert.deepEqual(anchorGone.ids, ["c", "d"]);
  assert.equal(anchorGone.anchor, null);
  assert.equal(retainSelection(selection, new Set()), EMPTY_SELECTION);
});
