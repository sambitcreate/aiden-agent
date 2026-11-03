import assert from "node:assert/strict";
import test from "node:test";

import { windowChromeFromArgv } from "../../renderer/shared/window-chrome.js";
import { mainWindowOptions } from "./main-window-options.js";

test("macOS keeps Aiden's inset transparent window treatment", () => {
  const options = mainWindowOptions("/tmp/preload.cjs", "darwin");
  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.equal(options.transparent, true);
  assert.equal(options.vibrancy, "sidebar");
  assert.deepEqual(options.trafficLightPosition, { x: 14, y: 20 });
  assert.equal(windowChromeFromArgv(options.webPreferences?.additionalArguments ?? []), "mac");
});

test("Linux with the system title bar uses compositor-owned opaque native chrome", () => {
  const options = mainWindowOptions("/tmp/preload.cjs", "linux", false, "system");
  assert.equal(options.titleBarStyle, "default");
  assert.equal(options.transparent, false);
  assert.equal(options.backgroundColor, "#f6f7f9");
  assert.equal(options.vibrancy, undefined);
  assert.equal(options.trafficLightPosition, undefined);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(windowChromeFromArgv(options.webPreferences?.additionalArguments ?? []), "system");
  assert.equal(mainWindowOptions("/tmp/preload.cjs", "linux", true, "system").backgroundColor, "#181b21");
});

test("Linux with Aiden's title bar hides the desktop frame and tells the renderer", () => {
  const options = mainWindowOptions("/tmp/preload.cjs", "linux", true, "aiden");
  assert.equal(options.titleBarStyle, "hidden");
  assert.equal(options.titleBarOverlay, undefined, "Aiden draws its own controls, not the overlay");
  assert.equal(options.transparent, false);
  assert.equal(options.backgroundColor, "#181b21");
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(windowChromeFromArgv(options.webPreferences?.additionalArguments ?? []), "aiden");
});
