import assert from "node:assert/strict";
import test from "node:test";
import { shouldQuitAfterAllWindowsClose, shouldReleaseAuxiliaryWindows } from "./application-lifecycle-core.js";

test("macOS retains its conventional last-window behavior", () => {
  assert.equal(shouldQuitAfterAllWindowsClose("darwin", false), false);
});

test("Linux quits without background ownership and stays alive for Remote Access", () => {
  assert.equal(shouldQuitAfterAllWindowsClose("linux", false), true);
  assert.equal(shouldQuitAfterAllWindowsClose("linux", true), false);
});

test("a hidden helper window never keeps a closing app alive on Linux and Windows", () => {
  const helper = { auxiliary: true };
  const app = { auxiliary: false };
  // Only the hidden snapshot window is left: release it so the app can quit.
  assert.equal(shouldReleaseAuxiliaryWindows("linux", false, [helper]), true);
  assert.equal(shouldReleaseAuxiliaryWindows("win32", false, [helper, helper]), true);
  // A real window is still open, macOS keeps running, or Remote Access keeps Aiden alive.
  assert.equal(shouldReleaseAuxiliaryWindows("linux", false, [helper, app]), false);
  assert.equal(shouldReleaseAuxiliaryWindows("darwin", false, [helper]), false);
  assert.equal(shouldReleaseAuxiliaryWindows("linux", true, [helper]), false);
  // Nothing is left to release; Electron already reports every window closed.
  assert.equal(shouldReleaseAuxiliaryWindows("linux", false, []), false);
});
