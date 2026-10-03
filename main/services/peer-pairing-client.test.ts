import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { pairingRequestCommitment } from "./aiden-remote-sealed-envelope.js";
import type { PeerBootstrapClient, PeerBootstrapRequest } from "./peer-bootstrap-transport.js";
import {
  PeerPairingOutcomeError,
  requestPeerPairing,
  type PeerPairingFailure,
} from "./peer-pairing-client.js";
import { peerStatusError, PeerTransportError } from "./peer-transport.js";

const REQUEST_ID = `pairreq_${"A".repeat(32)}`;
const SPKI = `sha256/${"B".repeat(43)}=`;
const EXPIRES_AT = "2026-10-03T12:02:00.000Z";
const START = Date.parse("2026-10-03T12:00:00.000Z");

type Reply = unknown | PeerTransportError | ((request: PeerBootstrapRequest) => unknown);

/** A host that answers poll requests from a script, recording every request. */
function scriptedHost(polls: Reply[], options: { commitment?: string; create?: Reply } = {}) {
  const hostNonce = randomBytes(32).toString("base64url");
  const sent: PeerBootstrapRequest[] = [];
  const answer = async (reply: Reply, request: PeerBootstrapRequest) => {
    const value = typeof reply === "function" ? reply(request) : reply;
    if (value instanceof Error) throw value;
    return value;
  };
  const session: PeerBootstrapClient = {
    observedSpki: SPKI,
    json: async (request) => {
      sent.push(request);
      if (request.method === "POST" && request.path === "/pairing/requests")
        return answer(
          options.create ?? {
            requestId: REQUEST_ID,
            pollSecret: "s".repeat(43),
            expiresAt: EXPIRES_AT,
            hostCommitment:
              options.commitment ?? pairingRequestCommitment(REQUEST_ID, hostNonce),
          },
          request,
        );
      if (request.method === "POST") return { hostNonce };
      if (request.method === "DELETE") return { state: "cancelled" };
      const reply = polls.shift();
      if (reply === undefined) throw new Error("The script ran out of poll replies.");
      return answer(reply, request);
    },
  };
  return { session, sent, polls: () => sent.filter((entry) => !entry.method) };
}

function run(host: ReturnType<typeof scriptedHost>, clock = { now: START }, signal = new AbortController().signal) {
  const codes: string[] = [];
  const pending = requestPeerPairing({
    session: host.session,
    instanceId: "install_host",
    deviceName: "Travel MacBook",
    deviceType: "mac",
    clientVersion: "0.60.0",
    signal,
    onMatchCode: (code) => codes.push(code),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  return { codes, pending };
}

async function outcome(promise: Promise<unknown>): Promise<PeerPairingFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PeerPairingOutcomeError, String(error));
    return error.outcome;
  }
  assert.fail("expected pairing to end without a grant");
}

const deleted = (host: ReturnType<typeof scriptedHost>) =>
  host.sent.filter((request) => request.method === "DELETE").length;

test("a host whose nonce breaks its commitment shows no code and the request is withdrawn", async () => {
  const host = scriptedHost([], { commitment: "c".repeat(43) });
  const { codes, pending } = run(host);
  assert.equal((await outcome(pending)).status, "failed");
  assert.deepEqual(codes, []);
  assert.equal(host.polls().length, 0);
  assert.equal(deleted(host), 1);
});

test("a decision on the other device ends the wait with its own outcome", async () => {
  for (const state of ["denied", "expired", "cancelled"] as const) {
    const host = scriptedHost([{ requestId: REQUEST_ID, state: "pending" }, { requestId: REQUEST_ID, state }]);
    const { codes, pending } = run(host);
    assert.deepEqual(await outcome(pending), { status: state });
    assert.match(codes[0] ?? "", /^\d{6}$/u);
    assert.equal(host.polls().length, 2);
  }
});

test("brief outages are retried, a purged request reads as expired, and a lasting outage fails", async () => {
  const outage = () => new PeerTransportError("unavailable");
  const recovered = scriptedHost([outage(), outage(), new PeerTransportError("unavailable", 404)]);
  assert.deepEqual(await outcome(run(recovered).pending), { status: "expired" });
  assert.equal(recovered.polls().length, 3);

  const lasting = scriptedHost([outage(), outage(), outage(), { requestId: REQUEST_ID, state: "approved" }]);
  assert.equal((await outcome(run(lasting).pending)).status, "failed");
  assert.equal(lasting.polls().length, 3, "the third consecutive failure ends the wait");
  assert.equal(deleted(lasting), 1);
});

test("a host that never holds the poll is paced and the wait ends after the stated expiry", async () => {
  const clock = { now: START };
  const pending = () => ({ requestId: REQUEST_ID, state: "pending" });
  const host = scriptedHost(Array.from({ length: 1_000 }, pending));
  assert.deepEqual(await outcome(run(host, clock).pending), { status: "expired" });
  const window = Date.parse(EXPIRES_AT) - START;
  // About one poll a second for the two-minute window plus its grace period.
  assert.ok(host.polls().length <= window / 1_000 + 16, `${host.polls().length} polls`);
  assert.ok(clock.now > Date.parse(EXPIRES_AT));
  assert.equal(deleted(host), 1);
});

test("refusals before a request exists are typed and leave nothing to withdraw", async () => {
  const limited = new PeerTransportError("unavailable", 429, {
    code: "rate_limited",
    retryable: true,
    details: { retryAfterSeconds: 42 },
  });
  const busy = scriptedHost([], { create: limited });
  assert.deepEqual(await outcome(run(busy).pending), {
    status: "rate_limited",
    retryAfterSeconds: 42,
  });
  assert.equal(deleted(busy), 0);

  const older = scriptedHost([], { create: new PeerTransportError("unavailable", 404) });
  assert.deepEqual(await outcome(run(older).pending), { status: "unsupported" });

  // A host that turned requests off, or whose profile forbids them, reads as closed.
  for (const code of ["pairing_closed", "capability_denied"]) {
    const closed = scriptedHost([], {
      create: peerStatusError(403, { code, retryable: false }),
    });
    assert.deepEqual(await outcome(run(closed).pending), { status: "closed" });
    assert.equal(deleted(closed), 0);
  }
});

test("cancelling while waiting withdraws the request", async () => {
  const controller = new AbortController();
  const host = scriptedHost([
    () => {
      controller.abort();
      return new PeerTransportError("unavailable");
    },
  ]);
  assert.deepEqual(await outcome(run(host, { now: START }, controller.signal).pending), {
    status: "cancelled",
  });
  assert.equal(deleted(host), 1);
});
