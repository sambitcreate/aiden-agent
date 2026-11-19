import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prefersReducedMotion } from "./appearance-runtime";
import { whenAnimationsSettle } from "./use-presence";

const originalMatchMedia = window.matchMedia;

function systemReducesMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query === "(prefers-reduced-motion: reduce)",
      media: query,
    }) as MediaQueryList) as typeof window.matchMedia;
}

afterEach(() => {
  delete document.documentElement.dataset.reduceMotion;
  window.matchMedia = originalMatchMedia;
});

test("Aiden's applied Reduce Motion decides, and the system stands in only before it is applied", () => {
  systemReducesMotion(true);
  assert.equal(prefersReducedMotion(), true, "nothing applied yet: the system preference");

  document.documentElement.dataset.reduceMotion = "false";
  assert.equal(prefersReducedMotion(), false, "an explicit Off wins over the system");

  systemReducesMotion(false);
  document.documentElement.dataset.reduceMotion = "true";
  assert.equal(prefersReducedMotion(), true, "an explicit On wins over the system");
});

test("script-driven motion follows the in-app setting, not the OS query", async () => {
  let finishExit!: () => void;
  const exit = {
    finished: new Promise<void>((resolve) => (finishExit = resolve)),
    effect: { getComputedTiming: () => ({ endTime: 10_000, localTime: 0 }) },
  };
  const element = document.createElement("div");
  element.getAnimations = () => [exit] as unknown as Animation[];
  const waitForExit = () => {
    let done = false;
    whenAnimationsSettle(element, () => (done = true));
    return () => done;
  };

  // The system asks for less motion, but the person turned Reduce Motion off in Aiden.
  systemReducesMotion(true);
  document.documentElement.dataset.reduceMotion = "false";
  const offDone = waitForExit();
  assert.equal(offDone(), false, "the exit animation plays");
  finishExit();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(offDone(), true);

  // Turning it on in Aiden, with the system allowing motion, skips script animations at once.
  systemReducesMotion(false);
  document.documentElement.dataset.reduceMotion = "true";
  assert.equal(waitForExit()(), true);
});
