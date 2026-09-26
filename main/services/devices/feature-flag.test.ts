import assert from "node:assert/strict";
import test from "node:test";
import { DEVICES_FEATURE_FLAG, devicesEnabled } from "./feature-flag.js";

test("simulator devices stay off unless the experimental flag is set on macOS", () => {
  assert.equal(devicesEnabled({}, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: " TRUE " }, "darwin"), true);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "0" }, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "yes" }, "darwin"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "linux"), false);
  assert.equal(devicesEnabled({ [DEVICES_FEATURE_FLAG]: "1" }, "win32"), false);
});
