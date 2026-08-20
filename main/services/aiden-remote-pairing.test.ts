import assert from "node:assert/strict";
import test from "node:test";
import {
  AidenRemotePairingService,
  parseAidenRemotePairingExchangeInput,
} from "./aiden-remote-pairing.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

const endpoint = "https://aiden.example.test/api/aiden/v1";
const fingerprint = `sha256/${Buffer.alloc(32, 4).toString("base64")}`;

function fixture(options: { issueFails?: boolean } = {}) {
  let now = 1_000;
  let issued = 0;
  const service = new AidenRemotePairingService(
    "instance-1",
    {
      issueDevice: async (input) => {
        issued += 1;
        if (options.issueFails) throw new Error("disk failed");
        return {
          credential: Buffer.alloc(32, 8).toString("base64url"),
          device: {
            id: "device-1",
            name: input.name,
            type: input.type,
            clientVersion: input.clientVersion,
            capabilities: [...(input.capabilities ?? [])],
            createdAt: now,
            lastSeenAt: now,
          },
        };
      },
    },
    {
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 7),
    },
  );
  return {
    service,
    issued: () => issued,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function exchange(secret: string) {
  return {
    secret,
    deviceName: "Sambit’s iPhone",
    deviceType: "iphone" as const,
    clientVersion: "1.0",
  };
}

test("pairing opens for exactly five minutes and consumes its 256-bit secret once", async () => {
  const pairing = fixture();
  const bootstrap = pairing.service.begin(endpoint, fingerprint);
  assert.equal(bootstrap.expiresAt, new Date(301_000).toISOString());
  assert.equal(bootstrap.secret.length, 43);
  const result = await pairing.service.exchange(exchange(bootstrap.secret), "lan:phone");
  assert.equal(result.deviceId, "device-1");
  assert.equal(result.endpoint, endpoint);
  assert.equal(result.capabilities.includes("workspace:manage"), true);
  await assert.rejects(
    pairing.service.exchange(exchange(bootstrap.secret), "lan:phone"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      error.code === "pairing_already_used",
  );
  assert.equal(pairing.issued(), 1);
});

test("an expired, closed, or invalid pairing window fails with stable safe codes", async () => {
  const pairing = fixture();
  await assert.rejects(
    pairing.service.exchange(exchange("x".repeat(43)), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "pairing_closed",
  );
  const bootstrap = pairing.service.begin(endpoint, fingerprint);
  await assert.rejects(
    pairing.service.exchange(exchange("x".repeat(43)), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      error.code === "authentication_required",
  );
  pairing.advance(5 * 60_000);
  await assert.rejects(
    pairing.service.exchange(exchange(bootstrap.secret), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "pairing_expired",
  );
});

test("pairing persistence failure still burns the one-time secret", async () => {
  const pairing = fixture({ issueFails: true });
  const bootstrap = pairing.service.begin(endpoint, fingerprint);
  await assert.rejects(
    pairing.service.exchange(exchange(bootstrap.secret), "source"),
    /disk failed/u,
  );
  await assert.rejects(
    pairing.service.exchange(exchange(bootstrap.secret), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      error.code === "pairing_already_used",
  );
  assert.equal(pairing.issued(), 1);
});

test("pairing DTOs are exact and per-source attempts are rate limited", async () => {
  assert.throws(
    () => parseAidenRemotePairingExchangeInput({ ...exchange("x".repeat(43)), extra: true }),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "invalid_request",
  );
  const pairing = fixture();
  pairing.service.begin(endpoint, fingerprint);
  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(
      pairing.service.exchange(exchange("x".repeat(43)), "attacker"),
    );
  }
  await assert.rejects(
    pairing.service.exchange(exchange("x".repeat(43)), "attacker"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "rate_limited",
  );
});
