import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_LINUX_APT_SNAPSHOT,
  BOT_COMPUTER_LINUX_BASE_SIZE_BYTES,
  BOT_COMPUTER_LINUX_DISK_BYTES,
  BOT_COMPUTER_LINUX_IMAGE,
  BOT_COMPUTER_LINUX_MEMORY_BYTES,
  BOT_COMPUTER_MIN_HOST_MACOS,
  BOT_COMPUTER_RESTORE_IMAGE,
  compareMacosVersions,
  hostMacosSupportsBotComputers,
  hostMacosSupportsLinuxBotComputers,
} from "./release.js";
import { BOT_COMPUTERS_LINUX_FLAG, botComputersLinuxEnabled } from "./linux-feature-flag.js";

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

test("the Linux image pin is a fixed Debian 13 generic arm64 raw URL with verified hashes and a pinned snapshot", () => {
  const url = new URL(BOT_COMPUTER_LINUX_IMAGE.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "cloud.debian.org");
  assert.equal(url.search, "");
  assert.equal(BOT_COMPUTER_LINUX_IMAGE.distribution, "debian");
  assert.equal(BOT_COMPUTER_LINUX_IMAGE.version, "13");
  assert.equal(BOT_COMPUTER_LINUX_IMAGE.codename, "trixie");
  assert.equal(BOT_COMPUTER_LINUX_IMAGE.variant, "generic");
  assert.equal(BOT_COMPUTER_LINUX_IMAGE.architecture, "arm64");
  assert.ok(
    url.pathname.endsWith(
      `/${BOT_COMPUTER_LINUX_IMAGE.build}/debian-${BOT_COMPUTER_LINUX_IMAGE.version}-${BOT_COMPUTER_LINUX_IMAGE.variant}-${BOT_COMPUTER_LINUX_IMAGE.architecture}-${BOT_COMPUTER_LINUX_IMAGE.build}.raw`,
    ),
  );
  assert.match(BOT_COMPUTER_LINUX_IMAGE.sha256, /^[0-9a-f]{64}$/u);
  assert.match(BOT_COMPUTER_LINUX_IMAGE.sha512, /^[0-9a-f]{128}$/u);
  assert.ok(Number.isSafeInteger(BOT_COMPUTER_LINUX_IMAGE.bytes) && BOT_COMPUTER_LINUX_IMAGE.bytes >= 1024 ** 3);
  assert.ok(BOT_COMPUTER_LINUX_DISK_BYTES >= BOT_COMPUTER_LINUX_IMAGE.bytes);
  assert.equal(BOT_COMPUTER_LINUX_MEMORY_BYTES, 4 * 1024 ** 3);
  assert.equal(BOT_COMPUTER_LINUX_BASE_SIZE_BYTES, 8_000_000_000);
  assert.equal(hostMacosSupportsLinuxBotComputers("13.6.1"), false);
  assert.equal(hostMacosSupportsLinuxBotComputers("14.0"), true);
  assert.equal(hostMacosSupportsLinuxBotComputers("15.7.1"), true);
  assert.equal(hostMacosSupportsLinuxBotComputers("26.0"), true);
  assert.equal(hostMacosSupportsLinuxBotComputers(undefined), false);
  assert.equal(hostMacosSupportsLinuxBotComputers("garbage"), false);
  assert.ok(Object.isFrozen(BOT_COMPUTER_LINUX_IMAGE));

  const archive = new URL(BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl);
  const security = new URL(BOT_COMPUTER_LINUX_APT_SNAPSHOT.securityUrl);
  assert.equal(archive.protocol, "https:");
  assert.equal(archive.hostname, "snapshot.debian.org");
  assert.equal(security.protocol, "https:");
  assert.equal(security.hostname, "snapshot.debian.org");
  assert.match(BOT_COMPUTER_LINUX_APT_SNAPSHOT.date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(archive.pathname.endsWith(`/archive/debian/${BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveTimestamp}`));
  assert.ok(security.pathname.endsWith(`/archive/debian-security/${BOT_COMPUTER_LINUX_APT_SNAPSHOT.securityTimestamp}`));
  assert.ok(Object.isFrozen(BOT_COMPUTER_LINUX_APT_SNAPSHOT));
});

test("AIDEN_BOT_COMPUTERS_LINUX defaults to off and enables only for explicit 1 or true", () => {
  assert.equal(BOT_COMPUTERS_LINUX_FLAG, "AIDEN_BOT_COMPUTERS_LINUX");
  assert.equal(botComputersLinuxEnabled({}), false);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: "" }), false);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: "0" }), false);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: "false" }), false);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: "yes" }), false);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: "1" }), true);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: "true" }), true);
  assert.equal(botComputersLinuxEnabled({ [BOT_COMPUTERS_LINUX_FLAG]: " TRUE " }), true);
});
