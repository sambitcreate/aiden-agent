import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../renderer/shared/bot-capabilities.js";
import { createBotCapabilityOpaqueKeyStore } from "./bot-capability-key-store.js";
import { BotCapabilityLeaseRegistry } from "./bot-capability-lease.js";
import {
  BotCapabilityCommitUncertainError,
  createBotCapabilityStateCheckpoint,
  withBotCapabilityStateCheckpoint,
  type BotCapabilityBootstrapMarker,
  type BotCapabilityBootstrapMarkerState,
  type BotCapabilityInitialBootstrapDisposition,
  type BotCapabilityRollbackAnchor,
  type BotCapabilityStateCheckpoint,
} from "./bot-capability-state-checkpoint.js";
import {
  BotCapabilityUnavailableError,
  emptyBotCapabilityState,
  type BotCapabilityState,
} from "./bot-capability-store-core.js";
import {
  createBotCapabilityStore,
  type BotCapabilityPersistence,
} from "./bot-capability-store.js";
import { BotRuntimeInventoryLeaseRegistry } from "./bot-runtime-inventory-lease.js";

const stateFile = "bot-capabilities.json";
const headFile = "bot-capability-state-head.json";
const sealFile = "bot-capability-migration-seal.json";
const serviceRoot = (root: string) => join(root, "bot-service");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface TestAnchor extends BotCapabilityRollbackAnchor {
  value: string | null;
  failNextStore: boolean;
  marker: TestBootstrapMarker;
}

interface TestBootstrapMarker extends BotCapabilityBootstrapMarker {
  value: BotCapabilityBootstrapMarkerState | null;
  failAfterPhase: BotCapabilityBootstrapMarkerState["phase"] | null;
}

function memoryAnchor(): TestAnchor {
  const marker: TestBootstrapMarker = {
    value: null,
    failAfterPhase: null,
    async load() {
      return this.value ? { ...this.value } : null;
    },
    async store(next, expected) {
      assert.deepEqual(this.value, expected);
      this.value = { ...next };
      if (this.failAfterPhase === next.phase) {
        this.failAfterPhase = null;
        throw new Error(`simulated marker crash after ${next.phase}`);
      }
    },
  };
  return {
    value: null,
    failNextStore: false,
    marker,
    async load() {
      return this.value;
    },
    async store(value, expected) {
      if (this.value !== expected) throw new Error("anchor conflict");
      if (this.failNextStore) {
        this.failNextStore = false;
        throw new Error("simulated anchor crash");
      }
      this.value = value;
    },
  };
}

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiden-bot-capability-head-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function protectedStore(
  root: string,
  anchor: TestAnchor,
  seams: {
    beforeHeadWrite?: (phase: "pending" | "committed") => Promise<void>;
    afterHeadWrite?: (phase: "pending" | "committed") => Promise<void>;
  } = {},
  inspectInitialBootstrap: () =>
    | BotCapabilityInitialBootstrapDisposition
    | Promise<BotCapabilityInitialBootstrapDisposition> = () => "clean",
) {
  let incarnation = 0;
  const keyStore = createBotCapabilityOpaqueKeyStore({
    root: () => serviceRoot(root),
    randomKey: () => Buffer.alloc(32, 31),
  });
  return createBotCapabilityStore({
    root: () => serviceRoot(root),
    now: () => 42,
    mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
    mintIncarnation: () => Buffer.alloc(32, ++incarnation).toString("base64url"),
    leases: new BotCapabilityLeaseRegistry(),
    checkpoint: createBotCapabilityStateCheckpoint({
      root: () => serviceRoot(root),
      keyStore,
      anchor,
      bootstrapMarker: anchor.marker,
      inspectInitialBootstrap,
      ...seams,
    }),
  });
}

function testCatalog() {
  return {
    revision: "catalog:one",
    providers: [],
    fileScopes: [],
    shellAvailable: false,
    connections: [],
    skills: [],
    otherCapabilities: [],
    notice: {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true as const,
    },
  };
}

async function addFullPolicy(
  store: ReturnType<typeof protectedStore>,
  botId = "bot:one",
): Promise<void> {
  await store.createBotPolicy({
    botId,
    catalog: testCatalog(),
    access: {
      accessMode: "full",
      catalogRevision: "catalog:one",
      confirmedForeground: true,
    },
  });
}

async function readHead(
  root: string,
): Promise<{ phase: string; sequence: number }> {
  const value = JSON.parse(
    await readFile(join(serviceRoot(root), headFile), "utf8"),
  ) as {
    phase: string;
    sequence: number;
  };
  return { phase: value.phase, sequence: value.sequence };
}

test("checkpoint persistence forwards the inventory fence through its publication callback", async () => {
  let persisted = emptyBotCapabilityState();
  let commitEntered!: () => void;
  const entered = new Promise<void>((resolve) => { commitEntered = resolve; });
  let releaseCommit!: () => void;
  const released = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const persistence: BotCapabilityPersistence = {
    async load() { return structuredClone(persisted); },
    async save(next, isCurrent = () => true) {
      if (!isCurrent()) throw new Error("inventory publication is stale");
      persisted = structuredClone(next);
    },
    async update<Result>(
      mutation: (draft: BotCapabilityState) => Result | Promise<Result>,
      isCurrent = () => true,
    ) {
      const next = structuredClone(persisted);
      const result = await mutation(next);
      if (!isCurrent()) throw new Error("inventory publication is stale");
      persisted = next;
      return result;
    },
    async loadedFromCorruptFile() { return false; },
    async loadedFromUnsafeFile() { return false; },
    async loadedDiskContents() { return null; },
  };
  const checkpoint: BotCapabilityStateCheckpoint = {
    async initialize() {},
    async commit(_previous, _next, publish) {
      commitEntered();
      await released;
      return publish();
    },
  };
  const protectedPersistence = withBotCapabilityStateCheckpoint(
    persistence,
    checkpoint,
  );
  await protectedPersistence.load();
  const inventory = new BotRuntimeInventoryLeaseRegistry();
  const lease = inventory.acquire();
  const update = protectedPersistence.update((draft) => {
    draft.sequence += 1;
  }, () => {
    lease.assertCurrent();
    return true;
  });
  await entered;
  inventory.invalidate("skill_content");
  releaseCommit();

  await assert.rejects(update, /capabilities changed/u);
  assert.equal(persisted.sequence, 0);
});

test("independent authority rejects a valid older capability document", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  const oldState = await readFile(join(serviceRoot(root), stateFile));
  await addFullPolicy(first);
  await writeFile(join(serviceRoot(root), stateFile), oldState);

  await assert.rejects(
    protectedStore(root, anchor).initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /independent rollback authority/u.test(error.message),
  );
});

test("independent authority rejects offline rollback of protected archive state", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  await addFullPolicy(first);
  const activeState = await readFile(join(serviceRoot(root), stateFile));
  await first.archiveBotAuthority("bot:one");
  await first.assertBotAuthorityMatchesIdentity({ botId: "bot:one", archived: true });
  await writeFile(join(serviceRoot(root), stateFile), activeState);

  await assert.rejects(
    protectedStore(root, anchor).initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /independent rollback authority/u.test(error.message),
  );
});

test("incarnations share the protected high-water chain and ignore the retired sidecar", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  const [original] = await first.reconcileNamespace("provider", [{
    sourceId: "provider-one",
    credentialSignature: digest("credential-a"),
  }]);
  const originalState = await readFile(join(serviceRoot(root), stateFile));
  const [rotated] = await first.reconcileNamespace("provider", [{
    sourceId: "provider-one",
    credentialSignature: digest("credential-b"),
  }]);
  assert.notEqual(rotated?.credentialIncarnation, original?.credentialIncarnation);

  await writeFile(
    join(serviceRoot(root), "bot-capability-incarnations.json"),
    JSON.stringify({ version: 1, namespaces: { provider: [], mcp: [], skill: [] } }),
    { mode: 0o600 },
  );
  assert.deepEqual(
    (await first.reconcileNamespace("provider", [{
      sourceId: "provider-one",
      credentialSignature: digest("credential-b"),
    }]))[0],
    rotated,
  );

  await writeFile(join(serviceRoot(root), stateFile), originalState);
  await assert.rejects(
    protectedStore(root, anchor).initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /independent rollback authority/u.test(error.message),
  );
});

test("an interrupted incarnation commit recovers exactly the published generation", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  anchor.failNextStore = true;
  await assert.rejects(
    first.reconcileNamespace("skill", [{
      sourceId: "skill-one",
      credentialSignature: digest("absent"),
    }]),
    BotCapabilityCommitUncertainError,
  );
  const published = JSON.parse(
    await readFile(join(serviceRoot(root), stateFile), "utf8"),
  ) as { incarnations: { skill: Array<{ resourceIncarnation: string }> } };

  const restarted = protectedStore(root, anchor);
  await restarted.initialize();
  const [recovered] = await restarted.reconcileNamespace("skill", [{
    sourceId: "skill-one",
    credentialSignature: digest("absent"),
  }]);
  assert.equal(
    recovered?.resourceIncarnation,
    published.incarnations.skill[0]?.resourceIncarnation,
  );
});

test("initial bootstrap supports clean and one-time legacy profiles but rejects unknown inventory", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  let disposition: BotCapabilityInitialBootstrapDisposition = "deny";
  const store = protectedStore(root, anchor, {}, () => disposition);

  await assert.rejects(
    store.initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /authority is missing/u.test(error.message),
  );
  assert.equal(anchor.value, null);
  assert.equal(anchor.marker.value, null);

  disposition = "clean";
  await store.initialize();
  assert.ok(anchor.value);
  const markerAfterBootstrap = await anchor.marker.load();
  assert.equal(markerAfterBootstrap?.phase, "consumed");
  assert.deepEqual(await readHead(root), { phase: "committed", sequence: 0 });
});

test("a first legacy profile consumes bootstrap once and migrates explicit Full policies", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const store = protectedStore(root, anchor, {}, () => "legacy");
  await store.initialize();
  const [policy] = await store.migrateLegacyBotsToFull({
    botIds: ["bot:legacy"],
    chats: [{ chatId: "chat:legacy", botId: "bot:legacy" }],
    catalogRevision: "catalog:one",
    confirmedExplicitFull: true,
  });

  assert.equal(policy?.accessMode, "full");
  assert.equal((await store.getChatPolicy("chat:legacy")).mode, "inherit");
  assert.equal(anchor.marker.value?.phase, "consumed");
});

test("a consumed marker blocks authority loss from reopening legacy Full migration", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor, {}, () => "legacy");
  await first.initialize();
  await first.migrateLegacyBotsToFull({
    botIds: ["bot:legacy"],
    catalogRevision: "catalog:one",
    confirmedExplicitFull: true,
  });

  await rm(serviceRoot(root), { recursive: true, force: true });
  anchor.value = null;
  await assert.rejects(
    protectedStore(root, anchor, {}, () => "legacy").initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /bootstrap was consumed/u.test(error.message),
  );
  assert.equal(anchor.value, null);
  assert.equal(anchor.marker.value?.phase, "consumed");
});

test("key-bound bootstrap marker resumes crashes idempotently and mismatched keys fail closed", async (t) => {
  await t.test("after pending claim", async () => {
    const root = join(await temporaryRoot(t), "pending");
    const anchor = memoryAnchor();
    anchor.marker.failAfterPhase = "pending";
    await assert.rejects(
      protectedStore(root, anchor).initialize(),
      /simulated marker crash after pending/u,
    );
    assert.equal(anchor.value, null);
    assert.equal(anchor.marker.value?.phase, "pending");

    await protectedStore(root, anchor).initialize();
    assert.ok(anchor.value);
    assert.equal(anchor.marker.value?.phase, "consumed");
  });

  await t.test("after anchor creation", async () => {
    const root = join(await temporaryRoot(t), "anchor");
    const anchor = memoryAnchor();
    anchor.marker.failAfterPhase = "consumed";
    await assert.rejects(
      protectedStore(root, anchor).initialize(),
      /simulated marker crash after consumed/u,
    );
    assert.ok(anchor.value);
    assert.equal(anchor.marker.value?.phase, "consumed");

    await protectedStore(root, anchor).initialize();
    assert.deepEqual(await readHead(root), { phase: "committed", sequence: 0 });
  });

  await t.test("pending marker with a replaced local key", async () => {
    const root = join(await temporaryRoot(t), "key-loss");
    const anchor = memoryAnchor();
    anchor.marker.failAfterPhase = "pending";
    await assert.rejects(protectedStore(root, anchor).initialize());
    await writeFile(
      join(serviceRoot(root), "capability-opaque-key.bin"),
      Buffer.alloc(32, 32),
      { mode: 0o600 },
    );

    await assert.rejects(
      protectedStore(root, anchor).initialize(),
      (error: unknown) =>
        error instanceof BotCapabilityUnavailableError &&
        /does not match its installation key/u.test(error.message),
    );
  });
});

test("restoring state, local head, seal, and opaque key together cannot roll back authority", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  await addFullPolicy(first);
  await first.acknowledgeNotice("device:a", {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: "continue_full",
    confirmedForeground: true,
  });
  await writeFile(
    join(serviceRoot(root), sealFile),
    JSON.stringify({ version: 1, sealedAt: 42 }),
    { mode: 0o600 },
  );
  const snapshot = join(root, "old-bot-service-snapshot");
  await cp(serviceRoot(root), snapshot, { recursive: true });

  await first.revokeNoticeAudience("device:a");
  await rm(serviceRoot(root), { recursive: true, force: true });
  await cp(snapshot, serviceRoot(root), { recursive: true });

  await assert.rejects(
    protectedStore(root, anchor).initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /independent rollback authority/u.test(error.message),
  );
});

test("deleting only the local crash journal is repaired from independent authority", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  await unlink(join(serviceRoot(root), headFile));

  await protectedStore(root, anchor).initialize();
  assert.deepEqual(await readHead(root), { phase: "committed", sequence: 0 });
});

test("an interrupted commit before state publication recovers only the previous authority", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  let crashOnPending = false;
  const first = protectedStore(root, anchor, {
    afterHeadWrite: async (phase) => {
      if (phase === "pending" && crashOnPending)
        throw new Error("simulated crash");
    },
  });
  await first.initialize();
  crashOnPending = true;
  await assert.rejects(addFullPolicy(first), /simulated crash/u);

  const restarted = protectedStore(root, anchor);
  await restarted.initialize();
  await assert.rejects(
    restarted.getBotPolicy("bot:one"),
    BotCapabilityUnavailableError,
  );
  assert.deepEqual(await readHead(root), { phase: "committed", sequence: 0 });
});

test("an interrupted commit after state publication recovers exactly the new authority", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  anchor.failNextStore = true;
  await assert.rejects(addFullPolicy(first), BotCapabilityCommitUncertainError);
  assert.equal((await readHead(root)).phase, "pending");
  await assert.rejects(
    first.getBotPolicy("bot:one"),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /restart Aiden/iu.test(error.message),
  );

  const restarted = protectedStore(root, anchor);
  await restarted.initialize();
  assert.equal((await restarted.getBotPolicy("bot:one")).accessMode, "full");
  assert.deepEqual(await readHead(root), { phase: "committed", sequence: 1 });
});

test("checkpoint authentication is bound to the opaque key", async (t) => {
  const root = await temporaryRoot(t);
  const anchor = memoryAnchor();
  const first = protectedStore(root, anchor);
  await first.initialize();
  const head = JSON.parse(
    await readFile(join(serviceRoot(root), headFile), "utf8"),
  ) as {
    mac: string;
  };
  head.mac = `${head.mac.slice(0, -1)}${head.mac.endsWith("0") ? "1" : "0"}`;
  await writeFile(join(serviceRoot(root), headFile), JSON.stringify(head), {
    mode: 0o600,
  });

  await assert.rejects(
    protectedStore(root, anchor).initialize(),
    (error: unknown) =>
      error instanceof BotCapabilityUnavailableError &&
      /authentication failed/u.test(error.message),
  );
});

test("record deletions advance the authenticated document commit sequence", async (t) => {
  await t.test("notice revocation", async () => {
    const root = join(await temporaryRoot(t), "notice");
    const anchor = memoryAnchor();
    const store = protectedStore(root, anchor);
    await store.initialize();
    await addFullPolicy(store);
    await store.acknowledgeNotice("device:a", {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      decision: "continue_full",
      confirmedForeground: true,
    });
    assert.equal(await store.revokeNoticeAudience("device:a"), true);
    assert.deepEqual(await readHead(root), { phase: "committed", sequence: 3 });
  });

  await t.test("chat policy deletion", async () => {
    const root = join(await temporaryRoot(t), "chat");
    const anchor = memoryAnchor();
    const store = protectedStore(root, anchor);
    await store.initialize();
    await addFullPolicy(store);
    const policy = await store.getBotPolicy("bot:one");
    await store.createChatPolicy({
      chatId: "chat:one",
      botId: "bot:one",
      expectedBotPolicyRevision: policy.revision,
      catalog: testCatalog(),
    });
    assert.equal(
      await store.deleteChatPolicy({ chatId: "chat:one", botId: "bot:one" }),
      true,
    );
    assert.deepEqual(await readHead(root), { phase: "committed", sequence: 3 });
  });

  await t.test("uncommitted Bot policy rollback", async () => {
    const root = join(await temporaryRoot(t), "policy");
    const anchor = memoryAnchor();
    const store = protectedStore(root, anchor);
    await store.initialize();
    await addFullPolicy(store);
    assert.equal(
      await store.rollbackUncommittedBotPolicy({
        botId: "bot:one",
        identityCommitted: false,
      }),
      true,
    );
    assert.deepEqual(await readHead(root), { phase: "committed", sequence: 2 });
  });
});
