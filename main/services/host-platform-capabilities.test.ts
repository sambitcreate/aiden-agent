import assert from "node:assert/strict";
import test from "node:test";

import { hostPlatformCapabilities } from "./host-platform-capabilities.js";

test("Darwin exposes Apple-owned host integrations", () => {
  assert.deepEqual(hostPlatformCapabilities("darwin"), {
    platform: "darwin",
    bots: true,
    computerUse: true,
    appleFoundationModels: true,
    accessibilityPaste: true,
    dictationHoldToTalk: true,
    dockIcon: true,
    nativeShare: true,
  });
});
test("Linux exposes Bots while keeping Apple-owned host integrations disabled", () => {
  assert.deepEqual(hostPlatformCapabilities("linux"), {
    platform: "linux",
    bots: true,
    computerUse: false,
    appleFoundationModels: false,
    accessibilityPaste: false,
    dictationHoldToTalk: false,
    dockIcon: false,
    nativeShare: false,
  });
});

test("unsupported hosts cannot widen native capabilities", () => {
  const capabilities = hostPlatformCapabilities("win32");
  assert.equal(capabilities.platform, "other");
  assert.equal(capabilities.bots, false);
  assert.equal(capabilities.computerUse, false);
  assert.equal(capabilities.dictationHoldToTalk, false);
});
