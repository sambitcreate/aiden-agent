import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_VIEWER_HOST_ID,
  botComputerMaxRunningChoices,
  botComputerSetupSummary,
  parseBotComputerPointer,
  parseBotComputersSettingsPatch,
  parseBotComputersStatus,
  parseBotComputerViewerGrant,
  parseBotComputerViewerRequest,
} from "./bot-computers.js";

const NOW = 1_800_000_000_000;
const grant = (overrides: Record<string, unknown> = {}) => ({
  hostId: BOT_COMPUTER_VIEWER_HOST_ID,
  deviceId: "aiden-bot-0123456789abcdef",
  grant: { origin: "http://127.0.0.1:52100", token: "a".repeat(43), expiresAt: NOW + 60_000 },
  ...overrides,
});

test("the renderer takes a viewer grant only for the viewer host, a device id and a live loopback grant", () => {
  assert.deepEqual(parseBotComputerViewerGrant(grant(), NOW), grant());
  assert.equal(parseBotComputerViewerGrant(grant({ hostId: "local" }), NOW), undefined, "the Simulator's host");
  assert.equal(parseBotComputerViewerGrant(grant({ deviceId: "../vm" }), NOW), undefined);
  assert.equal(
    parseBotComputerViewerGrant(grant({ grant: { origin: "http://192.168.1.4:52100", token: "a".repeat(43), expiresAt: NOW + 1 } }), NOW),
    undefined,
    "not loopback",
  );
  assert.equal(parseBotComputerViewerGrant(grant(), NOW + 60_000), undefined, "expired");
  assert.equal(parseBotComputerViewerGrant(null, NOW), undefined);
});

test("the viewer request is { start } and nothing else", () => {
  assert.deepEqual(parseBotComputerViewerRequest(undefined), { start: false });
  assert.deepEqual(parseBotComputerViewerRequest({}), { start: false });
  assert.deepEqual(parseBotComputerViewerRequest({ start: true }), { start: true });
  for (const bad of [{ start: 1 }, { start: true, vmName: "x" }, [], "start", null]) {
    assert.throws(() => parseBotComputerViewerRequest(bad), /start: boolean/u);
  }
});

test("a pointer must sit inside its screen", () => {
  assert.deepEqual(parseBotComputerPointer({ x: 0, y: 768, width: 1024, height: 768 }), { x: 0, y: 768, width: 1024, height: 768 });
  assert.equal(parseBotComputerPointer({ x: 1025, y: 0, width: 1024, height: 768 }), null);
  assert.equal(parseBotComputerPointer({ x: -1, y: 0, width: 1024, height: 768 }), null);
  assert.equal(parseBotComputerPointer({ x: 1, y: 1, width: 0, height: 768 }), null);
  assert.equal(parseBotComputerPointer({ x: 1, y: 1, width: 1024, height: Number.NaN }), null);
  assert.equal(parseBotComputerPointer(null), null);
});

test("settings patch and status parser support Linux maxRunning up to 4 while keeping macOS capped at 2", () => {
  assert.deepEqual(botComputerMaxRunningChoices(), [1, 2]);
  assert.deepEqual(botComputerMaxRunningChoices(4), [1, 2, 3, 4]);
  assert.deepEqual(botComputerMaxRunningChoices(1), [1]);

  assert.throws(() => parseBotComputersSettingsPatch({ maxRunning: 3 }), /one or two/u);
  assert.deepEqual(parseBotComputersSettingsPatch({ maxRunning: 4 }, 4), { maxRunning: 4 });
  assert.throws(() => parseBotComputersSettingsPatch({ maxRunning: 4 }, 3), /At most 3/u);
  assert.throws(() => parseBotComputersSettingsPatch({ maxRunning: 2 }, 1), /At most one/u);

  const macBase = {
    setup: { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false },
    settings: { maxRunning: 3, idleStopMinutes: 10 },
    diskUsedBytes: 0,
    computers: [],
    requirements: {
      downloadBytes: 19_772_231_540,
      baseDiskBytes: 50_000_000_000,
      setupFreeBytes: 84_196_731_252,
      memoryPerComputerBytes: 8 * 1024 ** 3,
      baseVersion: "26.6.2",
    },
  };
  assert.equal(parseBotComputersStatus(macBase), undefined, "macOS status rejects maxRunning > 2");

  const linuxStatus = parseBotComputersStatus({
    ...macBase,
    setup: { kind: "ready", baseVersion: "13", baseBuild: "20261123-2671", updateAvailable: false },
    settings: { maxRunning: 4, idleStopMinutes: 10 },
    requirements: {
      downloadBytes: 3_221_225_472,
      baseDiskBytes: 8_000_000_000,
      setupFreeBytes: 20_401_094_656,
      memoryPerComputerBytes: 4 * 1024 ** 3,
      baseVersion: "13",
      guestOs: "linux",
      maxRunningLimit: 4,
    },
  });
  assert.equal(linuxStatus?.settings.maxRunning, 4);
  assert.equal(linuxStatus?.requirements.guestOs, "linux");
  assert.equal(linuxStatus?.requirements.maxRunningLimit, 4);

  assert.equal(botComputerSetupSummary({ kind: "unsupported", reason: "host_os" }), "Bot computers need macOS 26 or later on this Mac.");
  assert.equal(
    botComputerSetupSummary({ kind: "unsupported", reason: "host_os" }, "linux"),
    "Bot computers need macOS 14 or later on this Mac.",
  );
  assert.equal(
    botComputerSetupSummary({ kind: "building_base", step: "create" }, "linux"),
    "Setting up Debian Linux on the base computer…",
  );
  assert.equal(
    botComputerSetupSummary({ kind: "ready", baseVersion: "13", baseBuild: "20261123-2671", updateAvailable: false }, "linux"),
    "Ready (Debian 13).",
  );
  assert.equal(
    botComputerSetupSummary({ kind: "ready", baseVersion: "13", baseBuild: "20261123-2671", updateAvailable: true }, "linux"),
    "Ready. A newer base (Debian 13) is available.",
  );
});
