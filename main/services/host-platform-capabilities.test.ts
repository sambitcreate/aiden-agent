import assert from "node:assert/strict";
import test from "node:test";

import { hostPlatformCapabilities } from "./host-platform-capabilities.js";

test("Darwin exposes Apple-owned host integrations", () => {
  assert.deepEqual(hostPlatformCapabilities("darwin", "arm64"), {
    platform: "darwin",
    bots: true,
    computerUse: true,
    botComputers: true,
    appleFoundationModels: true,
    accessibilityPaste: true,
    dictationHoldToTalk: true,
    dockIcon: true,
    nativeShare: true,
    macAppConnectors: true,
    backgroundJobs: true,
    hooks: true,
  });
});
test("Linux exposes Bots while keeping Apple-owned host integrations disabled", () => {
  assert.deepEqual(hostPlatformCapabilities("linux", "x64"), {
    platform: "linux",
    bots: true,
    computerUse: false,
    botComputers: false,
    appleFoundationModels: false,
    accessibilityPaste: false,
    dictationHoldToTalk: false,
    dockIcon: false,
    nativeShare: false,
    macAppConnectors: false,
    backgroundJobs: true,
    hooks: true,
  });
});

test("unsupported hosts cannot widen native capabilities", () => {
  const capabilities = hostPlatformCapabilities("win32", "arm64");
  assert.equal(capabilities.platform, "other");
  assert.equal(capabilities.bots, false);
  assert.equal(capabilities.computerUse, false);
  assert.equal(capabilities.botComputers, false);
  assert.equal(capabilities.dictationHoldToTalk, false);
  assert.equal(capabilities.macAppConnectors, false);
  assert.equal(capabilities.backgroundJobs, false);
  assert.equal(capabilities.hooks, false);
});

test("Bot computers need Apple silicon: Intel Macs and Linux on Arm get none", () => {
  assert.equal(hostPlatformCapabilities("darwin", "x64").botComputers, false);
  assert.equal(hostPlatformCapabilities("darwin", "x64").computerUse, true);
  assert.equal(hostPlatformCapabilities("linux", "arm64").botComputers, false);
});
