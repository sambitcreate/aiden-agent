import assert from "node:assert/strict";
import test from "node:test";
import type { AidenRemoteDeviceView } from "../shared/aiden-remote";
import {
  REMOTE_DEVICE_ACTIVE_WINDOW_MS,
  groupRemoteDevices,
  remoteConnectionSummary,
} from "./remote-connection-status";

const NOW = 2_000_000;

function device(
  id: string,
  lastSeenAt: number,
  revokedAt?: number,
): AidenRemoteDeviceView {
  return {
    id,
    name: id,
    type: "iphone",
    clientVersion: "1",
    capabilities: [],
    createdAt: 1,
    lastSeenAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

test("groups recent, inactive, and revoked devices without overstating an offline service", () => {
  const devices = [
    device("recent", NOW - REMOTE_DEVICE_ACTIVE_WINDOW_MS),
    device("pending", 0),
    device("inactive", NOW - REMOTE_DEVICE_ACTIVE_WINDOW_MS - 1),
    device("revoked", NOW - 10, NOW - 5),
  ];

  const running = groupRemoteDevices(devices, { now: NOW, serviceRunning: true });
  assert.deepEqual(running.active.map(({ id }) => id), ["recent"]);
  assert.deepEqual(running.pending.map(({ id }) => id), ["pending"]);
  assert.deepEqual(running.inactive.map(({ id }) => id), ["inactive"]);
  assert.deepEqual(running.previous.map(({ id }) => id), ["revoked"]);

  const stopped = groupRemoteDevices(devices, { now: NOW, serviceRunning: false });
  assert.deepEqual(stopped.active, []);
  assert.deepEqual(stopped.pending.map(({ id }) => id), ["pending"]);
  assert.deepEqual(stopped.inactive.map(({ id }) => id), ["recent", "inactive"]);
});

test("connection summary favors actionable service state over device counts", () => {
  assert.equal(remoteConnectionSummary({ enabled: false, running: false, activeDeviceCount: 2 }), "Off");
  assert.equal(remoteConnectionSummary({ enabled: true, running: false, activeDeviceCount: 2 }), "Needs attention");
  assert.equal(remoteConnectionSummary({ enabled: true, running: true, activeDeviceCount: 0 }), "Ready for a device");
  assert.equal(remoteConnectionSummary({ enabled: true, running: true, activeDeviceCount: 2 }), "2 active");
});
