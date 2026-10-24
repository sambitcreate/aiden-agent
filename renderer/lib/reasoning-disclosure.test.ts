import assert from "node:assert/strict";
import test from "node:test";
import { reasoningDisclosureLayout } from "./reasoning-disclosure.js";

test("automatic reasoning previews are bounded and manual expansion flows at full height", () => {
  assert.equal(reasoningDisclosureLayout({ expanded: true, userControlled: false }), "preview");
  assert.equal(reasoningDisclosureLayout({ expanded: true, userControlled: true }), "full");
});

test("a closed reasoning section hides its body regardless of who closed it", () => {
  assert.equal(reasoningDisclosureLayout({ expanded: false, userControlled: false }), "collapsed");
  assert.equal(reasoningDisclosureLayout({ expanded: false, userControlled: true }), "collapsed");
});
