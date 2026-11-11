import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_FEATURE_FLAG,
  DESIGN_MODE_KILL_SWITCH,
  designModeEnabled,
  studioAssetsEnabled,
  studioCapabilities,
} from "./feature-flags.js";

// The retired Design Studio flag, still set in some developers' shells.
const RETIRED_DESIGN_STUDIO_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_STUDIO";
// Design mode's flag before launch; it no longer changes anything.
const OLD_DESIGN_MODE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_MODE";
const DESIGN_OFF = { [DESIGN_MODE_KILL_SWITCH]: "0" };

test("Create Images stays off unless its own experimental flag is set", () => {
  assert.deepEqual(studioCapabilities(DESIGN_OFF), { createImages: false, designMode: false });
  assert.deepEqual(studioCapabilities({ ...DESIGN_OFF, [CREATE_IMAGES_FEATURE_FLAG]: " TRUE " }), {
    createImages: true,
    designMode: false,
  });
  for (const value of ["0", "", "yes", "on", "false"]) {
    assert.deepEqual(
      studioCapabilities({ ...DESIGN_OFF, [CREATE_IMAGES_FEATURE_FLAG]: value }),
      { createImages: false, designMode: false },
      value,
    );
  }
});

test("the retired Design Studio flag turns nothing on", () => {
  assert.deepEqual(studioCapabilities({ ...DESIGN_OFF, [RETIRED_DESIGN_STUDIO_FLAG]: "1" }), {
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

test("design mode is on unless AIDEN_DESIGN_MODE turns it off", () => {
  assert.equal(DESIGN_MODE_KILL_SWITCH, "AIDEN_DESIGN_MODE");
  assert.equal(designModeEnabled({}), true);
  for (const value of ["0", " false ", "OFF", "no"]) {
    assert.equal(designModeEnabled({ [DESIGN_MODE_KILL_SWITCH]: value }), false, value);
  }
  for (const value of ["1", "", "true", "yes", "maybe"]) {
    assert.equal(designModeEnabled({ [DESIGN_MODE_KILL_SWITCH]: value }), true, value);
  }
  // The pre-launch flag neither turns it on nor off.
  assert.equal(designModeEnabled({ [OLD_DESIGN_MODE_FLAG]: "0" }), true);
  assert.equal(designModeEnabled({ ...DESIGN_OFF, [OLD_DESIGN_MODE_FLAG]: "1" }), false);
  assert.equal(designModeEnabled({ [RETIRED_DESIGN_STUDIO_FLAG]: "0" }), true);
});

test("design mode and Create Images are independent capabilities", () => {
  assert.deepEqual(studioCapabilities({}), { createImages: false, designMode: true });
  assert.deepEqual(studioCapabilities({ [CREATE_IMAGES_FEATURE_FLAG]: "1" }), { createImages: true, designMode: true });
  assert.deepEqual(studioCapabilities({ ...DESIGN_OFF, [CREATE_IMAGES_FEATURE_FLAG]: "1" }), {
    createImages: true,
    designMode: false,
  });
});

test("design mode does not open the shared asset store", () => {
  assert.equal(studioAssetsEnabled({}), false);
});
