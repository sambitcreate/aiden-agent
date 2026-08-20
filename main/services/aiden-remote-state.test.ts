import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  parseAidenRemoteStateDocument,
  type AidenRemoteStateDocument,
  type AidenRemoteStateStorage,
} from "./aiden-remote-state.js";

function fixture(initial?: unknown) {
  let stored = initial ?? createDefaultAidenRemoteState(() => Buffer.alloc(24, 7));
  const writes: AidenRemoteStateDocument[] = [];
  const storage: AidenRemoteStateStorage = {
    load: async () => structuredClone(stored),
    save: async (document) => {
      stored = structuredClone(document);
      writes.push(structuredClone(document));
    },
  };
  let randomCounter = 0;
  let now = 1_000;
  const registry = new AidenRemoteStateRegistry(storage, {
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++randomCounter),
    deriveCredentialDigest: async (credential, salt) =>
      createHash("sha256").update(credential).update(salt).digest(),
  });
  return {
    registry,
    writes,
    stored: () => structuredClone(stored),
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("remote device credentials persist only digests and authenticate with capability state", async () => {
  const state = fixture();
  await state.registry.initialize();
  const issued = await state.registry.issueDevice({
    name: "Sambit’s iPhone",
    type: "iphone",
    clientVersion: "1.0",
  });
  assert.match(issued.credential, /^[A-Za-z0-9_-]{43}$/u);
  const serialized = JSON.stringify(state.stored());
  assert.equal(serialized.includes(issued.credential), false);
  assert.equal(serialized.includes("credentialDigest"), true);
  assert.equal(serialized.includes("lookupDigest"), true);

  const authenticated = await state.registry.authenticate(issued.credential);
  assert.equal(authenticated?.id, issued.device.id);
  assert.equal(authenticated?.revoked, false);
  assert.equal(authenticated?.capabilities.has("workspace:manage"), true);
  assert.equal(await state.registry.authenticate("x".repeat(43)), null);
});

test("revocation is durable and preserves the revoked classification", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "iPad",
    type: "ipad",
    clientVersion: "1",
  });
  assert.equal(await state.registry.revokeDevice(issued.device.id), true);
  assert.equal(await state.registry.revokeDevice(issued.device.id), false);
  assert.equal((await state.registry.authenticate(issued.credential))?.revoked, true);
  assert.equal((await state.registry.listDevices())[0]?.revokedAt, 1_000);
});

test("state restore rejects excess keys, duplicate identities, and raw credentials", () => {
  const base = createDefaultAidenRemoteState(() => Buffer.alloc(24, 1));
  assert.throws(
    () => parseAidenRemoteStateDocument({ ...base, extra: true }),
    /state is invalid/u,
  );
  assert.throws(
    () =>
      parseAidenRemoteStateDocument({
        ...base,
        devices: [
          {
            id: "device",
            name: "Phone",
            type: "iphone",
            clientVersion: "1",
            lookupDigest: "a".repeat(43),
            credentialSalt: "b".repeat(43),
            credentialDigest: "c".repeat(43),
            capabilities: ["server:read"],
            createdAt: 1,
            lastSeenAt: 1,
            credential: "must-not-be-retained",
          },
        ],
      }),
    /invalid device/u,
  );
});

test("remote access is off by default and persists an explicit listen mode", async () => {
  const state = fixture();
  assert.equal((await state.registry.initialize()).enabled, false);
  assert.equal((await state.registry.snapshot()).connectionMode, "lan");
  await state.registry.setConnectionMode("both");
  assert.equal((await state.registry.snapshot()).connectionMode, "both");
});

test("last-seen persistence is throttled and never reactivates a revoked device", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "Phone",
    type: "iphone",
    clientVersion: "1",
  });
  const writesAfterIssue = state.writes.length;
  state.setNow(1_000 + 60_000);
  await state.registry.authenticate(issued.credential);
  assert.equal(state.writes.length, writesAfterIssue);
  state.setNow(1_000 + 6 * 60_000);
  await state.registry.authenticate(issued.credential);
  assert.equal(state.writes.length, writesAfterIssue + 1);
  await state.registry.revokeDevice(issued.device.id);
  state.setNow(1_000 + 12 * 60_000);
  assert.equal((await state.registry.authenticate(issued.credential))?.revoked, true);
});
