import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { usePresence } from "./use-presence";

interface FakeAnimation {
  finished: Promise<FakeAnimation>;
  effect: { getComputedTiming: () => { endTime: number; localTime: number } };
  finish: () => void;
}

function fakeAnimation(endTime: number): FakeAnimation {
  let resolve!: (value: FakeAnimation) => void;
  const animation: FakeAnimation = {
    finished: new Promise((done) => (resolve = done)),
    effect: { getComputedTiming: () => ({ endTime, localTime: 0 }) },
    finish: () => resolve(animation),
  };
  return animation;
}

// Stands in for the stylesheet: an exiting panel runs the animations the test gives it.
let exitAnimations: FakeAnimation[] = [];
const originalGetAnimations = Element.prototype.getAnimations;
const originalMatchMedia = window.matchMedia;

function systemReducesMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) =>
    ({ matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query }) as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => {
  exitAnimations = [];
  Element.prototype.getAnimations = function (this: Element) {
    return (this.getAttribute("data-presence") === "exiting" ? exitAnimations : []) as unknown as Animation[];
  };
  document.documentElement.dataset.reduceMotion = "false";
  systemReducesMotion(false);
});

afterEach(() => {
  cleanup();
  if (originalGetAnimations) Element.prototype.getAnimations = originalGetAnimations;
  else delete (Element.prototype as Partial<Element>).getAnimations;
  window.matchMedia = originalMatchMedia;
  delete document.documentElement.dataset.reduceMotion;
});

function Panel({ present }: { present: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { rendered, exiting } = usePresence(present, ref);
  if (!rendered) return null;
  return (
    <div ref={ref} role="status" data-presence={exiting ? "exiting" : "visible"}>
      Saved
    </div>
  );
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a closing element stays mounted, marked exiting, until its exit animations settle", async () => {
  const fade = fakeAnimation(10_000);
  const slide = fakeAnimation(10_000);
  exitAnimations = [fade, slide];
  const { rerender } = render(<Panel present />);

  rerender(<Panel present={false} />);
  await settle();
  assert.equal(screen.getByRole("status").dataset.presence, "exiting");

  fade.finish();
  await settle();
  assert.ok(screen.queryByRole("status"), "waits for every animation, not the first");

  slide.finish();
  await settle();
  assert.equal(screen.queryByRole("status"), null);
});

test("without a finite exit animation the element unmounts at once", () => {
  // An infinite loop inside (a shimmer) never finishes, so it does not hold the exit.
  exitAnimations = [fakeAnimation(Number.POSITIVE_INFINITY)];
  const { rerender } = render(<Panel present />);
  rerender(<Panel present={false} />);
  assert.equal(screen.queryByRole("status"), null);
});

test("Aiden's Reduce Motion skips the exit even while the system allows motion", () => {
  exitAnimations = [fakeAnimation(10_000)];
  document.documentElement.dataset.reduceMotion = "true";
  const { rerender } = render(<Panel present />);
  rerender(<Panel present={false} />);
  assert.equal(screen.queryByRole("status"), null);
});

test("an exit that never finishes (a paused animation) still unmounts after its computed end", async () => {
  exitAnimations = [fakeAnimation(20)];
  const { rerender } = render(<Panel present />);
  rerender(<Panel present={false} />);
  assert.ok(screen.queryByRole("status"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  assert.equal(screen.queryByRole("status"), null);
});

test("presenting again during the exit keeps the element and cancels the unmount", async () => {
  const fade = fakeAnimation(10_000);
  exitAnimations = [fade];
  const { rerender } = render(<Panel present />);
  rerender(<Panel present={false} />);
  rerender(<Panel present />);
  fade.finish();
  await settle();
  assert.equal(screen.getByRole("status").dataset.presence, "visible");
});
