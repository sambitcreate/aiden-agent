import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_FEATURE_FLAG,
  DESIGN_MODE_FEATURE_FLAG,
  designModeEnabled,
  studioAssetsEnabled,
  studioCapabilities,
} from "./feature-flags.js";

// The retired Design Studio flag, still set in some developers' shells.
const RETIRED_DESIGN_STUDIO_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO";

test("Create Images stays off unless its own experimental flag is set", () => {
  assert.deepEqual(studioCapabilities({}), { createImages: false, designMode: false });
  assert.deepEqual(studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: " TRUE " }), {
    createImages: true,
    designMode: false,
  });
  for (const value of ["0", "", "yes", "on", "false"]) {
    assert.deepEqual(
      studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: value }),
      { createImages: false, designMode: false },
      value,
    );
  }
});

test("the retired Design Studio flag turns nothing on", () => {
  assert.deepEqual(studioCapabilities({ [RETIRED_DESIGN_STUDIO_FLAG]: "1" }), {
    createImages: false,
    designMode: false,
  });
  assert.equal(studioAssetsEnabled({ [RETIRED_DESIGN_STUDIO_FLAG]: "1" }), false);
});

test("the shared asset store opens only while Create Images is on", () => {
  assert.equal(studioAssetsEnabled({}), false);
  assert.equal(studioAssetsEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "1" }), true);
  assert.equal(studioAssetsEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "true" }), true);
});

test("design mode stays off unless its own experimental flag is set", () => {
  assert.equal(DESIGN_MODE_FEATURE_FLAG, "AIDEN_EXPERIMENTAL_DESIGN_MODE");
  assert.equal(designModeEnabled({ [DESIGN_MODE_FEATURE_FLAG]: " TRUE " }), true);
  assert.equal(designModeEnabled({ [DESIGN_MODE_FEATURE_FLAG]: "1" }), true);
  assert.equal(designModeEnabled({}), false);
  for (const value of ["0", "", "yes", "on", "false"]) {
    assert.equal(designModeEnabled({ [DESIGN_MODE_FEATURE_FLAG]: value }), false, value);
  }
  assert.equal(designModeEnabled({ [RETIRED_DESIGN_STUDIO_FLAG]: "1" }), false);
});

test("design mode and Create Images are independent capabilities", () => {
  assert.deepEqual(studioCapabilities({ [DESIGN_MODE_FEATURE_FLAG]: "1" }), {
    createImages: false,
    designMode: true,
  });
  assert.deepEqual(
    studioCapabilities({ [DESIGN_MODE_FEATURE_FLAG]: "1", [CREATE_IMAGES_FEATURE_FLAG]: "1" }),
    { createImages: true, designMode: true },
  );
});

test("design mode does not open the shared asset store", () => {
  assert.equal(studioAssetsEnabled({ [DESIGN_MODE_FEATURE_FLAG]: "1" }), false);
});
