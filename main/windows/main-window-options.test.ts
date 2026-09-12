import assert from "node:assert/strict";
import test from "node:test";

import { mainWindowOptions } from "./main-window-options.js";

test("macOS keeps Aiden's inset transparent window treatment", () => {
  const options = mainWindowOptions("/tmp/preload.cjs", "darwin");
  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.equal(options.transparent, true);
  assert.equal(options.vibrancy, "sidebar");
  assert.deepEqual(options.trafficLightPosition, { x: 14, y: 20 });
});

test("Linux uses compositor-owned opaque native window chrome", () => {
  const options = mainWindowOptions("/tmp/preload.cjs", "linux");
  assert.equal(options.titleBarStyle, "default");
  assert.equal(options.transparent, false);
  assert.equal(options.backgroundColor, "#f6f7f9");
  assert.equal(options.vibrancy, undefined);
  assert.equal(options.trafficLightPosition, undefined);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(mainWindowOptions("/tmp/preload.cjs", "linux", true).backgroundColor, "#181b21");
});
