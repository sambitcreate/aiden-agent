import assert from "node:assert/strict";
import test from "node:test";
import { stickyHeaderIsStuck } from "./sticky-section.js";

test("a header counts as stuck only once its section has scrolled above it", () => {
  // Resting: the header sits at the top of its own section.
  assert.equal(stickyHeaderIsStuck(120, 120), false);
  // Sub-pixel layout rounding is not a scroll.
  assert.equal(stickyHeaderIsStuck(120, 120.5), false);
  // The section began above the sticky line, so the header is pinned.
  assert.equal(stickyHeaderIsStuck(-400, 48), true);
});
