import assert from "node:assert/strict";
import test from "node:test";
import { shouldQuitAfterAllWindowsClose } from "./application-lifecycle-core.js";

test("macOS retains its conventional last-window behavior", () => {
  assert.equal(shouldQuitAfterAllWindowsClose("darwin", false), false);
});

test("Linux quits without background ownership and stays alive for Remote Access", () => {
  assert.equal(shouldQuitAfterAllWindowsClose("linux", false), true);
  assert.equal(shouldQuitAfterAllWindowsClose("linux", true), false);
});
