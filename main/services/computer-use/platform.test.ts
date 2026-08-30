import assert from "node:assert/strict";
import test from "node:test";
import { computerUseSupported, unsupportedComputerUseStatus } from "./platform.js";

test("Computer Use is exposed only on macOS", () => {
  assert.equal(computerUseSupported("darwin"), true);
  assert.equal(computerUseSupported("linux"), false);
  assert.equal(computerUseSupported("win32"), false);
});

test("the Linux fallback fails closed without suggesting macOS permissions", () => {
  assert.deepEqual(unsupportedComputerUseStatus(), {
    enabled: false,
    beta: true,
    state: "unsupported",
    detail: "Computer Use is not included on this platform.",
    ready: false,
    available: false,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: null, screenRecording: null },
  });
});
