import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync } from "node:crypto";
import test from "node:test";
import {
  AidenRemotePairingService,
  normalizeAidenManualPairingCode,
  parseAidenRemotePairingExchangeInput,
} from "./aiden-remote-pairing.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

const endpoint = "https://aiden.example.test/api/aiden/v1";
const fingerprint = `sha256/${Buffer.alloc(32, 4).toString("base64")}`;

function fixture(options: { issueFails?: boolean } = {}) {
  let now = 1_000;
  let issued = 0;
  let randomCounter = 0;
  let statusChanges = 0;
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
      randomBytes: (size) => Buffer.alloc(size, ++randomCounter),
    },
    () => {
      statusChanges += 1;
    },
    () => "Studio Mac",
  );
  return {
    service,
    issued: () => issued,
    statusChanges: () => statusChanges,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function exchange(secret: string, acceptsDisplayName = true) {
  return {
    secret,
    deviceName: "Sambit’s iPhone",
    deviceType: "iphone" as const,
    clientVersion: "1.0",
    ...(acceptsDisplayName ? { acceptsDisplayName: true } : {}),
  };
}

test("pairing opens for exactly five minutes and consumes its 256-bit secret once", async () => {
  const pairing = fixture();
  const opened = pairing.service.begin(endpoint, fingerprint);
  const { bootstrap } = opened;
  assert.match(opened.sessionId, /^pairing_[A-Za-z0-9_-]{32}$/u);
  assert.equal(bootstrap.expiresAt, new Date(301_000).toISOString());
  assert.equal(bootstrap.secret.length, 43);
  assert.match(opened.manualCode, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/u);
  const result = await pairing.service.exchange(exchange(bootstrap.secret), "lan:phone");
  assert.equal(result.deviceId, "device-1");
  assert.equal(result.endpoint, endpoint);
  assert.equal(result.displayName, "Studio Mac");
  assert.equal(result.capabilities.includes("workspace:manage"), true);
  assert.deepEqual(pairing.service.status(), {
    sessionId: opened.sessionId,
    state: "finishing",
    deviceId: "device-1",
  });
  assert.equal(pairing.statusChanges(), 3);
  await assert.rejects(
    pairing.service.exchange(exchange(bootstrap.secret), "lan:phone"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      error.code === "pairing_already_used",
  );
  assert.equal(pairing.issued(), 1);
});

test("manual setup code decrypts the canonical payload without crossing the wire", () => {
  const pairing = fixture();
  const opened = pairing.service.begin(endpoint, fingerprint);
  const payload = JSON.stringify({
    kind: "aiden-pairing-v1",
    bootstrap: opened.bootstrap,
    trust: { mode: "system" },
  });
  pairing.service.sealManualPayload(opened.sessionId, payload);
  const sealed = pairing.service.manualBootstrap();
  const code = normalizeAidenManualPairingCode(opened.manualCode);
  const salt = Buffer.from(sealed.salt, "base64url");
  const nonce = Buffer.from(sealed.nonce, "base64url");
  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(code, "ascii"),
    salt,
    Buffer.from(`aiden-manual-pairing-v1\n${sealed.sessionId}`, "utf8"),
    32,
  ));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(
    `aiden-manual-pairing-v1\n${sealed.sessionId}\n${sealed.expiresAt}`,
    "utf8",
  ));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  assert.equal(plaintext, payload);
  assert.equal(JSON.stringify(sealed).includes(code), false);
  assert.equal(JSON.stringify(sealed).includes(opened.bootstrap.secret), false);
  assert.equal(Buffer.from(sealed.salt, "base64url").length, 16);
  assert.equal(Buffer.from(sealed.nonce, "base64url").length, 12);
  assert.equal(Buffer.from(sealed.tag, "base64url").length, 16);
});

test("manual bootstrap follows pairing expiry, replacement, consumption, and exact code grammar", async () => {
  assert.equal(
    normalizeAidenManualPairingCode("0123-4567-89AB-CDEF-GHJK"),
    "0123456789ABCDEFGHJK",
  );
  for (const invalid of [
    "0123-4567-89AB-CDEF-GHJI",
    "0123-4567-89AB-CDEF-GHJＫ",
    "0123-4567-89AB-CDEF",
  ]) {
    assert.throws(
      () => normalizeAidenManualPairingCode(invalid),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "invalid_request",
    );
  }

  const pairing = fixture();
  assert.throws(
    () => pairing.service.manualBootstrap(),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "pairing_closed",
  );
  const first = pairing.service.begin(endpoint, fingerprint);
  pairing.service.sealManualPayload(first.sessionId, "first");
  const firstCiphertext = pairing.service.manualBootstrap().ciphertext;
  const second = pairing.service.begin(endpoint, fingerprint);
  pairing.service.sealManualPayload(second.sessionId, "second");
  assert.notEqual(pairing.service.manualBootstrap().ciphertext, firstCiphertext);
  await pairing.service.exchange(exchange(second.bootstrap.secret), "phone");
  assert.throws(
    () => pairing.service.manualBootstrap(),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "pairing_already_used",
  );

  const expiring = fixture();
  const expiringWindow = expiring.service.begin(endpoint, fingerprint);
  expiring.service.sealManualPayload(expiringWindow.sessionId, "payload");
  expiring.advance(5 * 60_000);
  assert.throws(
    () => expiring.service.manualBootstrap(),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "pairing_expired",
  );
});

test("pairing emits additive display metadata only to clients that opt in", async () => {
  const legacy = fixture();
  const legacyWindow = legacy.service.begin(endpoint, fingerprint);
  const legacyResult = await legacy.service.exchange(
    exchange(legacyWindow.bootstrap.secret, false),
    "legacy-client",
  );
  assert.equal("displayName" in legacyResult, false);

  const current = fixture();
  const currentWindow = current.service.begin(endpoint, fingerprint);
  const currentResult = await current.service.exchange(
    exchange(currentWindow.bootstrap.secret),
    "current-client",
  );
  assert.equal(currentResult.displayName, "Studio Mac");
});

test("an expired, closed, or invalid pairing window fails with stable safe codes", async () => {
  const pairing = fixture();
  await assert.rejects(
    pairing.service.exchange(exchange("x".repeat(43)), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "pairing_closed",
  );
  const opened = pairing.service.begin(endpoint, fingerprint);
  const { bootstrap } = opened;
  await assert.rejects(
    pairing.service.exchange(exchange("x".repeat(43)), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError &&
      error.code === "authentication_required",
  );
  pairing.advance(5 * 60_000);
  assert.equal(pairing.service.status()?.state, "expired");
  await assert.rejects(
    pairing.service.exchange(exchange(bootstrap.secret), "source"),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "pairing_expired",
  );
});

test("pairing persistence failure still burns the one-time secret", async () => {
  const pairing = fixture({ issueFails: true });
  const opened = pairing.service.begin(endpoint, fingerprint);
  const { bootstrap } = opened;
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
  assert.equal(pairing.service.status()?.state, "failed");
});

test("pairing close is conditional on the exact main-owned session", () => {
  const pairing = fixture();
  const first = pairing.service.begin(endpoint, fingerprint);
  const second = pairing.service.begin(endpoint, fingerprint);
  assert.equal(pairing.service.close(first.sessionId), false);
  assert.equal(pairing.service.status()?.sessionId, second.sessionId);
  assert.equal(pairing.service.close(second.sessionId), true);
  assert.equal(pairing.service.status(), undefined);
});

test("closing or replacing a consumed window fences deferred credential issuance", async () => {
  for (const action of ["close", "replace"] as const) {
    let randomCounter = 0;
    let releaseIssuance: (() => void) | undefined;
    let issuanceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { issuanceStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseIssuance = resolve; });
    let committed = 0;
    const service = new AidenRemotePairingService(
      "instance-1",
      {
        issueDevice: async (input) => {
          issuanceStarted?.();
          await release;
          if (!input.authorizeCommit?.()) {
            throw new AidenRemoteServiceError(
              "pairing_closed",
              "This pairing window was closed before the device was created.",
              403,
            );
          }
          committed += 1;
          return {
            credential: Buffer.alloc(32, 8).toString("base64url"),
            device: {
              id: "device-race",
              name: input.name,
              type: input.type,
              clientVersion: input.clientVersion,
              capabilities: [...(input.capabilities ?? [])],
              createdAt: 1_000,
              lastSeenAt: 0,
            },
          };
        },
      },
      {
        now: () => 1_000,
        randomBytes: (size) => Buffer.alloc(size, ++randomCounter),
      },
    );
    const opened = service.begin(endpoint, fingerprint);
    const pending = service.exchange(exchange(opened.bootstrap.secret), "phone");
    await started;
    assert.equal(service.status()?.state, "finishing");
    if (action === "close") {
      assert.equal(service.close(opened.sessionId), true);
    } else {
      service.begin(endpoint, fingerprint);
    }
    releaseIssuance?.();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "pairing_closed",
    );
    assert.equal(committed, 0);
    if (action === "close") assert.equal(service.status(), undefined);
    else assert.notEqual(service.status()?.sessionId, opened.sessionId);
  }
});

test("a credential issued before bootstrap expiry remains finishing after the scan deadline", async () => {
  const pairing = fixture();
  const opened = pairing.service.begin(endpoint, fingerprint);
  pairing.advance(5 * 60_000 - 1);
  await pairing.service.exchange(exchange(opened.bootstrap.secret), "source");
  pairing.advance(2);

  assert.deepEqual(pairing.service.status(), {
    sessionId: opened.sessionId,
    state: "finishing",
    deviceId: "device-1",
  });
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
