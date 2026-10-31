import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_MIN_HOST_MACOS,
  BOT_COMPUTER_RESTORE_IMAGE,
  compareMacosVersions,
  hostMacosSupportsBotComputers,
} from "./release.js";

test("the restore image pin is a fixed https URL on Apple's update CDN with a size and SHA-256", () => {
  const url = new URL(BOT_COMPUTER_RESTORE_IMAGE.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "updates.cdn-apple.com");
  assert.equal(url.search, "");
  assert.ok(url.pathname.endsWith(`_${BOT_COMPUTER_RESTORE_IMAGE.version}_${BOT_COMPUTER_RESTORE_IMAGE.build}_Restore.ipsw`));
  assert.match(BOT_COMPUTER_RESTORE_IMAGE.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(BOT_COMPUTER_RESTORE_IMAGE.bytes) && BOT_COMPUTER_RESTORE_IMAGE.bytes > 10_000_000_000);
  assert.ok(Object.isFrozen(BOT_COMPUTER_RESTORE_IMAGE));
});

test("the guest is never a newer major macOS than the host", () => {
  const guestMajor = BOT_COMPUTER_RESTORE_IMAGE.version.split(".")[0];
  assert.equal(BOT_COMPUTER_MIN_HOST_MACOS.split(".")[0], guestMajor);
  assert.equal(hostMacosSupportsBotComputers("15.7.1"), false);
  assert.equal(hostMacosSupportsBotComputers("26.0"), true);
  assert.equal(hostMacosSupportsBotComputers("26.0.1"), true);
  assert.equal(hostMacosSupportsBotComputers("27.1"), true);
  assert.equal(hostMacosSupportsBotComputers(undefined), false);
  assert.equal(hostMacosSupportsBotComputers("garbage"), false);
  assert.equal(compareMacosVersions("26.10", "26.9"), 1);
});
