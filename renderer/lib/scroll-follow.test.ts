import assert from "node:assert/strict";
import test from "node:test";
import {
  distanceFromScrollBottom,
  followIgnoresWheel,
  followNeedsSnap,
  followReducer,
  INITIAL_FOLLOW_STATE,
  isAtScrollBottom,
  isAwayScrollKey,
  isUserScrollKey,
  pinOverflowListToEnd,
  shouldFollowScrollBottom,
  shouldOfferJumpToBottom,
  shouldPinAfterContentGrowth,
  WHEEL_GESTURE_QUIET_MS,
  type FollowEvent,
  type FollowState,
} from "./scroll-follow.js";

function run(events: FollowEvent[], from: FollowState = INITIAL_FOLLOW_STATE): FollowState {
  return events.reduce(followReducer, from);
}
const wheelUp = (at: number, canScrollUp = true): FollowEvent => ({
  type: "userIntent",
  intent: "wheelUp",
  at,
  canScrollUp,
});

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

test("streaming growth larger than the old slop never turns follow off", () => {
  // A single commit can push the bottom far past any distance threshold before
  // the follow snap runs; only a user gesture may end follow.
  const state = run([
    { type: "contentResize", distance: 320 },
    { type: "settle", distance: 320 },
    { type: "contentResize", distance: 900 },
  ]);
  assert.equal(state.following, true);
  assert.equal(followNeedsSnap(state), true);
  assert.equal(shouldOfferJumpToBottom(state, true), false);
});

test("an upward wheel with overflow turns follow off, and growth never turns it back on", () => {
  const away = run([wheelUp(1_000), { type: "settle", distance: 60 }]);
  assert.equal(away.following, false);
  const grown = run([{ type: "contentResize", distance: 400 }, { type: "settle", distance: 400 }], away);
  assert.equal(grown.following, false);
  assert.equal(followNeedsSnap(grown), false);
  assert.equal(shouldOfferJumpToBottom(grown, true), true);
});

test("an upward wheel that cannot scroll leaves follow on", () => {
  assert.equal(run([wheelUp(1_000, false)]).following, true);
});

test("a small upward nudge inside the re-arm band does not immediately re-arm", () => {
  // The wheel moves the view up by 10px: it is still inside the band, but
  // moving away, so streaming must not pull it back.
  const state = run([wheelUp(1_000), { type: "settle", distance: 10 }, { type: "settle", distance: 22 }]);
  assert.equal(state.following, false);
});

test("returning toward the bottom re-arms follow within 40px", () => {
  const away = run([wheelUp(1_000), { type: "settle", distance: 500 }]);
  assert.equal(run([{ type: "settle", distance: 120 }], away).following, false);
  assert.equal(run([{ type: "settle", distance: 41 }], away).following, false);
  assert.equal(run([{ type: "settle", distance: 39 }], away).following, true);
});

test("a jump survives momentum from the gesture that was coasting when it was pressed", () => {
  // The reader flings up, then presses jump while the fling still coasts.
  let state = run([wheelUp(1_000), wheelUp(1_016), { type: "settle", distance: 700 }]);
  assert.equal(state.following, false);
  state = run([{ type: "jump", smooth: false }, { type: "contentResize", distance: 0 }], state);
  assert.equal(followIgnoresWheel(state, 1_032), true);
  state = run([wheelUp(1_032), wheelUp(1_048), wheelUp(1_064)], state);
  assert.equal(state.following, true, "coasting momentum is not a new intent");
  // A new upward gesture after the coast goes quiet is a real intent.
  const later = 1_064 + WHEEL_GESTURE_QUIET_MS + 1;
  assert.equal(followIgnoresWheel(state, later), false);
  assert.equal(run([wheelUp(later)], state).following, false);
});

test("a jump with no prior wheel still honours the next upward gesture", () => {
  const state = run([{ type: "jump", smooth: false }, wheelUp(5_000)]);
  assert.equal(state.following, false);
});

test("a smooth jump stays latched through its own animation samples", () => {
  let state = run([wheelUp(1_000), { type: "settle", distance: 800 }, { type: "jump", smooth: true }]);
  assert.equal(state.following, true);
  assert.equal(state.jumpPending, true);
  // Samples while the animation runs keep the latch and hide the button.
  state = run([{ type: "settle", distance: 500 }, { type: "contentResize", distance: 540 }], state);
  assert.equal(state.following, true);
  assert.equal(shouldOfferJumpToBottom(state, false), false);
  assert.equal(followNeedsSnap(state), false, "no snap fights an animation in flight");
  // Ending short of the bottom (content grew under it) asks for a corrective snap.
  state = run([{ type: "settle", distance: 140, ended: true }], state);
  assert.equal(state.jumpPending, false);
  assert.equal(followNeedsSnap(state), true);
});

test("a gesture during a smooth jump releases it (PR #250)", () => {
  const jumping = run([wheelUp(1_000), { type: "settle", distance: 800 }, { type: "jump", smooth: true }]);
  // An upward wheel well after the earlier gesture aborts the jump and follow.
  const aborted = run([wheelUp(3_000), { type: "settle", distance: 820 }], jumping);
  assert.deepEqual(
    { following: aborted.following, jumpPending: aborted.jumpPending },
    { following: false, jumpPending: false },
  );
  // A touch or a downward key releases the pending jump but keeps following.
  for (const intent of ["drag", "key", "scrollbar"] as const) {
    const released = run([{ type: "userIntent", intent, at: 3_000, canScrollUp: false }], jumping);
    assert.deepEqual(
      { following: released.following, jumpPending: released.jumpPending },
      { following: true, jumpPending: false },
      intent,
    );
  }
});

test("the jump button waits for a larger distance while streaming", () => {
  const away = run([wheelUp(1_000), { type: "settle", distance: 120 }]);
  assert.equal(shouldOfferJumpToBottom(away, false), true);
  assert.equal(shouldOfferJumpToBottom(away, true), false);
  assert.equal(shouldOfferJumpToBottom(run([{ type: "settle", distance: 300 }], away), true), true);
});

test("opening another conversation re-arms follow", () => {
  const away = run([wheelUp(1_000), { type: "settle", distance: 900 }]);
  assert.deepEqual(run([{ type: "reset" }], away), INITIAL_FOLLOW_STATE);
});

test("only scrolling keys count as a user interruption", () => {
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
    assert.equal(isUserScrollKey(key), true, key);
  }
  for (const key of ["a", "Enter", "Tab", "Escape", "ArrowLeft"]) {
    assert.equal(isUserScrollKey(key), false, key);
  }
});

test("only keys that page toward the start count as moving away", () => {
  for (const key of ["ArrowUp", "PageUp", "Home"]) assert.equal(isAwayScrollKey(key), true, key);
  for (const key of ["ArrowDown", "PageDown", "End", " "]) assert.equal(isAwayScrollKey(key), false, key);
  assert.equal(isAwayScrollKey(" ", true), true, "Shift+Space pages up");
});

test("opening a long task list pins to the latest rows", () => {
  const list = { scrollHeight: 840, scrollTop: 0 };
  pinOverflowListToEnd(list);
  assert.equal(list.scrollTop, 840);
  pinOverflowListToEnd(null);
});
