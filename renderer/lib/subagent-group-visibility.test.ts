import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, renderHook } from "@testing-library/react";

/** A stand-in for the browser's observer that the test moves cards in and out of view with. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** Reports these elements as on or off screen, as the browser does after a scroll. */
  report(changes: Array<[Element, boolean]>) {
    this.callback(
      changes.map(([target, isIntersecting]) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
  static latest(): FakeIntersectionObserver {
    const latest = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
    assert.ok(latest, "an observer was created");
    return latest;
  }
}

(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;

const {
  isAnySubagentGroupOnScreen,
  observeSubagentGroup,
  onScreenSubagentGroupElement,
  setSubagentGroupBottomInset,
  useSubagentGroupOnScreen,
} = await import("./subagent-group-visibility");

test("a batch counts as on screen while any of its cards is, through a live-to-saved handoff", () => {
  const live = document.createElement("section");
  const saved = document.createElement("section");
  const stopLive = observeSubagentGroup(live, "gen-1");
  const stopSaved = observeSubagentGroup(saved, "gen-1");
  const io = FakeIntersectionObserver.latest();

  assert.equal(isAnySubagentGroupOnScreen(["gen-1"]), false, "nothing is on screen until the observer says so");
  io.report([[live, true]]);
  assert.equal(isAnySubagentGroupOnScreen(["gen-1"]), true);
  assert.equal(isAnySubagentGroupOnScreen(["gen-2"]), false, "another batch's card does not count");
  assert.equal(onScreenSubagentGroupElement(["gen-2", "gen-1"]) === live, true);

  // The saved card takes the live one's place while both are briefly mounted.
  io.report([[saved, true]]);
  stopLive();
  assert.equal(isAnySubagentGroupOnScreen(["gen-1"]), true, "the saved card still stands for the batch");
  io.report([[saved, false]]);
  assert.equal(isAnySubagentGroupOnScreen(["gen-1"]), false, "scrolled away");
  stopSaved();
  assert.equal(io.observed.size, 0, "unmounted cards are no longer watched");
});

test("the hook re-renders as a batch's card scrolls in and out of view", () => {
  const card = document.createElement("section");
  const stop = observeSubagentGroup(card, "gen-hook");
  const io = FakeIntersectionObserver.latest();
  const { result, rerender } = renderHook(({ keys }) => useSubagentGroupOnScreen(keys), {
    initialProps: { keys: ["gen-hook"] },
  });
  assert.equal(result.current, false);
  act(() => io.report([[card, true]]));
  assert.equal(result.current, true);
  rerender({ keys: ["gen-other"] });
  assert.equal(result.current, false, "a different batch has no card on screen");
  rerender({ keys: ["gen-hook"] });
  act(() => io.report([[card, false]]));
  assert.equal(result.current, false);
  stop();
});

test("a card hidden behind the composer is not on screen: the composer's height moves the boundary", () => {
  const card = document.createElement("section");
  const stop = observeSubagentGroup(card, "gen-inset");
  const before = FakeIntersectionObserver.latest();

  // A few pixels of drift do not rebuild anything.
  setSubagentGroupBottomInset(4);
  assert.equal(FakeIntersectionObserver.latest() === before, true);

  setSubagentGroupBottomInset(160);
  const after = FakeIntersectionObserver.latest();
  assert.equal(after === before, false, "a real change builds a new observer");
  assert.equal(before.disconnected, true);
  assert.equal(after.options.rootMargin, "0px 0px -160px 0px");
  assert.equal(after.observed.has(card), true, "every card is watched again");

  // Cleanup reaches the current observer, not the one the card was first registered with.
  stop();
  assert.equal(after.observed.has(card), false);
  setSubagentGroupBottomInset(0);
});
