import assert from "node:assert/strict";
import test from "node:test";

import { mainPushReleaseSelection } from "./prepare-ci-release.mjs";

test("an unpublished declared version is selected exactly", () => {
  assert.deepEqual(mainPushReleaseSelection("0.35.0", false), {
    version: "0.35.0",
    tag: "v0.35.0",
    publish: true,
  });
});

test("an existing declared tag makes release publication a green no-op", () => {
  assert.deepEqual(mainPushReleaseSelection("0.35.0", true), {
    version: "0.35.0",
    tag: "v0.35.0",
    publish: false,
  });
});

test("declared release selection rejects ambiguous inputs", () => {
  assert.throws(
    () => mainPushReleaseSelection("1.0", false),
    /Invalid declared release version/u,
  );
  assert.throws(
    () => mainPushReleaseSelection("1.0.0", undefined),
    /Declared tag existence must be a boolean/u,
  );
});
