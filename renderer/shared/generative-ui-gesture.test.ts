import assert from "node:assert/strict";
import test from "node:test";
import { createFrameGestureTracker } from "./generative-ui-gesture.js";

const quietEntry = { active: true, hovered: true, expanded: false, duringTabDefault: false, parentInputRecent: false };

test("clicking into a visual both focuses and activates it: that is its gesture", () => {
  const tracker = createFrameGestureTracker();
  tracker.focusEntered(quietEntry);
  assert.equal(tracker.gestured({ active: true, focused: true }), true);
});

test("a visual that steals focus after the user clicked a different visual gets no gesture", () => {
  // The click in visual B activated the page; the pointer is over B, not A.
  const a = createFrameGestureTracker();
  a.focusEntered({ ...quietEntry, hovered: false });
  for (let frame = 0; frame < 10; frame += 1) a.tick({ active: true, focused: true });
  assert.equal(a.gestured({ active: true, focused: true }), false);
});

test("activation that starts while the visual already holds focus is input into that visual", () => {
  const tracker = createFrameGestureTracker();
  tracker.focusEntered({ ...quietEntry, active: false, hovered: false });
  tracker.tick({ active: false, focused: true });
  assert.equal(tracker.gestured({ active: false, focused: true }), false);
  // A click or key press inside the focused guest: activation turns on, focus stays.
  tracker.tick({ active: true, focused: true });
  assert.equal(tracker.gestured({ active: true, focused: true }), true);
});

test("activation that arrives together with focus moving elsewhere is not attributed", () => {
  const tracker = createFrameGestureTracker();
  tracker.focusEntered({ ...quietEntry, active: false, hovered: false });
  tracker.tick({ active: false, focused: true });
  tracker.tick({ active: true, focused: false });
  tracker.tick({ active: true, focused: true });
  assert.equal(tracker.gestured({ active: true, focused: true }), false);
});

test("a visual that steals focus while the user types in the composer gets no gesture", () => {
  const tracker = createFrameGestureTracker();
  // Even with the pointer resting over it, recent page input owns the activation.
  tracker.focusEntered({ ...quietEntry, parentInputRecent: true });
  for (let frame = 0; frame < 10; frame += 1) tracker.tick({ active: true, focused: true });
  assert.equal(tracker.gestured({ active: true, focused: true }), false);
});

test("tabbing into a visual is a keyboard gesture; a steal after the Tab is not", () => {
  const tabbed = createFrameGestureTracker();
  tabbed.focusEntered({ ...quietEntry, hovered: false, parentInputRecent: true, duringTabDefault: true });
  assert.equal(tabbed.gestured({ active: true, focused: true }), true);

  const stolen = createFrameGestureTracker();
  stolen.focusEntered({ ...quietEntry, hovered: false, parentInputRecent: true, duringTabDefault: false });
  assert.equal(stolen.gestured({ active: true, focused: true }), false);
});

test("in the expanded view a click into the visual counts even right after the Expand click", () => {
  // Everything else is inert while expanded, so no other visual can take focus.
  const tracker = createFrameGestureTracker();
  tracker.focusEntered({ ...quietEntry, parentInputRecent: true, expanded: true });
  assert.equal(tracker.gestured({ active: true, focused: true }), true);
});

test("a gesture ends when activation lapses or focus leaves, and needs a new one after", () => {
  const tracker = createFrameGestureTracker();
  tracker.focusEntered(quietEntry);
  tracker.tick({ active: true, focused: true });
  assert.equal(tracker.gestured({ active: true, focused: true }), true);
  tracker.tick({ active: false, focused: true });
  assert.equal(tracker.gestured({ active: true, focused: true }), false);

  const left = createFrameGestureTracker();
  left.focusEntered(quietEntry);
  left.focusLeft();
  assert.equal(left.gestured({ active: true, focused: true }), false);
  // Re-entering by stealing focus (no hover, page already active) earns nothing.
  left.focusEntered({ ...quietEntry, hovered: false });
  assert.equal(left.gestured({ active: true, focused: true }), false);
});

test("an inactive page or an unfocused frame is never gestured", () => {
  const tracker = createFrameGestureTracker();
  tracker.focusEntered(quietEntry);
  assert.equal(tracker.gestured({ active: false, focused: true }), false);
  assert.equal(tracker.gestured({ active: true, focused: false }), false);
  const inactiveEntry = createFrameGestureTracker();
  inactiveEntry.focusEntered({ ...quietEntry, active: false });
  assert.equal(inactiveEntry.gestured({ active: true, focused: true }), false);
});
