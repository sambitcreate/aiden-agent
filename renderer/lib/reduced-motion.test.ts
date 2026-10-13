import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prefersReducedMotion } from "./appearance-runtime";

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

test("motion is reduced when Aiden's Reduce Motion setting or the system asks for it", () => {
  systemReducesMotion(false);
  assert.equal(prefersReducedMotion(), false);

  document.documentElement.dataset.reduceMotion = "true";
  assert.equal(prefersReducedMotion(), true);

  document.documentElement.dataset.reduceMotion = "false";
  systemReducesMotion(true);
  assert.equal(prefersReducedMotion(), true);
});
