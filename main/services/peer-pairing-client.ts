import { randomBytes } from "node:crypto";
import type { PeerPairingFailure } from "../../renderer/shared/peer-host.js";
import { sanitizePairingRequestDeviceName } from "./aiden-remote-pairing-requests.js";
import {
  AIDEN_PAIRING_REQUEST_ID_PATTERN,
  generatePairingRequestKeyPair,
  PAIRING_NONCE_BYTES,
  pairingRequestCommitment,
  pairingRequestMatchCode,
} from "./aiden-remote-sealed-envelope.js";
import type { PeerBootstrapClient } from "./peer-bootstrap-transport.js";
import {
  openPeerPairingRequestGrant,
  peerRecord,
  peerText,
  type PeerPairingRequestGrant,
} from "./peer-pairing.js";
import { PeerTransportError } from "./peer-transport.js";

export type { PeerPairingFailure };

export class PeerPairingOutcomeError extends Error {
  constructor(readonly outcome: PeerPairingFailure) {
    super(
      outcome.status === "failed" ? outcome.message : `Pairing ${outcome.status}.`,
    );
  }
}

/** The host holds a poll for at most 25 s; allow for latency before giving up on one. */
const POLL_TIMEOUT_MS = 35_000;
const CANCEL_TIMEOUT_MS = 3_000;
/** Consecutive transport failures tolerated while long-polling. */
const MAX_POLL_FAILURES = 3;
const POLL_RETRY_MS = 1_000;
/** The host's TTL is 2 minutes; stop polling shortly after the stated expiry. */
const EXPIRY_GRACE_MS = 15_000;

export interface PeerPairingRequestInput<T> {
  /** The bootstrap session for the address the user picked. */
  session: PeerBootstrapClient;
  /** The installation the user picked; the grant must name it. */
  instanceId: string;
  /**
   * The exact endpoint a Tailscale grant must name. LAN grants carry the
   * host's canonical `.local` address instead, and are bound by the SPKI.
   */
  endpoint?: string;
  deviceName: string;
  deviceType: "mac" | "linux";
  clientVersion: string;
  signal: AbortSignal;
  /** Called once both screens can show the same code. */
  onMatchCode(code: string, expiresAt: string): void;
  /**
   * Confirm and save the opened grant. Until this resolves the request is
   * still withdrawn on any failure or cancel, which revokes the credential
   * on the other device, so a pairing this device never saved leaves no
   * working credential behind.
   */
  install(grant: PeerPairingRequestGrant): Promise<T>;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Map a refusal from a pairing route to a typed outcome. */
export function peerPairingFailure(error: unknown): PeerPairingFailure {
  if (error instanceof PeerPairingOutcomeError) return error.outcome;
  if (error instanceof PeerTransportError) {
    switch (error.remote?.code) {
      case "rate_limited":
        return {
          status: "rate_limited",
          ...(error.remote.details?.retryAfterSeconds
            ? { retryAfterSeconds: error.remote.details.retryAfterSeconds }
            : {}),
        };
      case "pairing_closed":
      case "capability_denied":
        return { status: "closed" };
      case "pairing_expired":
        return { status: "expired" };
      case "pairing_already_used":
        return {
          status: "failed",
          message: "That code was already used. Ask the other device for a new one.",
        };
      default:
        break;
    }
    if (error.code === "identity_changed")
      return {
        status: "failed",
        message: "The other device's identity changed during pairing. Try again.",
      };
    if (error.code === "unavailable")
      return {
        status: "failed",
        message: "The other device could not be reached.",
      };
  }
  return {
    status: "failed",
    message: "The other device could not complete pairing.",
  };
}

function clientVersion(value: string): string | undefined {
  return /^[\x21-\x7e]{1,40}$/u.test(value) ? value : undefined;
}

function deny(outcome: PeerPairingFailure): never {
  throw new PeerPairingOutcomeError(outcome);
}

/**
 * Ask another desktop to pair with this one, wait for its answer and
 * install the grant. Resolves with what `install` returns once the other
 * device allows it and the grant is installed. Every other ending throws
 * `PeerPairingOutcomeError` and withdraws the request.
 */
export async function requestPeerPairing<T>(input: PeerPairingRequestInput<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? sleepFor;
  const { session, signal } = input;
  const keys = generatePairingRequestKeyPair();
  let created: { requestId: string; pollSecret: string; expiresAt: string } | undefined;
  try {
    if (signal.aborted) deny({ status: "cancelled" });
    const version = clientVersion(input.clientVersion);
    let response: Record<string, unknown>;
    try {
      response = peerRecord(
        await session.json({
          method: "POST",
          path: "/pairing/requests",
          signal,
          body: {
            deviceName:
              sanitizePairingRequestDeviceName(input.deviceName) ?? "Aiden desktop",
            deviceType: input.deviceType,
            publicKey: keys.publicKey,
            ...(version ? { clientVersion: version } : {}),
          },
        }),
      );
    } catch (error) {
      // An older Aiden has no request routes and answers 404.
      if (error instanceof PeerTransportError && error.status === 404)
        deny({ status: "unsupported" });
      throw error;
    }
    const requestId = peerText(response.requestId, 64);
    const pollSecret = peerText(response.pollSecret, 43);
    const expiresAt = peerText(response.expiresAt, 40);
    const hostCommitment = peerText(response.hostCommitment, 43);
    if (
      !AIDEN_PAIRING_REQUEST_ID_PATTERN.test(requestId) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(pollSecret) ||
      !Number.isFinite(Date.parse(expiresAt))
    )
      throw new Error("Invalid pairing request.");
    created = { requestId, pollSecret, expiresAt };
    const serverSpkiSha256 = session.observedSpki;
    if (!serverSpkiSha256) throw new Error("No server identity was observed.");

    const requesterNonce = randomBytes(PAIRING_NONCE_BYTES);
    const revealed = peerRecord(
      await session.json({
        method: "POST",
        path: `/pairing/requests/${requestId}/reveal`,
        pairingSecret: pollSecret,
        signal,
        body: { requesterNonce: requesterNonce.toString("base64url") },
      }),
    );
    const hostNonce = peerText(revealed.hostNonce, 43);
    // The host committed to its nonce before seeing ours.
    if (pairingRequestCommitment(requestId, hostNonce) !== hostCommitment)
      deny({
        status: "failed",
        message: "The other device's answer did not match its commitment.",
      });
    input.onMatchCode(
      pairingRequestMatchCode({
        requesterPublicKey: keys.publicKey,
        serverSpkiSha256,
        requestId,
        requesterNonce,
        hostNonce,
      }),
      expiresAt,
    );

    const deadline = Date.parse(expiresAt) + EXPIRY_GRACE_MS;
    let failures = 0;
    for (;;) {
      if (signal.aborted) deny({ status: "cancelled" });
      if (now() > deadline) deny({ status: "expired" });
      const started = now();
      let status: Record<string, unknown>;
      try {
        status = peerRecord(
          await session.json({
            path: `/pairing/requests/${requestId}`,
            pairingSecret: pollSecret,
            signal,
            timeoutMs: POLL_TIMEOUT_MS,
          }),
        );
        failures = 0;
      } catch (error) {
        if (signal.aborted) deny({ status: "cancelled" });
        // A request the host already purged answers 404.
        if (error instanceof PeerTransportError && error.status === 404)
          deny({ status: "expired" });
        if (
          error instanceof PeerTransportError &&
          error.code === "unavailable" &&
          ++failures < MAX_POLL_FAILURES
        ) {
          await sleep(POLL_RETRY_MS, signal);
          continue;
        }
        throw error;
      }
      if (status.requestId !== requestId) throw new Error("Invalid pairing status.");
      switch (status.state) {
        case "pending": {
          // A host that answers at once instead of holding the poll is paced.
          const elapsed = now() - started;
          if (elapsed < POLL_RETRY_MS) await sleep(POLL_RETRY_MS - elapsed, signal);
          continue;
        }
        case "denied":
          return deny({ status: "denied" });
        case "expired":
          return deny({ status: "expired" });
        case "cancelled":
          return deny({ status: "cancelled" });
        case "approved": {
          const grant = openPeerPairingRequestGrant(status.envelope, {
            requestId,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            ...(input.endpoint ? { endpoint: input.endpoint } : {}),
            serverSpkiSha256,
          });
          if (grant.instanceId !== input.instanceId)
            deny({
              status: "failed",
              message: "A different device answered this request.",
            });
          const installed = await input.install(grant);
          created = undefined;
          return installed;
        }
        default:
          throw new Error("Invalid pairing status.");
      }
    }
  } catch (error) {
    if (signal.aborted) throw new PeerPairingOutcomeError({ status: "cancelled" });
    if (error instanceof PeerPairingOutcomeError) throw error;
    throw new PeerPairingOutcomeError(peerPairingFailure(error));
  } finally {
    // Withdraw the request so the other device's prompt closes, or, once
    // it was allowed, so the credential this device did not install is
    // revoked there.
    if (created) {
      const { requestId, pollSecret } = created;
      void session
        .json({
          method: "DELETE",
          path: `/pairing/requests/${requestId}`,
          pairingSecret: pollSecret,
          timeoutMs: CANCEL_TIMEOUT_MS,
        })
        .catch(() => undefined);
    }
  }
}
