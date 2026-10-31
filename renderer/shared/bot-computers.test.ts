import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_VIEWER_HOST_ID,
  parseBotComputerPointer,
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
