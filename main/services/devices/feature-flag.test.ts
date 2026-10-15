import assert from "node:assert/strict";
import test from "node:test";
import { DEVICES_FEATURE_FLAG, devicesEnabled } from "./feature-flag.js";

test("simulator devices ship on for macOS with an explicit kill switch", () => {
  assert.equal(devicesEnabled({}, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: " TRUE " }, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "0" }, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: " false " }, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "" }, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "yes" }, "darwin"), false);
});

test("simulator devices stay off outside macOS whatever the flag says", () => {
  assert.equal(devicesEnabled({}, "linux"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "linux"), false);
  assert.equal(devicesEnabled({}, "win32"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "win32"), false);
});
