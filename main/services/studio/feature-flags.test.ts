import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_FEATURE_FLAG,
  DESIGN_STUDIO_FEATURE_FLAG,
  studioAssetsEnabled,
  studioCapabilities,
} from "./feature-flags.js";

test("studio features stay off unless their own experimental flag is set", () => {
  assert.deepEqual(studioCapabilities({}), { designStudio: false, createImages: false });
  assert.deepEqual(studioCapabilities({ [DESIGN_STUDIO_FEATURE_FLAG]: "1" }), {
    designStudio: true,
    createImages: false,
  });
  assert.deepEqual(studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: " TRUE " }), {
    designStudio: false,
    createImages: true,
  });
  for (const value of ["0", "", "yes", "on", "false"]) {
    assert.deepEqual(
      studioCapabilities({ [DESIGN_STUDIO_FEATURE_FLAG]: value, [CREATE_IMAGES_FEATURE_FLAG]: value }),
      { designStudio: false, createImages: false },
      value,
    );
  }
});

test("the shared asset store opens when either studio feature is on", () => {
  assert.equal(studioAssetsEnabled({}), false);
  assert.equal(studioAssetsEnabled({ [DESIGN_STUDIO_FEATURE_FLAG]: "1" }), true);
  assert.equal(studioAssetsEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "true" }), true);
});
