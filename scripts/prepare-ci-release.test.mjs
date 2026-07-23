import assert from "node:assert/strict";
import test from "node:test";

import { automaticReleaseVersion } from "./prepare-ci-release.mjs";

test("main pushes receive a monotonic patch version inside the declared release line", () => {
  assert.equal(automaticReleaseVersion("1.0.0", "41"), "1.0.41");
  assert.equal(automaticReleaseVersion("2.3.0", 42), "2.3.42");
});

test("automatic release versions reject ambiguous inputs", () => {
  assert.throws(() => automaticReleaseVersion("1.0", 1), /Invalid base release version/u);
  assert.throws(() => automaticReleaseVersion("1.0.0", 0), /positive integer/u);
  assert.throws(() => automaticReleaseVersion("1.0.0", "01"), /positive integer/u);
});
