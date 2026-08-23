import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  defaultAidenRemoteDisplayName,
  parseAidenRemoteStateDocument,
  type AidenRemoteStateDocument,
  type AidenRemoteStateStorage,
} from "./aiden-remote-state.js";

function fixture(initial?: unknown) {
  let stored = initial ?? createDefaultAidenRemoteState(() => Buffer.alloc(24, 7));
  const writes: AidenRemoteStateDocument[] = [];
  let failNextSave = false;
  const storage: AidenRemoteStateStorage = {
    load: async () => structuredClone(stored),
    save: async (document) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("disk unavailable");
      }
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
    stored: () => structuredClone(stored) as AidenRemoteStateDocument,
    setNow: (value: number) => {
      now = value;
    },
    failNextSave: () => {
      failNextSave = true;
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
  assert.equal(state.stored().devices[0]?.acceptsBotCapabilities, false);
  assert.equal(issued.device.lastSeenAt, 0);

  const authenticated = await state.registry.authenticate(issued.credential);
  assert.equal(authenticated?.id, issued.device.id);
  assert.equal(authenticated?.revoked, false);
  assert.equal(authenticated?.capabilities.has("workspace:manage"), true);
  assert.equal(authenticated?.capabilities.has("bot:read"), false);
  assert.equal(authenticated?.capabilities.has("bot:write"), false);
  assert.equal(authenticated?.acceptsBotCapabilities, false);
  assert.equal((await state.registry.listDevices())[0]?.lastSeenAt, 1_000);
  assert.equal(await state.registry.authenticate("x".repeat(43)), null);
});

test("Bot vocabulary negotiation persists independently from device authority", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "Bot-aware iPhone",
    type: "iphone",
    clientVersion: "2.0",
    capabilities: ["server:read"],
    acceptsBotCapabilities: true,
  });

  assert.equal(state.stored().devices[0]?.acceptsBotCapabilities, true);
  const authenticated = await state.registry.authenticate(issued.credential);
  assert.equal(authenticated?.acceptsBotCapabilities, true);
  assert.deepEqual([...authenticated!.capabilities], ["server:read"]);
  assert.equal(authenticated?.capabilities.has("bot:read"), false);
  assert.equal(authenticated?.capabilities.has("bot:write"), false);
});

test("Bot-aware devices preserve only coherent explicitly negotiated Bot grants", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "Bot-authorized iPhone",
    type: "iphone",
    clientVersion: "2.0",
    capabilities: ["server:read", "bot:read", "bot:write"],
    acceptsBotCapabilities: true,
  });

  const authenticated = await state.registry.authenticate(issued.credential);
  assert.equal(authenticated?.acceptsBotCapabilities, true);
  assert.deepEqual(
    [...authenticated!.capabilities],
    ["server:read", "bot:read", "bot:write"],
  );
});

test("device issuance checks pairing authorization inside the durable mutation", async () => {
  const state = fixture();
  await assert.rejects(
    state.registry.issueDevice({
      name: "Invalid iPhone",
      type: "iphone",
      clientVersion: "1",
      acceptsBotCapabilities: "yes" as never,
    }),
    /device metadata/u,
  );
  await assert.rejects(
    state.registry.issueDevice({
      name: "Write-only Bot iPhone",
      type: "iphone",
      clientVersion: "2",
      capabilities: ["server:read", "bot:write"],
      acceptsBotCapabilities: true,
    }),
    /device capabilities/u,
  );
  await assert.rejects(
    state.registry.issueDevice({
      name: "Non-negotiating Bot iPhone",
      type: "iphone",
      clientVersion: "2",
      capabilities: ["server:read", "bot:read"],
      acceptsBotCapabilities: false,
    }),
    /device capabilities/u,
  );
  await assert.rejects(
    state.registry.issueDevice({
      name: "Cancelled iPhone",
      type: "iphone",
      clientVersion: "1",
      authorizeCommit: () => false,
    }),
    (error: unknown) => (error as { code?: string }).code === "pairing_closed",
  );
  assert.deepEqual(await state.registry.listDevices(), []);
  assert.equal(state.writes.length, 0);
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

test("revocation fences new device work and waits for already-admitted work without blocking another device", async () => {
  const state = fixture();
  const first = await state.registry.issueDevice({
    name: "First iPhone",
    type: "iphone",
    clientVersion: "1",
  });
  const second = await state.registry.issueDevice({
    name: "Second iPhone",
    type: "iphone",
    clientVersion: "1",
  });
  const releaseFirst = state.registry.acquireDeviceAuthorization(first.device.id);
  let revocationSettled = false;
  const revocation = state.registry.revokeDevice(first.device.id).finally(() => {
    revocationSettled = true;
  });
  await Promise.resolve();
  assert.equal(revocationSettled, false);
  assert.ok((await state.registry.snapshot()).devices.find(({ id }) => id === first.device.id)?.revokedAt);
  assert.throws(
    () => state.registry.acquireDeviceAuthorization(first.device.id),
    (error: unknown) => (error as { code?: string }).code === "credential_revoked",
  );
  const releaseSecond = state.registry.acquireDeviceAuthorization(second.device.id);
  releaseSecond();

  releaseFirst();
  assert.equal(await revocation, true);
  assert.equal((await state.registry.authenticate(first.credential))?.revoked, true);
  assert.equal((await state.registry.authenticate(second.credential))?.revoked, false);
});

test("failed revocation persistence reopens authorization for the still-valid device", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "iPhone",
    type: "iphone",
    clientVersion: "1",
  });
  state.failNextSave();
  await assert.rejects(state.registry.revokeDevice(issued.device.id), /disk unavailable/u);
  const release = state.registry.acquireDeviceAuthorization(issued.device.id);
  release();
  assert.equal((await state.registry.authenticate(issued.credential))?.revoked, false);
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
  const initial = await state.registry.initialize();
  assert.equal(initial.enabled, false);
  assert.equal(initial.lanPortCommitted, false);
  assert.equal((await state.registry.snapshot()).connectionMode, "lan");
  await state.registry.setConnectionMode("both");
  assert.equal((await state.registry.snapshot()).connectionMode, "both");
});

test("pending Tailscale outcomes are bounded and commit atomically with ownership", async () => {
  const state = fixture();
  const target = "http://127.0.0.1:49221/api/aiden/v1";
  const pending = {
    operation: "connect" as const,
    target,
    beforeFingerprint: "a".repeat(64),
    preservedFingerprint: "b".repeat(64),
    normalizeListenerScaffolding: true,
    createdAt: 1_000,
  };
  await state.registry.beginTailscalePendingOutcome(pending);
  assert.deepEqual((state.stored() as AidenRemoteStateDocument).tailscalePendingOutcome, pending);
  await assert.rejects(
    state.registry.beginTailscalePendingOutcome({ ...pending, operation: "disconnect" }),
    /tailscale_reconciliation_required/u,
  );
  await state.registry.commitTailscaleOutcome({ path: "/api/aiden/v1", target });
  assert.deepEqual((state.stored() as AidenRemoteStateDocument).tailscaleOwnership, { path: "/api/aiden/v1", target });
  assert.equal((state.stored() as AidenRemoteStateDocument).tailscalePendingOutcome, undefined);
  assert.throws(
    () => parseAidenRemoteStateDocument({
      ...state.stored(),
      tailscalePendingOutcome: { ...pending, beforeFingerprint: "not-a-digest" },
    }),
    /invalid pending Tailscale outcome/u,
  );
});

test("legacy endpoint commitment is inferred conservatively and persisted", async () => {
  const freshLegacy = createDefaultAidenRemoteState(() => Buffer.alloc(24, 2));
  delete (freshLegacy as Partial<AidenRemoteStateDocument>).lanPortCommitted;
  assert.equal(parseAidenRemoteStateDocument(freshLegacy).lanPortCommitted, false);

  const enabledLegacy = { ...freshLegacy, enabled: true };
  assert.equal(parseAidenRemoteStateDocument(enabledLegacy).lanPortCommitted, true);

  const pairedLegacy = createDefaultAidenRemoteState(() => Buffer.alloc(24, 3));
  delete (pairedLegacy as Partial<AidenRemoteStateDocument>).lanPortCommitted;
  const paired = fixture(pairedLegacy);
  await paired.registry.issueDevice({ name: "Phone", type: "iphone", clientVersion: "1" });
  const pairedDocument = paired.stored();
  delete (pairedDocument as Partial<AidenRemoteStateDocument>).lanPortCommitted;
  assert.equal(parseAidenRemoteStateDocument(pairedDocument).lanPortCommitted, true);

  const migrated = fixture(freshLegacy);
  const initialized = await migrated.registry.initialize();
  assert.equal(initialized.lanPortCommitted, false);
  assert.equal((migrated.stored() as AidenRemoteStateDocument).lanPortCommitted, false);
  assert.equal(migrated.writes.length, 1);
});

test("legacy devices default Bot vocabulary negotiation to false and persist the migration", async () => {
  const source = fixture();
  const issued = await source.registry.issueDevice({
    name: "Legacy iPhone",
    type: "iphone",
    clientVersion: "1",
  });
  const legacy = source.stored();
  legacy.devices[0]!.capabilities.push("bot:write");
  delete (legacy.devices[0] as { acceptsBotCapabilities?: boolean })
    .acceptsBotCapabilities;

  const migrated = fixture(legacy);
  const initialized = await migrated.registry.initialize();
  assert.equal(initialized.devices[0]?.acceptsBotCapabilities, false);
  assert.equal(initialized.devices[0]?.capabilities.includes("bot:write"), false);
  assert.equal(migrated.stored().devices[0]?.acceptsBotCapabilities, false);
  assert.equal(migrated.stored().devices[0]?.capabilities.includes("bot:write"), false);
  assert.equal(migrated.writes.length, 1);
  const authenticated = await migrated.registry.authenticate(issued.credential);
  assert.equal(authenticated?.acceptsBotCapabilities, false);
  assert.equal(authenticated?.capabilities.has("bot:write"), false);

  const explicitLegacy = source.stored();
  explicitLegacy.devices[0]!.capabilities.push("bot:read", "bot:write");
  explicitLegacy.devices[0]!.acceptsBotCapabilities = false;
  const sanitized = fixture(explicitLegacy);
  await sanitized.registry.initialize();
  assert.equal(sanitized.writes.length, 1);
  assert.equal(sanitized.stored().devices[0]?.capabilities.includes("bot:read"), false);
  assert.equal(sanitized.stored().devices[0]?.capabilities.includes("bot:write"), false);

  const invalid = source.stored();
  (invalid.devices[0] as { acceptsBotCapabilities: unknown })
    .acceptsBotCapabilities = "yes";
  assert.throws(
    () => parseAidenRemoteStateDocument(invalid),
    /invalid device/u,
  );

  const writeOnly = source.stored();
  writeOnly.devices[0]!.acceptsBotCapabilities = true;
  writeOnly.devices[0]!.capabilities = ["server:read", "bot:write"];
  assert.throws(
    () => parseAidenRemoteStateDocument(writeOnly),
    /invalid device/u,
  );
});

test("authentication revalidates Bot negotiation and capability implication", async () => {
  const stripped = fixture();
  const strippedCredential = await stripped.registry.issueDevice({
    name: "Bot iPhone",
    type: "iphone",
    clientVersion: "2",
    capabilities: ["server:read", "bot:read", "bot:write"],
    acceptsBotCapabilities: true,
  });
  const strippedDocument = (
    stripped.registry as unknown as { document: AidenRemoteStateDocument }
  ).document;
  strippedDocument.devices[0]!.acceptsBotCapabilities = false;
  const strippedAuthentication = await stripped.registry.authenticate(
    strippedCredential.credential,
  );
  assert.equal(strippedAuthentication?.acceptsBotCapabilities, false);
  assert.equal(strippedAuthentication?.capabilities.has("server:read"), true);
  assert.equal(strippedAuthentication?.capabilities.has("bot:read"), false);
  assert.equal(strippedAuthentication?.capabilities.has("bot:write"), false);

  const rejected = fixture();
  const rejectedCredential = await rejected.registry.issueDevice({
    name: "Bot iPad",
    type: "ipad",
    clientVersion: "2",
    capabilities: ["server:read", "bot:read", "bot:write"],
    acceptsBotCapabilities: true,
  });
  const rejectedDocument = (
    rejected.registry as unknown as { document: AidenRemoteStateDocument }
  ).document;
  rejectedDocument.devices[0]!.capabilities = ["server:read", "bot:write"];
  assert.equal(await rejected.registry.authenticate(rejectedCredential.credential), null);
});

test("committing an endpoint is durable, idempotent, and validates complete port pairs", async () => {
  const state = fixture();
  await state.registry.initialize();
  await state.registry.commitLanPort(50_200);
  assert.equal((state.stored() as AidenRemoteStateDocument).lanPort, 50_200);
  assert.equal((state.stored() as AidenRemoteStateDocument).lanPortCommitted, true);
  const writesAfterCommit = state.writes.length;
  await state.registry.commitLanPort(50_200);
  assert.equal(state.writes.length, writesAfterCommit);
  await assert.rejects(state.registry.commitLanPort(65_535), /listener port/u);
  await assert.rejects(state.registry.commitLanPort(50_201), /listener port/u);
});

test("legacy state gains a bounded computer label without changing stable identity", async () => {
  const legacy = createDefaultAidenRemoteState(() => Buffer.alloc(24, 4));
  const instanceId = legacy.instanceId;
  delete (legacy as Partial<AidenRemoteStateDocument>).displayName;
  const migrated = parseAidenRemoteStateDocument(legacy, "Sambit’s Mac Studio.local");
  assert.equal(migrated.instanceId, instanceId);
  assert.equal(migrated.displayName, "Sambit’s Mac Studio");
  assert.equal(defaultAidenRemoteDisplayName("   "), "Aiden Agent");

  const persisted = fixture(legacy);
  const initialized = await persisted.registry.initialize();
  assert.equal(initialized.instanceId, instanceId);
  assert.equal(initialized.displayName, "Aiden Agent");
  assert.equal((persisted.stored() as AidenRemoteStateDocument).displayName, "Aiden Agent");
  assert.equal(persisted.writes.length, 1, "initialization durably writes the normalized legacy document");
});

test("current state initialization is read-only when no migration is needed", async () => {
  const current = createDefaultAidenRemoteState(() => Buffer.alloc(24, 5), "Current Mac");
  const state = fixture(current);
  const initialized = await state.registry.initialize();
  assert.equal(initialized.displayName, "Current Mac");
  assert.equal(state.writes.length, 0);
});

test("production-shaped storage durably seeds missing files and migrates legacy labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-remote-state-storage-"));
  const filename = "aiden-remote-state.json";
  const makeRegistry = () => {
    const store = new DataStore<AidenRemoteStateDocument>(
      filename,
      createDefaultAidenRemoteState(() => Buffer.alloc(24, 9), "Studio Mac"),
      () => root,
      { normalize: (value) => parseAidenRemoteStateDocument(value, "Studio Mac") },
    );
    return new AidenRemoteStateRegistry({
      load: () => store.load(),
      needsSaveAfterLoad: async () => {
        const contents = await store.loadedDiskContents();
        if (contents === null) return true;
        const raw = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
        return !("displayName" in raw) || !("lanPortCommitted" in raw);
      },
      save: (document) => store.save(document),
    });
  };

  try {
    const seeded = await makeRegistry().initialize();
    const seededDisk = JSON.parse(await readFile(join(root, filename), "utf8")) as AidenRemoteStateDocument;
    assert.equal(seededDisk.instanceId, seeded.instanceId);
    assert.equal(seededDisk.displayName, "Studio Mac");
    assert.equal(seededDisk.lanPortCommitted, false);

    const legacy = createDefaultAidenRemoteState(() => Buffer.alloc(24, 3), "Old Name");
    delete (legacy as Partial<AidenRemoteStateDocument>).displayName;
    delete (legacy as Partial<AidenRemoteStateDocument>).lanPortCommitted;
    await writeFile(join(root, filename), JSON.stringify(legacy), { mode: 0o600 });
    const migrated = await makeRegistry().initialize();
    const migratedDisk = JSON.parse(await readFile(join(root, filename), "utf8")) as AidenRemoteStateDocument;
    assert.equal(migrated.instanceId, legacy.instanceId);
    assert.equal(migratedDisk.displayName, "Studio Mac");
    assert.equal(migratedDisk.lanPortCommitted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renaming a Mac label is durable and never rotates instance or device identity", async () => {
  const state = fixture();
  const before = await state.registry.initialize();
  const issued = await state.registry.issueDevice({
    name: "Phone",
    type: "iphone",
    clientVersion: "1",
  });
  await state.registry.setDisplayName("  Studio   Mac  ");
  const after = await state.registry.snapshot();
  assert.equal(after.displayName, "Studio Mac");
  assert.equal(after.instanceId, before.instanceId);
  assert.equal(after.devices[0]?.id, issued.device.id);
  await assert.rejects(state.registry.setDisplayName("\n"), /display name/u);
  await assert.rejects(state.registry.setDisplayName("x".repeat(81)), /display name/u);
});

test("first authentication is durable, later last-seen writes are throttled, and revocation wins", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "Phone",
    type: "iphone",
    clientVersion: "1",
  });
  const writesAfterIssue = state.writes.length;
  state.setNow(1_000 + 60_000);
  await state.registry.authenticate(issued.credential);
  assert.equal(state.writes.length, writesAfterIssue + 1);
  await state.registry.authenticate(issued.credential);
  assert.equal(state.writes.length, writesAfterIssue + 1);
  state.setNow(1_000 + 7 * 60_000);
  await state.registry.authenticate(issued.credential);
  assert.equal(state.writes.length, writesAfterIssue + 2);
  await state.registry.revokeDevice(issued.device.id);
  state.setNow(1_000 + 12 * 60_000);
  assert.equal((await state.registry.authenticate(issued.credential))?.revoked, true);
});

test("concurrent first authenticated requests produce one durable connection transition", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "Phone",
    type: "iphone",
    clientVersion: "1",
  });
  const writesAfterIssue = state.writes.length;
  state.setNow(2_000);

  const authenticated = await Promise.all(
    Array.from({ length: 8 }, () => state.registry.authenticate(issued.credential)),
  );

  assert.equal(authenticated.every((device) => device?.id === issued.device.id), true);
  assert.equal(state.writes.length, writesAfterIssue + 1);
  assert.equal((await state.registry.listDevices())[0]?.lastSeenAt, 2_000);
});

test("a failed first-contact save remains pending and retries durably", async () => {
  const state = fixture();
  const issued = await state.registry.issueDevice({
    name: "Phone",
    type: "iphone",
    clientVersion: "1",
  });
  state.setNow(2_000);
  state.failNextSave();

  await assert.rejects(state.registry.authenticate(issued.credential), /disk unavailable/u);
  assert.equal((await state.registry.listDevices())[0]?.lastSeenAt, 0);
  assert.equal((await state.registry.authenticate(issued.credential))?.revoked, false);
  assert.equal((await state.registry.listDevices())[0]?.lastSeenAt, 2_000);
});

test("revocation completed during credential verification wins before authentication returns", async () => {
  let stored = createDefaultAidenRemoteState(() => Buffer.alloc(24, 5));
  let blockDigest = false;
  let releaseDigest: (() => void) | undefined;
  const digestGate = new Promise<void>((resolve) => {
    releaseDigest = resolve;
  });
  const registry = new AidenRemoteStateRegistry(
    {
      load: async () => structuredClone(stored),
      save: async (document) => {
        stored = structuredClone(document);
      },
    },
    {
      now: () => 3_000,
      randomBytes: (size) => Buffer.alloc(size, 9),
      deriveCredentialDigest: async (credential, salt) => {
        if (blockDigest) await digestGate;
        return createHash("sha256").update(credential).update(salt).digest();
      },
    },
  );
  const issued = await registry.issueDevice({
    name: "Phone",
    type: "iphone",
    clientVersion: "1",
  });
  blockDigest = true;
  const authentication = registry.authenticate(issued.credential);
  await Promise.resolve();
  assert.equal(await registry.revokeDevice(issued.device.id), true);
  releaseDigest?.();

  assert.equal((await authentication)?.revoked, true);
  assert.equal((await registry.listDevices())[0]?.lastSeenAt, 0);
});
