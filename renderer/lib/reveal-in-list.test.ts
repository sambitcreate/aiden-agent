import assert from "node:assert/strict";
import test from "node:test";
import { scrollToShow } from "./reveal-in-list";

test("a row already in view doesn't scroll the list", () => {
  assert.equal(scrollToShow(100, 300, 150, 40), 100);
});

test("a row above or below the view scrolls just enough, keeping the scroll padding clear", () => {
  // Above: its top lands at the padding.
  assert.equal(scrollToShow(100, 300, 60, 40, 8, 8), 52);
  // Below: its bottom lands above the padding.
  assert.equal(scrollToShow(100, 300, 380, 40, 8, 8), 128);
  // Never past the top.
  assert.equal(scrollToShow(100, 300, 4, 40, 8, 8), 0);
});
