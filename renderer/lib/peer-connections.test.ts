import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePeerHostStatus,
  mintPeerPairingAttemptId,
  peerDiscoveredRows,
  peerHostPresentation,
  peerLocalNameError,
  peerPairingOutcomeCopy,
} from "./peer-connections.js";
import {
  peerPairingAttemptId,
  type PeerDiscoveredDevice,
  type PeerHostStatus,
  type PeerHostView,
  type PeerSupervisorState,
} from "../shared/peer-host.js";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");

function host(overrides: Partial<PeerHostView> = {}): PeerHostView {
  return {
    id: "install_studio",
    name: "Studio Mac",
    enabled: true,
    state: "disconnected",
    features: [],
    capabilities: [],
    ...overrides,
  };
}

function status(state: PeerSupervisorState, generation = 1, hostId = "install_studio"): PeerHostStatus {
  return { hostId, generation, state, feed: "off", stale: false };
}

function device(id: string, overrides: Partial<PeerDiscoveredDevice> = {}): PeerDiscoveredDevice {
  return { id, name: id, route: "lan", pairingRequests: true, paired: false, ...overrides };
}

test("a turned-off host reads as off whatever its last supervisor status was", () => {
  const view = peerHostPresentation(
    host({ enabled: false }),
    status({ kind: "connected", since: NOW }),
    NOW,
  );
  assert.equal(view.label, "Off");
  assert.equal(view.canReconnect, false);
  assert.equal(view.needsRepair, false);
});

test("a backoff counts down to the next retry and offers reconnecting now", () => {
  const backoff = status({ kind: "backoff", attempt: 3, retryAt: NOW + 12_400 });
  const view = peerHostPresentation(host(), backoff, NOW);
  assert.equal(view.tone, "warning");
  assert.equal(view.canReconnect, true);
  assert.match(view.detail ?? "", /13 seconds/u);
  // A retry that is already due never reads as zero or negative.
  assert.match(peerHostPresentation(host(), backoff, NOW + 60_000).detail ?? "", /1 second\b/u);
});

test("only re-pairing is offered once access was revoked or the identity changed", () => {
  for (const reason of ["auth", "identity_changed"] as const) {
    const view = peerHostPresentation(host(), status({ kind: "blocked", reason }), NOW);
    assert.equal(view.tone, "red");
    assert.equal(view.needsRepair, true);
    assert.equal(view.canReconnect, false, reason);
  }
  const protocol = peerHostPresentation(host(), status({ kind: "blocked", reason: "protocol" }), NOW);
  assert.equal(protocol.needsRepair, false, "a version mismatch is fixed by updating, not pairing");
  assert.equal(protocol.canReconnect, true);
});

test("before the first status, the registry state decides and a live status overrides it", () => {
  assert.equal(peerHostPresentation(host({ state: "connected" }), undefined, NOW).tone, "green");
  assert.equal(peerHostPresentation(host({ state: "unavailable" }), undefined, NOW).canReconnect, true);
  assert.equal(
    peerHostPresentation(host({ state: "connected" }), status({ kind: "connecting", attempt: 1 }), NOW).label,
    "Connecting",
  );
});

test("status broadcasts never move a host back to an older generation", () => {
  const newer = status({ kind: "connected", since: NOW }, 5);
  const older = status({ kind: "backoff", attempt: 1, retryAt: NOW }, 4);
  const other = status({ kind: "connecting", attempt: 1 }, 1, "install_other");

  let statuses = mergePeerHostStatus(undefined, newer);
  statuses = mergePeerHostStatus(statuses, older);
  statuses = mergePeerHostStatus(statuses, other);
  assert.equal(statuses.find((entry) => entry.hostId === "install_studio")?.state.kind, "connected");
  assert.equal(statuses.length, 2);

  const later = status({ kind: "blocked", reason: "auth" }, 6);
  assert.equal(
    mergePeerHostStatus(statuses, later).find((entry) => entry.hostId === "install_studio")?.state.kind,
    "blocked",
  );
});

test("a cancelled attempt needs no message and every other ending explains itself", () => {
  assert.equal(peerPairingOutcomeCopy({ status: "cancelled" }), null);
  for (const outcome of [
    { status: "denied" },
    { status: "expired" },
    { status: "closed" },
    { status: "unsupported" },
    { status: "invalid_code" },
    { status: "rate_limited" },
  ] as const) {
    const copy = peerPairingOutcomeCopy(outcome);
    assert.ok(copy?.title && copy.message, outcome.status);
  }
  // Ways forward when the other device cannot take a request.
  assert.match(peerPairingOutcomeCopy({ status: "closed" })?.message ?? "", /setup code/u);
  assert.match(peerPairingOutcomeCopy({ status: "unsupported" })?.message ?? "", /setup code/u);
  assert.equal(
    peerPairingOutcomeCopy({ status: "failed", message: "A different device answered this request." })?.message,
    "A different device answered this request.",
  );
});

test("a rate limit names a readable wait", () => {
  assert.match(peerPairingOutcomeCopy({ status: "rate_limited", retryAfterSeconds: 1 })?.message ?? "", /1 second\./u);
  assert.match(peerPairingOutcomeCopy({ status: "rate_limited", retryAfterSeconds: 45 })?.message ?? "", /45 seconds/u);
  assert.match(peerPairingOutcomeCopy({ status: "rate_limited", retryAfterSeconds: 90 })?.message ?? "", /2 minutes/u);
});

test("discovered devices offer a request only when it can be answered, and never pair twice", () => {
  const rows = peerDiscoveredRows([
    device("install_open"),
    device("install_closed", { pairingRequests: false }),
    device("install_saved", { paired: true }),
  ]);
  const byId = new Map(rows.map((row) => [row.device.id, row]));
  assert.deepEqual(
    [byId.get("install_open")?.connect, byId.get("install_open")?.setupCode],
    [true, true],
  );
  assert.deepEqual(
    [byId.get("install_closed")?.connect, byId.get("install_closed")?.setupCode],
    [false, true],
  );
  assert.deepEqual(
    [byId.get("install_saved")?.connect, byId.get("install_saved")?.setupCode],
    [false, false],
  );
});

test("re-pairing lists only the host being replaced, even though it is already paired", () => {
  const rows = peerDiscoveredRows(
    [device("install_saved", { paired: true }), device("install_open")],
    "install_saved",
  );
  assert.deepEqual(
    rows.map((row) => [row.device.id, row.connect, row.setupCode]),
    [["install_saved", true, true]],
  );
});

test("local names are measured in Unicode characters, as main measures them", () => {
  assert.equal(peerLocalNameError("   "), "Enter a name.");
  assert.equal(peerLocalNameError("\u{1F5A5}".repeat(80)), null);
  assert.notEqual(peerLocalNameError("\u{1F5A5}".repeat(81)), null);
  assert.equal(peerLocalNameError("\u{1F469}‍\u{1F4BB} desk"), null);
  assert.equal(peerLocalNameError("Studio   upstairs"), null);
  assert.notEqual(peerLocalNameError("Studio\u0007"), null);
});

test("attempt IDs are fresh and accepted by main", () => {
  const first = mintPeerPairingAttemptId();
  assert.equal(peerPairingAttemptId(first), first);
  assert.notEqual(mintPeerPairingAttemptId(), first);
});
