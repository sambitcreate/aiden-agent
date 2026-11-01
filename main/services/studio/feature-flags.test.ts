import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_FEATURE_FLAG,
  studioAssetsEnabled,
  studioCapabilities,
} from "./feature-flags.js";

// The retired Design Studio flag, still set in some developers' shells.
const RETIRED_DESIGN_STUDIO_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO";

test("Create Images stays off unless its own experimental flag is set", () => {
  assert.deepEqual(studioCapabilities({}), { createImages: false });
  assert.deepEqual(studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: " TRUE " }), { createImages: true });
  for (const value of ["0", "", "yes", "on", "false"]) {
    assert.deepEqual(studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: value }), { createImages: false }, value);
  }
});

test("the retired Design Studio flag turns nothing on", () => {
  assert.deepEqual(studioCapabilities({ [RETIRED_DESIGN_STUDIO_FLAG]: "1" }), { createImages: false });
  assert.equal(studioAssetsEnabled({ [RETIRED_DESIGN_STUDIO_FLAG]: "1" }), false);
});

test("the shared asset store opens only while Create Images is on", () => {
  assert.equal(studioAssetsEnabled({}), false);
  assert.equal(studioAssetsEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "1" }), true);
  assert.equal(studioAssetsEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "true" }), true);
});
