/**
 * Pure sealing primitives shared by the host and client halves of Aiden
 * Remote pairing: AES-256-GCM, HKDF-SHA256 and X25519, plus the
 * pairing-request match code, host commitment and grant envelope.
 *
 * Nothing here touches the network, persistence or Electron, so the exact
 * derivations can be pinned by the shared contract fixture vectors.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as cryptoRandomBytes,
  type KeyObject,
} from "node:crypto";

export const AIDEN_PAIRING_REQUEST_ENVELOPE_KIND = "aiden-pairing-request-v1" as const;
export const AIDEN_PAIRING_GRANT_KIND = "aiden-pairing-grant-v1" as const;
const MATCH_CODE_LABEL = "aiden-pairing-match-v1";
const COMMITMENT_LABEL = "aiden-pairing-commit-v1";

export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const PAIRING_ENVELOPE_SALT_BYTES = 16;
export const PAIRING_NONCE_BYTES = 32;
export const X25519_PUBLIC_KEY_BYTES = 32;
/** Upper bound on a sealed pairing-request grant's plaintext. */
export const MAX_PAIRING_GRANT_BYTES = 8_192;

/** `pairreq_` plus 24 random bytes in base64url: always 40 ASCII characters. */
export const AIDEN_PAIRING_REQUEST_ID_PATTERN = /^pairreq_[A-Za-z0-9_-]{32}$/u;
const SPKI_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/u;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function hkdfSha256(
  inputKeyMaterial: Buffer,
  salt: Buffer,
  info: Buffer | string,
  length = 32,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      inputKeyMaterial,
      salt,
      typeof info === "string" ? Buffer.from(info, "utf8") : info,
      length,
    ),
  );
}

export function sealAesGcm(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  additionalData: Buffer | string,
): { ciphertext: Buffer; tag: Buffer } {
  if (key.length !== 32 || nonce.length !== AES_GCM_NONCE_BYTES) {
    throw new Error("Invalid AES-GCM key material.");
  }
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  cipher.setAAD(
    typeof additionalData === "string"
      ? Buffer.from(additionalData, "utf8")
      : additionalData,
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

/** Throws on any authentication failure; never returns unauthenticated bytes. */
export function openAesGcm(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  additionalData: Buffer | string,
): Buffer {
  if (
    key.length !== 32 ||
    nonce.length !== AES_GCM_NONCE_BYTES ||
    tag.length !== AES_GCM_TAG_BYTES
  ) {
    throw new Error("Invalid AES-GCM key material.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  decipher.setAAD(
    typeof additionalData === "string"
      ? Buffer.from(additionalData, "utf8")
      : additionalData,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Strict canonical base64url of an exact byte length, or `null`. */
export function decodeBase64UrlExact(value: unknown, length: number): Buffer | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) return null;
  return bytes;
}

/** A 32-byte X25519 public key as unpadded base64url, rejecting the all-zero point. */
export function parsePairingRequestPublicKey(value: unknown): Buffer | null {
  if (typeof value !== "string" || !BASE64URL_32_PATTERN.test(value)) return null;
  const bytes = decodeBase64UrlExact(value, X25519_PUBLIC_KEY_BYTES);
  if (!bytes || bytes.every((byte) => byte === 0)) return null;
  return bytes;
}

/** Raw 32-byte SPKI digest from the `sha256/<base64>` pin form. */
export function spkiDigestBytes(serverSpkiSha256: string): Buffer {
  if (!SPKI_PATTERN.test(serverSpkiSha256)) {
    throw new Error("Invalid server SPKI fingerprint.");
  }
  return Buffer.from(serverSpkiSha256.slice("sha256/".length), "base64");
}

export interface AidenPairingRequestKeyPair {
  /** Raw 32-byte X25519 public key, unpadded base64url (43 characters). */
  publicKey: string;
  privateKey: KeyObject;
}

export function generatePairingRequestKeyPair(): AidenPairingRequestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("X25519 key export failed.");
  return { publicKey: jwk.x, privateKey };
}

function x25519PublicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

/** X25519 agreement that refuses low-order peer keys (an all-zero secret). */
export function x25519SharedSecret(privateKey: KeyObject, peerPublicKey: Buffer): Buffer {
  if (peerPublicKey.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error("Invalid X25519 public key.");
  }
  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey,
      publicKey: x25519PublicKeyObject(peerPublicKey),
    });
  } catch {
    throw new Error("X25519 key agreement failed.");
  }
  if (shared.length !== 32 || shared.every((byte) => byte === 0)) {
    shared.fill(0);
    throw new Error("X25519 key agreement failed.");
  }
  return shared;
}

function requireRequestId(requestId: string): Buffer {
  if (!AIDEN_PAIRING_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Invalid pairing request id.");
  }
  return Buffer.from(requestId, "ascii");
}

function requireNonce(value: Buffer | string, name: string): Buffer {
  const bytes = typeof value === "string"
    ? decodeBase64UrlExact(value, PAIRING_NONCE_BYTES)
    : value;
  if (!bytes || bytes.length !== PAIRING_NONCE_BYTES) {
    throw new Error(`Invalid ${name}.`);
  }
  return bytes;
}

/**
 * The host's binding commitment to its nonce, published before the requester
 * reveals its own nonce, as base64url of
 * SHA-256("aiden-pairing-commit-v1" ‖ 0x00 ‖ requestId ‖ hostNonce).
 */
export function pairingRequestCommitment(
  requestId: string,
  hostNonce: Buffer | string,
): string {
  return createHash("sha256")
    .update(COMMITMENT_LABEL, "ascii")
    .update(Buffer.of(0))
    .update(requireRequestId(requestId))
    .update(requireNonce(hostNonce, "host nonce"))
    .digest("base64url");
}

/**
 * Six-digit comparison code both screens show. It covers the requester key,
 * the TLS key the requester actually connected to, the request and both
 * nonces, so an attacker in the middle cannot choose inputs that collide.
 */
export function pairingRequestMatchCode(input: {
  requesterPublicKey: string;
  serverSpkiSha256: string;
  requestId: string;
  requesterNonce: Buffer | string;
  hostNonce: Buffer | string;
}): string {
  const publicKey = parsePairingRequestPublicKey(input.requesterPublicKey);
  if (!publicKey) throw new Error("Invalid requester public key.");
  const digest = createHash("sha256")
    .update(MATCH_CODE_LABEL, "ascii")
    .update(Buffer.of(0))
    .update(publicKey)
    .update(spkiDigestBytes(input.serverSpkiSha256))
    .update(requireRequestId(input.requestId))
    .update(requireNonce(input.requesterNonce, "requester nonce"))
    .update(requireNonce(input.hostNonce, "host nonce"))
    .digest();
  return (digest.readBigUInt64BE(0) % 1_000_000n).toString().padStart(6, "0");
}

export interface AidenPairingRequestEnvelope {
  kind: typeof AIDEN_PAIRING_REQUEST_ENVELOPE_KIND;
  protocolVersion: 1;
  requestId: string;
  expiresAt: string;
  /** The host's ephemeral X25519 public key, base64url. */
  hostPublicKey: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

function envelopeInfo(requestId: string, requesterPublicKey: string, hostPublicKey: string): string {
  return `${AIDEN_PAIRING_REQUEST_ENVELOPE_KIND}\n${requestId}\n${requesterPublicKey}\n${hostPublicKey}`;
}

function envelopeAdditionalData(requestId: string, expiresAt: string): string {
  return `${AIDEN_PAIRING_REQUEST_ENVELOPE_KIND}\n${requestId}\n${expiresAt}`;
}

/** Seal `plaintext` to the requester's X25519 key under a fresh host ephemeral key. */
export function sealPairingRequestEnvelope(input: {
  requestId: string;
  expiresAt: string;
  requesterPublicKey: string;
  plaintext: Buffer;
  randomBytes?: (size: number) => Buffer;
}): AidenPairingRequestEnvelope {
  requireRequestId(input.requestId);
  const requesterKey = parsePairingRequestPublicKey(input.requesterPublicKey);
  if (!requesterKey) throw new Error("Invalid requester public key.");
  if (input.plaintext.length === 0 || input.plaintext.length > MAX_PAIRING_GRANT_BYTES) {
    throw new Error("Pairing grant payload is too large.");
  }
  const random = input.randomBytes ?? cryptoRandomBytes;
  const ephemeral = generatePairingRequestKeyPair();
  const shared = x25519SharedSecret(ephemeral.privateKey, requesterKey);
  const salt = random(PAIRING_ENVELOPE_SALT_BYTES);
  const nonce = random(AES_GCM_NONCE_BYTES);
  const key = hkdfSha256(
    shared,
    salt,
    envelopeInfo(input.requestId, input.requesterPublicKey, ephemeral.publicKey),
  );
  shared.fill(0);
  try {
    const sealed = sealAesGcm(
      key,
      nonce,
      input.plaintext,
      envelopeAdditionalData(input.requestId, input.expiresAt),
    );
    return {
      kind: AIDEN_PAIRING_REQUEST_ENVELOPE_KIND,
      protocolVersion: 1,
      requestId: input.requestId,
      expiresAt: input.expiresAt,
      hostPublicKey: ephemeral.publicKey,
      salt: salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      ciphertext: sealed.ciphertext.toString("base64url"),
      tag: sealed.tag.toString("base64url"),
    };
  } finally {
    key.fill(0);
  }
}

const ENVELOPE_KEYS = [
  "kind",
  "protocolVersion",
  "requestId",
  "expiresAt",
  "hostPublicKey",
  "salt",
  "nonce",
  "ciphertext",
  "tag",
] as const;

/**
 * Authenticate and decrypt a pairing-request envelope with the requester's
 * private key. Throws on any shape, binding or authentication failure.
 */
export function openPairingRequestEnvelope(
  value: unknown,
  expected: { requestId: string; publicKey: string; privateKey: KeyObject },
): Buffer {
  const invalid = () => new Error("Invalid sealed pairing grant.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    keys.some((key) => !(ENVELOPE_KEYS as readonly string[]).includes(key)) ||
    record.kind !== AIDEN_PAIRING_REQUEST_ENVELOPE_KIND ||
    record.protocolVersion !== 1 ||
    record.requestId !== expected.requestId ||
    typeof record.expiresAt !== "string" ||
    record.expiresAt.length > 40 ||
    typeof record.ciphertext !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(record.ciphertext)
  ) {
    throw invalid();
  }
  const hostPublicKey = parsePairingRequestPublicKey(record.hostPublicKey);
  const salt = decodeBase64UrlExact(record.salt, PAIRING_ENVELOPE_SALT_BYTES);
  const nonce = decodeBase64UrlExact(record.nonce, AES_GCM_NONCE_BYTES);
  const tag = decodeBase64UrlExact(record.tag, AES_GCM_TAG_BYTES);
  const ciphertext = Buffer.from(record.ciphertext, "base64url");
  if (
    !hostPublicKey ||
    !salt ||
    !nonce ||
    !tag ||
    ciphertext.length === 0 ||
    ciphertext.length > MAX_PAIRING_GRANT_BYTES ||
    ciphertext.toString("base64url") !== record.ciphertext
  ) {
    throw invalid();
  }
  const shared = x25519SharedSecret(expected.privateKey, hostPublicKey);
  const key = hkdfSha256(
    shared,
    salt,
    envelopeInfo(expected.requestId, expected.publicKey, record.hostPublicKey as string),
  );
  shared.fill(0);
  try {
    return openAesGcm(
      key,
      nonce,
      ciphertext,
      tag,
      envelopeAdditionalData(expected.requestId, record.expiresAt),
    );
  } catch {
    throw invalid();
  } finally {
    key.fill(0);
  }
}
