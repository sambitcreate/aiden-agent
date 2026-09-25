import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceFromScrollBottom,
  isAtScrollBottom,
  pinOverflowListToEnd,
  resolveProgrammaticFollowLatch,
  shouldFollowScrollBottom,
  shouldPinAfterContentGrowth,
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
  assert.equal(shouldPinAfterContentGrowth(true), true);
  assert.equal(shouldPinAfterContentGrowth(false), false);
});

test("programmatic jump keeps follow latched until the live edge is reached", () => {
  assert.deepEqual(resolveProgrammaticFollowLatch(true, false), { pending: true, followLatest: true });
  assert.deepEqual(resolveProgrammaticFollowLatch(true, true), { pending: false, followLatest: true });
  assert.deepEqual(resolveProgrammaticFollowLatch(false, false), { pending: false, followLatest: false });
  assert.equal(shouldPinAfterContentGrowth(resolveProgrammaticFollowLatch(true, false).followLatest), true);
});

test("opening a long task list pins to the latest rows", () => {
  const list = { scrollHeight: 840, scrollTop: 0 };
  pinOverflowListToEnd(list);
  assert.equal(list.scrollTop, 840);
  pinOverflowListToEnd(null);
});
