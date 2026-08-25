import assert from "node:assert/strict";
import test from "node:test";
import type { AidenRemoteDeviceView } from "../shared/aiden-remote";
import {
  effectiveRemotePairingLifecycle,
  evaluateRemotePairingLifecycle,
  remotePairingPresentation,
} from "./remote-pairing-lifecycle";

function device(id: string, lastSeenAt: number, revokedAt?: number): AidenRemoteDeviceView {
  return {
    id,
    name: id,
    type: "iphone",
    clientVersion: "1",
    capabilities: [],
    createdAt: 10,
    lastSeenAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

test("only the exact main-owned pairing session and issued device can complete a dialog", () => {
  const unrelatedDevice = device("device_other", 20);
  assert.deepEqual(evaluateRemotePairingLifecycle({
    pairingSessionId: "pairing_current",
    status: { sessionId: "pairing_other", state: "finishing", deviceId: unrelatedDevice.id },
    devices: [unrelatedDevice],
  }), { state: "unrelated" });

  assert.deepEqual(evaluateRemotePairingLifecycle({
    pairingSessionId: "pairing_current",
    status: { sessionId: "pairing_current", state: "finishing", deviceId: "device_expected" },
    devices: [unrelatedDevice],
  }), { state: "finishing" });

  const pending = device("device_expected", 0);
  assert.equal(evaluateRemotePairingLifecycle({
    pairingSessionId: "pairing_current",
    status: { sessionId: "pairing_current", state: "finishing", deviceId: pending.id },
    devices: [pending, unrelatedDevice],
  }).state, "finishing");

  const connected = device("device_expected", 21);
  assert.deepEqual(evaluateRemotePairingLifecycle({
    pairingSessionId: "pairing_current",
    status: { sessionId: "pairing_current", state: "finishing", deviceId: connected.id },
    devices: [connected, unrelatedDevice],
  }), { state: "connected", device: connected });
});

test("failed, expired, absent, and revoked pairing states never report connected", () => {
  const revoked = device("device_expected", 20, 21);
  for (const state of ["failed", "expired"] as const) {
    assert.deepEqual(evaluateRemotePairingLifecycle({
      pairingSessionId: "pairing_current",
      status: { sessionId: "pairing_current", state },
      devices: [revoked],
    }), { state });
  }
  assert.deepEqual(evaluateRemotePairingLifecycle({
    pairingSessionId: "pairing_current",
    devices: [revoked],
  }), { state: "unrelated" });
  assert.equal(evaluateRemotePairingLifecycle({
    pairingSessionId: "pairing_current",
    status: { sessionId: "pairing_current", state: "finishing", deviceId: revoked.id },
    devices: [revoked],
  }).state, "cancelled");
});

test("finishing presentation retains a disabled QR and ignores the elapsed bootstrap clock", () => {
  assert.deepEqual(remotePairingPresentation({ state: "finishing" }, 0), {
    badge: "Finishing connection",
    tone: "blue",
    qrDisabled: true,
  });
  assert.deepEqual(remotePairingPresentation({ state: "awaiting_scan" }, 61), {
    badge: "Expires in 1:01",
    tone: "blue",
    qrDisabled: false,
  });
});

test("an elapsed unconsumed pairing becomes expired without changing finishing work", () => {
  assert.deepEqual(effectiveRemotePairingLifecycle({ state: "awaiting_scan" }, 0), {
    state: "expired",
  });
  assert.deepEqual(effectiveRemotePairingLifecycle({ state: "awaiting_scan" }, -1), {
    state: "expired",
  });
  assert.deepEqual(effectiveRemotePairingLifecycle({ state: "awaiting_scan" }, 1), {
    state: "awaiting_scan",
  });
  assert.deepEqual(effectiveRemotePairingLifecycle({ state: "finishing" }, 0), {
    state: "finishing",
  });
});
