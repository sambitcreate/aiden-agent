// Device presets and buckets for live app frames (design mode v2 Phase 3b, S85, S88).

import assert from "node:assert/strict";
import test from "node:test";
import { APP_DEVICES, deviceBucket, isAppDevice } from "./app-devices.js";

test("deviceBucket splits viewport widths at 480, 1023 and 1439", () => {
  const cases: Array<[number, string]> = [
    [200, "phone"],
    [390, "phone"],
    [480, "phone"],
    [481, "tablet"],
    [768, "tablet"],
    [1023, "tablet"],
    [1024, "laptop"],
    [1280, "laptop"],
    [1439, "laptop"],
    [1440, "desktop"],
    [3840, "desktop"],
  ];
  for (const [width, bucket] of cases) assert.equal(deviceBucket(width), bucket, String(width));
});

test("each preset's own width falls in its own bucket", () => {
  for (const name of ["phone", "tablet", "laptop", "desktop"] as const) assert.equal(deviceBucket(APP_DEVICES[name].width), name);
});

test("isAppDevice accepts the four names only", () => {
  assert.equal(isAppDevice("phone"), true);
  assert.equal(isAppDevice("desktop"), true);
  assert.equal(isAppDevice("watch"), false);
  assert.equal(isAppDevice(390), false);
  assert.equal(isAppDevice(undefined), false);
});
