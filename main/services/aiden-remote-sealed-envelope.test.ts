import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  generatePairingRequestKeyPair,
  openPairingRequestEnvelope,
  pairingRequestCommitment,
  pairingRequestMatchCode,
  parsePairingRequestPublicKey,
  sealPairingRequestEnvelope,
  x25519SharedSecret,
} from "./aiden-remote-sealed-envelope.js";

interface MatchCodeVector {
  requesterPublicKey: string;
  serverSpkiSha256: string;
  requestId: string;
  requesterNonce: string;
  hostNonce: string;
  hostCommitment: string;
  matchCode: string;
}

async function fixtureVectors(): Promise<MatchCodeVector[]> {
  const fixture = JSON.parse(
    await readFile(
      path.join(process.cwd(), "protocol/aiden-remote/v1/fixtures/contract.json"),
      "utf8",
    ),
  ) as { pairingRequests: { matchCodeVectors: MatchCodeVector[] } };
  return fixture.pairingRequests.matchCodeVectors;
}

const REQUEST_ID = "pairreq_AwgNEhccISYrMDU6P0RJTlNYXWJnbHF2";
const EXPIRES_AT = "2026-08-18T19:02:00.000Z";

test("match codes and host commitments reproduce the shared contract vectors", async () => {
  const vectors = await fixtureVectors();
  assert.ok(vectors.length >= 3);
  // The vectors were produced by an independent implementation and include a
  // code with a leading zero, which must stay six characters long.
  assert.ok(vectors.some((vector) => vector.matchCode.startsWith("0")));
  for (const vector of vectors) {
    assert.equal(pairingRequestMatchCode(vector), vector.matchCode);
    assert.equal(
      pairingRequestCommitment(vector.requestId, vector.hostNonce),
      vector.hostCommitment,
    );
  }
});

test("every match-code input changes the code", async () => {
  const [vector] = await fixtureVectors();
  const flip = (value: string) => {
    const bytes = Buffer.from(value, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    return bytes.toString("base64url");
  };
  const flipSpki = (value: string) => {
    const bytes = Buffer.from(value.slice("sha256/".length), "base64");
    bytes[0] = bytes[0]! ^ 1;
    return `sha256/${bytes.toString("base64")}`;
  };
  const variants = [
    { ...vector!, requesterPublicKey: flip(vector!.requesterPublicKey) },
    { ...vector!, serverSpkiSha256: flipSpki(vector!.serverSpkiSha256) },
    { ...vector!, requestId: `pairreq_${"A".repeat(32)}` },
    { ...vector!, requesterNonce: flip(vector!.requesterNonce) },
    { ...vector!, hostNonce: flip(vector!.hostNonce) },
  ];
  for (const variant of variants) {
    assert.notEqual(pairingRequestMatchCode(variant), vector!.matchCode);
  }
});

test("match code inputs are validated rather than coerced", async () => {
  const [vector] = await fixtureVectors();
  assert.throws(() => pairingRequestMatchCode({ ...vector!, requestId: "pairreq_short" }));
  assert.throws(() => pairingRequestMatchCode({ ...vector!, serverSpkiSha256: "sha256/nope" }));
  assert.throws(() => pairingRequestMatchCode({ ...vector!, hostNonce: "AAAA" }));
  assert.throws(() =>
    pairingRequestMatchCode({ ...vector!, requesterPublicKey: Buffer.alloc(32).toString("base64url") }),
  );
});

test("public keys must be canonical 32-byte base64url and not the zero point", () => {
  const { publicKey } = generatePairingRequestKeyPair();
  assert.equal(parsePairingRequestPublicKey(publicKey)?.length, 32);
  assert.equal(parsePairingRequestPublicKey(`${publicKey}=`), null);
  assert.equal(parsePairingRequestPublicKey(publicKey.slice(1)), null);
  assert.equal(parsePairingRequestPublicKey(Buffer.alloc(32).toString("base64url")), null);
  assert.equal(parsePairingRequestPublicKey(Buffer.alloc(32, 1).toString("base64")), null);
  assert.equal(parsePairingRequestPublicKey(42), null);
});

test("a sealed grant opens only with the requester's private key and exact binding", () => {
  const requester = generatePairingRequestKeyPair();
  const plaintext = Buffer.from(JSON.stringify({ hello: "desktop" }));
  const envelope = sealPairingRequestEnvelope({
    requestId: REQUEST_ID,
    expiresAt: EXPIRES_AT,
    requesterPublicKey: requester.publicKey,
    plaintext,
  });
  assert.equal(envelope.kind, "aiden-pairing-request-v1");
  assert.notEqual(envelope.hostPublicKey, requester.publicKey);
  assert.ok(!envelope.ciphertext.includes(plaintext.toString("base64url")));
  const opened = openPairingRequestEnvelope(envelope, {
    requestId: REQUEST_ID,
    publicKey: requester.publicKey,
    privateKey: requester.privateKey,
  });
  assert.deepEqual(opened, plaintext);

  const stranger = generatePairingRequestKeyPair();
  assert.throws(() =>
    openPairingRequestEnvelope(envelope, {
      requestId: REQUEST_ID,
      publicKey: stranger.publicKey,
      privateKey: stranger.privateKey,
    }),
  );
  // The requester's own key under a substituted public-key claim fails too:
  // the HKDF info binds the exact key the host sealed to.
  assert.throws(() =>
    openPairingRequestEnvelope(envelope, {
      requestId: REQUEST_ID,
      publicKey: stranger.publicKey,
      privateKey: requester.privateKey,
    }),
  );
  assert.throws(() =>
    openPairingRequestEnvelope(envelope, {
      requestId: `pairreq_${"B".repeat(32)}`,
      publicKey: requester.publicKey,
      privateKey: requester.privateKey,
    }),
  );
  const tamper = (field: "ciphertext" | "tag" | "salt" | "nonce") => {
    const bytes = Buffer.from(envelope[field], "base64url");
    bytes[0] = bytes[0]! ^ 1;
    return { ...envelope, [field]: bytes.toString("base64url") };
  };
  for (const field of ["ciphertext", "tag", "salt", "nonce"] as const) {
    assert.throws(() =>
      openPairingRequestEnvelope(tamper(field), {
        requestId: REQUEST_ID,
        publicKey: requester.publicKey,
        privateKey: requester.privateKey,
      }),
    );
  }
  assert.throws(() =>
    openPairingRequestEnvelope(
      { ...envelope, expiresAt: "2026-08-18T19:03:00.000Z" },
      { requestId: REQUEST_ID, publicKey: requester.publicKey, privateKey: requester.privateKey },
    ),
  );
  assert.throws(() =>
    openPairingRequestEnvelope(
      { ...envelope, extra: true },
      { requestId: REQUEST_ID, publicKey: requester.publicKey, privateKey: requester.privateKey },
    ),
  );
});

test("sealing refuses empty or oversized grants and invalid requester keys", () => {
  const requester = generatePairingRequestKeyPair();
  const base = { requestId: REQUEST_ID, expiresAt: EXPIRES_AT, requesterPublicKey: requester.publicKey };
  assert.throws(() => sealPairingRequestEnvelope({ ...base, plaintext: Buffer.alloc(0) }));
  assert.throws(() => sealPairingRequestEnvelope({ ...base, plaintext: Buffer.alloc(8_193, 1) }));
  assert.throws(() =>
    sealPairingRequestEnvelope({
      ...base,
      requesterPublicKey: Buffer.alloc(32).toString("base64url"),
      plaintext: Buffer.from("{}"),
    }),
  );
});

test("X25519 agreement refuses low-order peer keys", () => {
  const { privateKey } = generatePairingRequestKeyPair();
  // u = 1 is a small-order point on Curve25519; agreement yields all zeroes.
  const lowOrder = Buffer.alloc(32);
  lowOrder[0] = 1;
  assert.throws(() => x25519SharedSecret(privateKey, lowOrder));
  assert.throws(() => x25519SharedSecret(privateKey, Buffer.alloc(32)));
});
