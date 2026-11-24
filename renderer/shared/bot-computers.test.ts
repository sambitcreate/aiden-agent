import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_VIEWER_HOST_ID,
  botComputerMaxRunningChoices,
  botComputerSetupSummary,
  botComputersMigrationNoticeText,
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

test("settings patch, status parser, setup summary, and migration notice cover Linux maxRunning 1–4", () => {
  assert.deepEqual(botComputerMaxRunningChoices(), [1, 2, 3, 4]);
  assert.deepEqual(botComputerMaxRunningChoices(2), [1, 2]);
  assert.deepEqual(botComputerMaxRunningChoices(1), [1]);

  assert.throws(() => parseBotComputersSettingsPatch({ maxRunning: 5 }), /At most 4/u);
  assert.deepEqual(parseBotComputersSettingsPatch({ maxRunning: 4 }, 4), { maxRunning: 4 });
  assert.throws(() => parseBotComputersSettingsPatch({ maxRunning: 4 }, 3), /At most 3/u);
  assert.throws(() => parseBotComputersSettingsPatch({ maxRunning: 2 }, 1), /At most one/u);

  const linuxStatus = parseBotComputersStatus({
    setup: { kind: "ready", baseVersion: "13", baseBuild: "20261123-2671", updateAvailable: false },
    settings: { maxRunning: 4, idleStopMinutes: 10 },
    diskUsedBytes: 0,
    computers: [],
    requirements: {
      downloadBytes: 3_221_225_472,
      baseDiskBytes: 8_000_000_000,
      setupFreeBytes: 24_696_061_952,
      memoryPerComputerBytes: 4 * 1024 ** 3,
      baseVersion: "13",
      maxRunningLimit: 4,
    },
    migrationNotice: { freedBytes: 58_000_000_000 },
  });
  assert.equal(linuxStatus?.settings.maxRunning, 4);
  assert.equal(linuxStatus?.requirements.maxRunningLimit, 4);
  assert.deepEqual(linuxStatus?.migrationNotice, { freedBytes: 58_000_000_000 });
  assert.equal(
    parseBotComputersStatus({
      setup: { kind: "not_set_up" },
      settings: { maxRunning: 5, idleStopMinutes: 10 },
      diskUsedBytes: 0,
      computers: [],
      requirements: {
        downloadBytes: 3_221_225_472,
        baseDiskBytes: 8_000_000_000,
        setupFreeBytes: 24_696_061_952,
        memoryPerComputerBytes: 4 * 1024 ** 3,
        baseVersion: "13",
        maxRunningLimit: 4,
      },
    }),
    undefined,
    "status rejects maxRunning > 4",
  );

  assert.equal(
    botComputerSetupSummary({ kind: "unsupported", reason: "host_os" }),
    "Bot computers need macOS 14 or later on this Mac.",
  );
  assert.equal(
    botComputerSetupSummary({ kind: "building_base", step: "create" }),
    "Setting up Debian Linux on the base computer…",
  );
  assert.equal(
    botComputerSetupSummary({ kind: "ready", baseVersion: "13", baseBuild: "20261123-2671", updateAvailable: false }),
    "Ready (Debian 13).",
  );
  assert.equal(
    botComputerSetupSummary({ kind: "ready", baseVersion: "13", baseBuild: "20261123-2671", updateAvailable: true }),
    "Ready. A newer base (Debian 13) is available.",
  );
  assert.equal(
    botComputersMigrationNoticeText(58_000_000_000),
    "Bot computers now run Linux. Your Mac computers were removed and freed 58 GB. Set up to continue.",
  );
  assert.equal(
    botComputersMigrationNoticeText(0),
    "Bot computers now run Linux. Your Mac computers were removed. Set up to continue.",
  );
});
