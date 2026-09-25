import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceFromScrollBottom,
  isAtScrollBottom,
  pinOverflowListToEnd,
  shouldFollowScrollBottom,
} from "./scroll-follow.js";

test("distance from the trailing edge is the unconsumed overflow", () => {
  assert.equal(distanceFromScrollBottom(1200, 400, 800), 0);
  assert.equal(distanceFromScrollBottom(1200, 400, 0), 800);
});

test("follow latch stays on within the idle slop and off once the reader leaves it", () => {
  assert.equal(isAtScrollBottom(0), true);
  assert.equal(isAtScrollBottom(23), true);
  assert.equal(isAtScrollBottom(24), false);
  assert.equal(shouldFollowScrollBottom(true, true), true);
  assert.equal(shouldFollowScrollBottom(true, false), false);
  assert.equal(shouldFollowScrollBottom(false, true), false);
});

test("opening a long task list pins to the latest rows", () => {
  const list = { scrollHeight: 840, scrollTop: 0 };
  pinOverflowListToEnd(list);
  assert.equal(list.scrollTop, 840);
  pinOverflowListToEnd(null);
});
