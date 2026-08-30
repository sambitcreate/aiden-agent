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
test("Linux fails closed for Apple-owned host integrations", () => {
  assert.deepEqual(hostPlatformCapabilities("linux"), {
    platform: "linux",
    bots: false,
    computerUse: false,
    appleFoundationModels: false,
    accessibilityPaste: false,
    dictationHoldToTalk: false,
    dockIcon: false,
    nativeShare: false,
  });
});
