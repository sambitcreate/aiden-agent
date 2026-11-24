import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_LINUX_APT_SNAPSHOT,
  BOT_COMPUTER_LINUX_BASE_SIZE_BYTES,
  BOT_COMPUTER_LINUX_DISK_BYTES,
  BOT_COMPUTER_LINUX_IMAGE,
  BOT_COMPUTER_LINUX_MEMORY_BYTES,
  BOT_COMPUTER_MIN_HOST_MACOS,
  compareMacosVersions,
  hostMacosSupportsBotComputers,
} from "./release.js";

test("Bot computers require macOS 14 or later on Apple silicon", () => {
  assert.equal(BOT_COMPUTER_MIN_HOST_MACOS, "14.0");
  assert.equal(hostMacosSupportsBotComputers("13.6.1"), false);
  assert.equal(hostMacosSupportsBotComputers("14.0"), true);
  assert.equal(hostMacosSupportsBotComputers("15.7.1"), true);
  assert.equal(hostMacosSupportsBotComputers("26.0"), true);
  assert.equal(hostMacosSupportsBotComputers(undefined), false);
  assert.equal(hostMacosSupportsBotComputers("garbage"), false);
  assert.equal(compareMacosVersions("14.10", "14.9"), 1);
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
