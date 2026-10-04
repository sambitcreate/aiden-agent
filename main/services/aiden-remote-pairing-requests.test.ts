import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AidenRemotePairingService } from "./aiden-remote-pairing.js";
import {
  AidenRemotePairingRequestService,
  type AidenPairingRequestTransportIdentity,
} from "./aiden-remote-pairing-requests.js";
import {
  generatePairingRequestKeyPair,
  pairingRequestCommitment,
  pairingRequestMatchCode,
} from "./aiden-remote-sealed-envelope.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  normalizeAidenRemoteDisplayName,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import { openPeerPairingRequestGrant } from "./peer-pairing.js";

const SPKI = `sha256/${Buffer.alloc(32, 7).toString("base64")}`;
const ENDPOINT = "https://studio.example-tailnet.ts.net/api/aiden/v1";
const IDENTITY: AidenPairingRequestTransportIdentity = {
  endpoint: ENDPOINT,
  serverSpkiSha256: SPKI,
  trust: { mode: "system" },
};

class FakeClock {
  current = 1_800_000_000_000;
  private timers = new Set<{ at: number; callback: () => void }>();

  now = () => this.current;

  schedule = (delayMs: number, callback: () => void) => {
    const timer = { at: this.current + delayMs, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };

  async advance(ms: number): Promise<void> {
    this.current += ms;
    for (const timer of [...this.timers].sort((left, right) => left.at - right.at)) {
      if (timer.at <= this.current && this.timers.has(timer)) {
        this.timers.delete(timer);
        timer.callback();
      }
    }
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function harness(options: {
  accepting?: () => boolean;
  displayName?: () => string;
  hostCapabilities?: boolean;
} = {}) {
  let stored: AidenRemoteStateDocument = createDefaultAidenRemoteState(() => Buffer.alloc(24, 9));
  let failNextSave = false;
  let saveGate: Promise<void> | null = null;
  const clock = new FakeClock();
  const registry = new AidenRemoteStateRegistry(
    {
      load: async () => structuredClone(stored),
      save: async (document) => {
        if (saveGate) await saveGate;
        if (failNextSave) {
          failNextSave = false;
          throw new Error("disk unavailable");
        }
        stored = structuredClone(document);
      },
    },
    {
      now: clock.now,
      randomBytes,
      deriveCredentialDigest: async (credential, salt) =>
        createHash("sha256").update(credential).update(salt).digest(),
    },
  );
  let changes = 0;
  const service = new AidenRemotePairingRequestService({
    instanceId: stored.instanceId,
    devices: registry,
    accepting: options.accepting ?? (() => true),
    resolveTransport: async () => IDENTITY,
    displayName: options.displayName ?? (() => "Studio Mac"),
    botCapabilitiesSupported: () => true,
    hostCapabilitiesSupported: () => options.hostCapabilities ?? true,
    onChanged: () => {
      changes += 1;
    },
    now: clock.now,
    schedule: clock.schedule,
  });
  return {
    clock,
    registry,
    service,
    stored: () => stored,
    liveDevices: () => stored.devices.filter((device) => device.revokedAt === undefined),
    failNextSave: () => {
      failNextSave = true;
    },
    holdSaves: () => {
      let release: () => void = () => undefined;
      saveGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        saveGate = null;
        release();
      };
    },
    changes: () => changes,
  };
}

const DEFAULT_CONTEXT = { source: "100.64.0.20", transport: "tailscale" as const };

async function open(
  service: AidenRemotePairingRequestService,
  context: { source: string; transport: "lan" | "tailscale" } = DEFAULT_CONTEXT,
  deviceName = "Travel MacBook",
) {
  const keys = generatePairingRequestKeyPair();
  const created = await service.create(
    { deviceName, deviceType: "mac", publicKey: keys.publicKey, clientVersion: "0.52.0" },
    context,
  );
  const requesterNonce = randomBytes(32);
  const { hostNonce } = service.reveal(created.requestId, created.pollSecret, {
    requesterNonce: requesterNonce.toString("base64url"),
  });
  const matchCode = pairingRequestMatchCode({
    requesterPublicKey: keys.publicKey,
    serverSpkiSha256: SPKI,
    requestId: created.requestId,
    requesterNonce,
    hostNonce,
  });
  return { keys, created, hostNonce, matchCode };
}

function assertRemoteError(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof AidenRemoteServiceError, String(error));
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

test("an allowed request delivers the desktop exchange grants, sealed, and the credential authenticates", async () => {
  const { service, registry, stored } = harness();
  const { keys, created, hostNonce, matchCode } = await open(service);

  // The requester can check the host did not pick its nonce after seeing ours.
  assert.equal(pairingRequestCommitment(created.requestId, hostNonce), created.hostCommitment);
  const [prompt] = service.list();
  assert.equal(prompt?.matchCode, matchCode);
  assert.equal(prompt?.deviceName, "Travel MacBook");
  assert.equal(prompt?.deviceType, "mac");

  const waiting = service.poll(created.requestId, created.pollSecret);
  const decision = await service.respond(created.requestId, "allow");
  assert.deepEqual(decision, { requestId: created.requestId, state: "approved" });
  const status = await waiting;
  assert.equal(status.state, "approved");
  assert.ok(status.envelope);

  const grant = openPeerPairingRequestGrant(status.envelope, {
    requestId: created.requestId,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    endpoint: ENDPOINT,
    serverSpkiSha256: SPKI,
  });
  assert.equal(grant.instanceId, stored().instanceId);
  assert.equal(grant.displayName, "Studio Mac");
  assert.equal(grant.caCertificateDerBase64, undefined);
  const device = await registry.authenticate(grant.credential);
  assert.equal(device?.id, grant.deviceId);
  assert.equal(device?.type, "mac");
  assert.equal(device?.revoked, false);

  // Independent oracle: the grants match a QR exchange by an equivalent desktop.
  const pairing = new AidenRemotePairingService(
    stored().instanceId,
    registry,
    undefined,
    undefined,
    undefined,
    () => true,
    () => true,
  );
  const bootstrap = pairing.begin(ENDPOINT, SPKI).bootstrap;
  const exchanged = await pairing.exchange(
    {
      secret: bootstrap.secret,
      deviceName: "Other Mac",
      deviceType: "mac",
      clientVersion: "0.52.0",
      acceptsDisplayName: true,
      acceptsBotCapabilities: true,
      acceptsProgressCapabilities: true,
    },
    "10.0.0.2",
  );
  assert.deepEqual([...grant.capabilities].sort(), [...exchanged.capabilities].sort());
  assert.ok(grant.capabilities.includes("host:events"));
  assert.ok(grant.capabilities.includes("runs:control"));
  assert.equal(service.list().length, 0);
});

test("the envelope opens only for the requester and only for the identity it connected to", async () => {
  const { service } = harness();
  const { keys, created } = await open(service);
  await service.respond(created.requestId, "allow");
  const { envelope } = await service.poll(created.requestId, created.pollSecret);
  const expected = {
    requestId: created.requestId,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    endpoint: ENDPOINT,
    serverSpkiSha256: SPKI,
  };
  const stranger = generatePairingRequestKeyPair();
  assert.throws(() => openPeerPairingRequestGrant(envelope, { ...expected, ...stranger }));
  assert.throws(() =>
    openPeerPairingRequestGrant(envelope, {
      ...expected,
      serverSpkiSha256: `sha256/${Buffer.alloc(32, 8).toString("base64")}`,
    }),
  );
  assert.throws(() =>
    openPeerPairingRequestGrant(envelope, {
      ...expected,
      endpoint: "https://evil.example-tailnet.ts.net/api/aiden/v1",
    }),
  );
  // The envelope can be fetched again while retained, and still opens.
  const again = await service.poll(created.requestId, created.pollSecret);
  assert.equal(openPeerPairingRequestGrant(again.envelope, expected).instanceId.length > 0, true);
});

test("the requester accepts every host name the host allows and nothing longer", async () => {
  async function grantFor(displayName: string) {
    const { service } = harness({ displayName: () => displayName });
    const { keys, created } = await open(service);
    await service.respond(created.requestId, "allow");
    const { envelope } = await service.poll(created.requestId, created.pollSecret);
    return () => openPeerPairingRequestGrant(envelope, {
      requestId: created.requestId,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      serverSpkiSha256: SPKI,
    });
  }

  // 80 characters by the host's count, but 81 UTF-16 units.
  const longest = normalizeAidenRemoteDisplayName(`${"A".repeat(79)}\u{1F680}`);
  assert.equal(longest.length, 81);
  assert.equal((await grantFor(longest))().displayName, longest);

  const tooLong = `${"A".repeat(80)}\u{1F680}`;
  assert.throws(() => normalizeAidenRemoteDisplayName(tooLong));
  assert.throws(await grantFor(tooLong), /display name/u);
});

test("deny, expiry and requester cancel issue no credential", async () => {
  const { service, stored, clock } = harness();

  const denied = await open(service);
  const waiting = service.poll(denied.created.requestId, denied.created.pollSecret);
  assert.deepEqual(await service.respond(denied.created.requestId, "deny"), {
    requestId: denied.created.requestId,
    state: "denied",
  });
  const deniedStatus = await waiting;
  assert.equal(deniedStatus.state, "denied");
  assert.equal(deniedStatus.envelope, undefined);
  assert.deepEqual(await service.respond(denied.created.requestId, "allow"), {
    requestId: denied.created.requestId,
    state: "denied",
  });

  const cancelled = await open(service, { source: "192.168.1.21", transport: "lan" });
  assert.deepEqual(await service.cancel(cancelled.created.requestId, cancelled.created.pollSecret), {
    requestId: cancelled.created.requestId,
    state: "cancelled",
  });
  assert.equal((await service.respond(cancelled.created.requestId, "allow"))?.state, "cancelled");

  const expired = await open(service, { source: "192.168.1.22", transport: "lan" });
  await clock.advance(2 * 60_000);
  assert.equal(service.list().length, 0);
  assert.equal((await service.poll(expired.created.requestId, expired.created.pollSecret)).state, "expired");
  assert.equal((await service.respond(expired.created.requestId, "allow"))?.state, "expired");

  assert.equal(stored().devices.length, 0);

  // Decided requests stay readable briefly, then disappear.
  await clock.advance(60_000);
  await assert.rejects(
    service.poll(expired.created.requestId, expired.created.pollSecret),
    assertRemoteError("not_found", 404),
  );
  assert.equal(await service.respond(expired.created.requestId, "allow"), null);
});

test("the poll secret is required, checked, and indistinguishable from an unknown request", async () => {
  const { service } = harness();
  const { created } = await open(service);
  const wrong = randomBytes(32).toString("base64url");
  const unknownId = `pairreq_${"Q".repeat(32)}`;
  for (const [id, secret] of [
    [created.requestId, wrong],
    [created.requestId, undefined],
    [created.requestId, `${created.pollSecret}x`],
    [unknownId, created.pollSecret],
  ] as const) {
    await assert.rejects(service.poll(id, secret), assertRemoteError("not_found", 404));
    await assert.rejects(service.cancel(id, secret), assertRemoteError("not_found", 404));
    assert.throws(
      () => service.reveal(id, secret, { requesterNonce: randomBytes(32).toString("base64url") }),
      assertRemoteError("not_found", 404),
    );
  }
  // None of the failed attempts changed the request.
  assert.equal(service.list().length, 1);
});

test("phones, malformed requests and a closed setting are refused before anything is stored", async () => {
  let accepting = true;
  const { service } = harness({ accepting: () => accepting });
  const publicKey = generatePairingRequestKeyPair().publicKey;
  for (const deviceType of ["iphone", "ipad"]) {
    await assert.rejects(
      service.create({ deviceName: "Phone", deviceType, publicKey }, { source: "a", transport: "lan" }),
      assertRemoteError("capability_denied", 403),
    );
  }
  const malformed: unknown[] = [
    null,
    { deviceName: "Mac", deviceType: "windows", publicKey },
    { deviceName: "Mac", deviceType: "mac", publicKey: Buffer.alloc(32).toString("base64url") },
    { deviceName: "Mac", deviceType: "mac", publicKey, extra: true },
    { deviceName: "Mac‮gnp.exe", deviceType: "mac", publicKey },
    { deviceName: "Mac\nAdmin", deviceType: "mac", publicKey },
    { deviceName: "   ", deviceType: "mac", publicKey },
    { deviceName: "M".repeat(81), deviceType: "mac", publicKey },
    { deviceName: "Mac", deviceType: "mac", publicKey, clientVersion: "1 0" },
  ];
  for (const [index, body] of malformed.entries()) {
    await assert.rejects(
      service.create(body, { source: `malformed-${index}`, transport: "lan" }),
      assertRemoteError("invalid_request", 400),
    );
  }

  accepting = false;
  assert.equal(service.accepting(), false);
  await assert.rejects(
    service.create({ deviceName: "Mac", deviceType: "linux", publicKey }, { source: "b", transport: "lan" }),
    assertRemoteError("pairing_closed", 403),
  );
  assert.equal(service.list().length, 0);
});

test("turning the setting off cancels open requests and keeps decided ones", async () => {
  let accepting = true;
  const { service, liveDevices } = harness({ accepting: () => accepting });
  const approved = await open(service, { source: "10.0.0.1", transport: "lan" });
  await service.respond(approved.created.requestId, "allow");
  const pending = await open(service, { source: "10.0.0.2", transport: "lan" });
  const waiting = service.poll(pending.created.requestId, pending.created.pollSecret);

  accepting = false;
  service.cancelOpen();
  assert.equal((await waiting).state, "cancelled");
  assert.equal(service.list().length, 0);
  const status = await service.poll(approved.created.requestId, approved.created.pollSecret);
  assert.equal(status.state, "approved");
  assert.equal(liveDevices().length, 1);
});

test("creation is rate limited per source and globally, and open requests are bounded", async () => {
  const { service, clock } = harness();
  const create = (source: string) =>
    service.create(
      { deviceName: "Mac", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey },
      { source, transport: "lan" },
    );

  // Two open requests per source; a third is refused until one closes.
  const first = await create("10.0.0.1");
  await create("10.0.0.1");
  await assert.rejects(create("10.0.0.1"), assertRemoteError("rate_limited", 429));
  await service.cancel(first.requestId, first.pollSecret);
  const fourth = await create("10.0.0.1");
  await service.cancel(fourth.requestId, fourth.pollSecret);
  await create("10.0.0.1");
  // Five attempts per source per minute, counting refused ones.
  await assert.rejects(create("10.0.0.1"), (error: unknown) => {
    assertRemoteError("rate_limited", 429)(error);
    const details = (error as AidenRemoteServiceError).details;
    assert.ok((details?.retryAfterSeconds ?? 0) >= 1 && (details?.retryAfterSeconds ?? 0) <= 60);
    assert.equal((error as AidenRemoteServiceError).retryable, true);
    return true;
  });

  // At most eight open requests across all sources.
  for (let index = 2; index <= 7; index += 1) await create(`10.0.0.${index}`);
  await assert.rejects(create("10.0.0.8"), assertRemoteError("rate_limited", 429));

  // Twenty attempts per minute across all sources, even from fresh sources.
  for (let index = 0; index < 20; index += 1) {
    await create(`10.0.1.${index}`).catch(() => undefined);
  }
  await assert.rejects(create("10.0.2.1"), (error: unknown) => {
    assertRemoteError("rate_limited", 429)(error);
    return true;
  });

  // After the window and the TTL, a source may ask again.
  await clock.advance(2 * 60_000);
  await create("10.0.0.1");
});

test("a failed credential write rolls back to a cancelled request with nothing issued", async () => {
  const { service, stored, failNextSave } = harness();
  const { created } = await open(service);
  failNextSave();
  assert.deepEqual(await service.respond(created.requestId, "allow"), {
    requestId: created.requestId,
    state: "cancelled",
    failed: true,
  });
  const status = await service.poll(created.requestId, created.pollSecret);
  assert.equal(status.state, "cancelled");
  assert.equal(status.envelope, undefined);
  assert.equal(stored().devices.length, 0);
});

test("a grant that cannot be sealed revokes the device it just issued", async () => {
  const { service, stored, liveDevices } = harness({ displayName: () => "D".repeat(9_000) });
  const { created } = await open(service);
  const result = await service.respond(created.requestId, "allow");
  assert.equal(result?.state, "cancelled");
  assert.equal(result?.failed, true);
  assert.equal(stored().devices.length, 1);
  assert.equal(liveDevices().length, 0);
  assert.equal((await service.poll(created.requestId, created.pollSecret)).envelope, undefined);
});

test("concurrent decisions resolve once", async () => {
  const { service, stored } = harness();
  const { created } = await open(service);
  const [allow, deny, again] = await Promise.all([
    service.respond(created.requestId, "allow"),
    service.respond(created.requestId, "deny"),
    service.respond(created.requestId, "allow"),
  ]);
  assert.equal(allow?.state, "approved");
  // The later decisions observed the claimed request and did not act.
  assert.equal(deny?.state, "pending");
  assert.equal(again?.state, "pending");
  assert.equal(stored().devices.length, 1);
  assert.equal((await service.poll(created.requestId, created.pollSecret)).state, "approved");
});

test("a cancel that lands while Allow is committing revokes the new device", async () => {
  const { service, holdSaves, stored, liveDevices } = harness();
  const { created } = await open(service);
  const release = holdSaves();
  const deciding = service.respond(created.requestId, "allow");
  await flush();
  assert.equal(service.list()[0]?.approving, true);
  assert.deepEqual(await service.cancel(created.requestId, created.pollSecret), {
    requestId: created.requestId,
    state: "cancelled",
  });
  release();
  assert.equal((await deciding)?.state, "cancelled");
  await flush();
  assert.equal(liveDevices().length, 0);
  assert.ok(stored().devices.length <= 1);
  assert.equal((await service.poll(created.requestId, created.pollSecret)).envelope, undefined);
});

test("an approved grant nobody collected is revoked when it retires or the service closes", async () => {
  const { service, clock, liveDevices } = harness();
  const retired = await open(service, { source: "10.0.0.1", transport: "lan" });
  await service.respond(retired.created.requestId, "allow");
  assert.equal(liveDevices().length, 1);
  await clock.advance(60_000);
  assert.equal(liveDevices().length, 0);

  const closing = await open(service, { source: "10.0.0.2", transport: "lan" });
  await service.respond(closing.created.requestId, "allow");
  const collected = await open(service, { source: "10.0.0.3", transport: "lan" });
  await service.respond(collected.created.requestId, "allow");
  await service.poll(collected.created.requestId, collected.created.pollSecret);
  assert.equal(liveDevices().length, 2);
  await service.close();
  // Only the delivered credential survives.
  assert.equal(liveDevices().length, 1);
  await assert.rejects(
    service.create(
      { deviceName: "Mac", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey },
      { source: "10.0.0.4", transport: "lan" },
    ),
    assertRemoteError("pairing_closed", 403),
  );
});

test("a requester that cancels before or after collecting its grant leaves no working credential", async () => {
  const { service, liveDevices } = harness();
  const { created } = await open(service);
  await service.respond(created.requestId, "allow");
  assert.equal(liveDevices().length, 1);
  assert.equal((await service.cancel(created.requestId, created.pollSecret)).state, "cancelled");
  assert.equal(liveDevices().length, 0);

  // A requester that collected the envelope but could not install the
  // pairing withdraws it the same way, and the envelope is gone.
  const collected = await open(service, { source: "10.0.0.2", transport: "lan" });
  await service.respond(collected.created.requestId, "allow");
  assert.ok((await service.poll(collected.created.requestId, collected.created.pollSecret)).envelope);
  assert.equal(liveDevices().length, 1);
  assert.equal(
    (await service.cancel(collected.created.requestId, collected.created.pollSecret)).state,
    "cancelled",
  );
  assert.equal(liveDevices().length, 0);
  const after = await service.poll(collected.created.requestId, collected.created.pollSecret);
  assert.equal(after.state, "cancelled");
  assert.equal(after.envelope, undefined);
});

test("the reveal is one-shot and the prompt appears only after it", async () => {
  const { service, clock } = harness();
  const keys = generatePairingRequestKeyPair();
  const created = await service.create(
    { deviceName: "Linux box", deviceType: "linux", publicKey: keys.publicKey },
    DEFAULT_CONTEXT,
  );
  assert.equal(service.list().length, 0);
  // An unrevealed request cannot be allowed.
  assert.equal((await service.respond(created.requestId, "allow"))?.state, "pending");
  assert.throws(
    () => service.reveal(created.requestId, created.pollSecret, { requesterNonce: "short" }),
    assertRemoteError("invalid_request", 400),
  );
  const nonce = { requesterNonce: randomBytes(32).toString("base64url") };
  service.reveal(created.requestId, created.pollSecret, nonce);
  assert.equal(service.list().length, 1);
  assert.throws(
    () => service.reveal(created.requestId, created.pollSecret, nonce),
    assertRemoteError("pairing_already_used", 409),
  );

  const late = await service.create(
    { deviceName: "Linux box", deviceType: "linux", publicKey: keys.publicKey },
    { source: "10.9.9.9", transport: "lan" },
  );
  await clock.advance(2 * 60_000);
  assert.throws(
    () => service.reveal(late.requestId, late.pollSecret, nonce),
    assertRemoteError("pairing_expired", 403),
  );
});

test("a long-poll ends at its timeout, when replaced by a newer poll, or when aborted", async () => {
  const { service, clock } = harness();
  const { created } = await open(service);

  const timed = service.poll(created.requestId, created.pollSecret);
  await clock.advance(25_000);
  assert.equal((await timed).state, "pending");

  const older = service.poll(created.requestId, created.pollSecret);
  const newer = service.poll(created.requestId, created.pollSecret);
  assert.equal((await older).state, "pending");

  const controller = new AbortController();
  const aborted = service.poll(created.requestId, created.pollSecret, controller.signal);
  assert.equal((await newer).state, "pending");
  controller.abort();
  assert.equal((await aborted).state, "pending");
});
