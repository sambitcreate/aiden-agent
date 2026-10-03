import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import { normalizeAidenManualPairingCode } from "./aiden-remote-pairing.js";
import { parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import type { KeyObject } from "node:crypto";
import {
  AIDEN_PAIRING_GRANT_KIND,
  hkdfSha256,
  openAesGcm,
  openPairingRequestEnvelope,
} from "./aiden-remote-sealed-envelope.js";
import { validatePeerTrust, type PeerTrust } from "./peer-transport.js";

export function peerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid peer response.");
  return value as Record<string, unknown>;
}

export function peerText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new Error("Invalid peer text.");
  return value;
}

export function peerStrings(value: unknown, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("Invalid peer capabilities.");
  return [...new Set(value.map((item) => peerText(item, 80)))];
}

export interface PeerPairing extends PeerTrust {
  instanceId: string;
  secret: string;
  expiresAt: string;
}

/** Server exchange remains authoritative; tolerate two minutes of client clock skew. */
export function assertPeerPairingExpiry(
  expiresAt: string,
  now = Date.now(),
): void {
  const expiry = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry < now - 120_000 ||
    expiry > now + 420_000
  )
    throw new Error("Pairing code expired or invalid.");
}

export function parsePeerPairing(
  payload: string,
  now = Date.now(),
): PeerPairing {
  if (Buffer.byteLength(payload) > 4096)
    throw new Error("Pairing payload is too large.");
  const record = peerRecord(parseAidenRemoteJson(payload, "pairing payload"));
  if (record.kind !== "aiden-pairing-v1")
    throw new Error("Invalid pairing payload.");
  const bootstrap = peerRecord(record.bootstrap);
  const trust = peerRecord(record.trust);
  if (
    bootstrap.protocolVersion !== 1 ||
    (trust.mode !== "private-ca" && trust.mode !== "system")
  )
    throw new Error("Unsupported pairing protocol.");
  const expiresAt = peerText(bootstrap.expiresAt, 40);
  assertPeerPairingExpiry(expiresAt, now);
  const secret = peerText(bootstrap.secret, 43);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret))
    throw new Error("Invalid pairing secret.");
  return {
    ...validatePeerTrust({
      endpoint: peerText(bootstrap.endpoint, 2048),
      serverSpkiSha256: peerText(bootstrap.serverSpkiSha256, 51),
      ...(trust.mode === "private-ca"
        ? {
            caCertificateDerBase64: peerText(
              trust.caCertificateDerBase64,
              8192,
            ),
          }
        : {}),
    }),
    instanceId: hostIdentifier(bootstrap.instanceId),
    secret,
    expiresAt,
  };
}

function base64(value: unknown, length: number): Buffer {
  const text = peerText(value, 8192);
  const bytes = Buffer.from(text, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== text)
    throw new Error("Invalid sealed pairing envelope.");
  return bytes;
}

/** The setup code authenticates the entire trust payload before any credential exchange. */
export function decryptPeerPairing(
  value: unknown,
  code: string,
  endpoint: string,
  now = Date.now(),
): PeerPairing {
  const envelope = peerRecord(value);
  if (
    envelope.kind !== "aiden-manual-pairing-v1" ||
    envelope.protocolVersion !== 1
  )
    throw new Error("Invalid sealed pairing envelope.");
  const sessionId = hostIdentifier(envelope.sessionId);
  const expiresAt = peerText(envelope.expiresAt, 40);
  const kind = "aiden-manual-pairing-v1";
  const key = hkdfSha256(
    Buffer.from(normalizeAidenManualPairingCode(code), "ascii"),
    base64(envelope.salt, 16),
    `${kind}\n${sessionId}`,
  );
  try {
    const ciphertext = Buffer.from(
      peerText(envelope.ciphertext, 6000),
      "base64url",
    );
    if (ciphertext.length > 4096) throw new Error("Pairing payload too large.");
    const payload = openAesGcm(
      key,
      base64(envelope.nonce, 12),
      ciphertext,
      base64(envelope.tag, 16),
      `${kind}\n${sessionId}\n${expiresAt}`,
    );
    const pairing = parsePeerPairing(payload.toString("utf8"), now);
    if (pairing.endpoint !== endpoint || pairing.expiresAt !== expiresAt)
      throw new Error("Pairing endpoint mismatch.");
    return pairing;
  } finally {
    key.fill(0);
  }
}

/** A credential delivered by an approved connection request, with the trust to reach it. */
export interface PeerPairingRequestGrant extends PeerTrust {
  instanceId: string;
  deviceId: string;
  credential: string;
  capabilities: string[];
  displayName?: string;
}

/**
 * Open the sealed grant from an approved connection request. The requester
 * must pass the SPKI it observed on the TLS connection it polled (the same
 * SPKI its match code covered); a grant naming any other certificate is
 * refused. `endpoint` is optional: a Bonjour-discovered address can differ
 * from the host's canonical name, and the pinned SPKI already binds the
 * grant to the host the user approved. When given, it must match exactly.
 */
export function openPeerPairingRequestGrant(
  envelope: unknown,
  expected: {
    requestId: string;
    publicKey: string;
    privateKey: KeyObject;
    endpoint?: string;
    serverSpkiSha256: string;
  },
): PeerPairingRequestGrant {
  const plaintext = openPairingRequestEnvelope(envelope, expected);
  try {
    const grant = peerRecord(
      parseAidenRemoteJson(plaintext.toString("utf8"), "pairing grant"),
    );
    const trust = peerRecord(grant.trust);
    const exchange = peerRecord(grant.exchange);
    if (
      grant.kind !== AIDEN_PAIRING_GRANT_KIND ||
      grant.requestId !== expected.requestId ||
      (trust.mode !== "private-ca" && trust.mode !== "system") ||
      exchange.protocolVersion !== 1
    )
      throw new Error("Invalid pairing grant.");
    const credential = peerText(exchange.credential, 43);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(credential))
      throw new Error("Invalid pairing grant.");
    const validated = validatePeerTrust({
      endpoint: peerText(exchange.endpoint, 2048),
      serverSpkiSha256: peerText(exchange.serverSpkiSha256, 51),
      ...(trust.mode === "private-ca"
        ? {
            caCertificateDerBase64: peerText(
              trust.caCertificateDerBase64,
              8192,
            ),
          }
        : {}),
    });
    if (
      (expected.endpoint !== undefined && validated.endpoint !== expected.endpoint) ||
      validated.serverSpkiSha256 !== expected.serverSpkiSha256
    )
      throw new Error("The pairing identity did not match.");
    return {
      ...validated,
      instanceId: hostIdentifier(exchange.instanceId),
      deviceId: hostIdentifier(exchange.deviceId),
      credential,
      capabilities: peerStrings(exchange.capabilities),
      ...(exchange.displayName !== undefined
        ? { displayName: peerText(exchange.displayName, 80) }
        : {}),
    };
  } finally {
    plaintext.fill(0);
  }
}
