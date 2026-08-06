import assert from "node:assert/strict";
import test from "node:test";
import {
  type SubagentRunSnapshotV2,
} from "../../../renderer/shared/subagent-runs.js";
import {
  createSubagentAuthorityV2,
  subagentAuthorityDigestV2,
} from "./authority-v2.js";
import { subagentEffectEvidenceDigestV2 } from "./subagent-effect-v2.js";
import {
  parseBackgroundSubagentRunV2,
  type BackgroundSubagentRunV2,
} from "./background-lifecycle-v2.js";
import {
  createSubagentRunStoreV2,
  parseMutableSubagentRunDatabaseV2,
  type MutableSubagentRunDatabaseV2,
  type NativeSubagentPrivateRunManifestV2,
} from "./subagent-run-store-v2-core.js";
import {
  SubagentRunStoreStorageError,
  type SubagentRunStoreGeneration,
  type SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";

interface StorageState {
  contents?: string;
  generation: SubagentRunStoreGeneration;
  counter: number;
  writes: number;
  conflicts?: number;
  onConflict?: () => void;
  failWrites?: number;
  closes?: number;
}

function storage(state: StorageState): SubagentRunStoreStorage {
  return {
    async cleanup() { return false; },
    async read() {
      if (state.contents === undefined) return { status: "missing" as const, contents: undefined, generation: "missing" as const };
      return { status: "data" as const, contents: Buffer.from(state.contents), generation: state.generation as string };
    },
    async write(expected, contents) {
      if (expected !== state.generation) throw new SubagentRunStoreStorageError("destination_changed");
      if ((state.conflicts ?? 0) > 0) {
        state.conflicts = (state.conflicts ?? 1) - 1;
        state.onConflict?.();
        state.counter += 1;
        state.generation = `${state.counter.toString(16)}-1-1-1-1-1-1-1-1`;
        throw new SubagentRunStoreStorageError("destination_changed");
      }
      if ((state.failWrites ?? 0) > 0) {
        state.failWrites = (state.failWrites ?? 1) - 1;
        throw new Error("simulated durable write failure");
      }
      state.counter += 1;
      state.writes += 1;
      state.generation = `${state.counter.toString(16)}-1-1-1-1-1-1-1-1`;
      state.contents = contents;
      return state.generation;
    },
    async syncDirectory() {},
    async close() { state.closes = (state.closes ?? 0) + 1; },
  };
}

function snapshot(overrides: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId: "run-1",
    groupId: "group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Review persistence",
    taskPreview: "Review persistence",
    state: "queued",
    startedAt: 10,
    updatedAt: 10,
    modelId: "test-model",
    turns: 0,
    tools: 0,
    tokens: 0,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
    ...overrides,
  };
}

function manifest(): NativeSubagentPrivateRunManifestV2 {
  const authority = createSubagentAuthorityV2({
    grantId: "grant-1",
    treeRootId: "tree-1",
    runId: "run-1",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    workspaceRevision: "workspace-revision-1",
    ownerDocumentId: "1:1:document",
    providerFingerprint: "provider-fingerprint",
    modelFingerprint: "model-fingerprint",
    contextRevision: "context-revision",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "high",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: false,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 60_000,
      maxTurns: 8,
      maxToolCalls: 16,
      maxOutputChars: 24_000,
      maxTokens: 40_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations: 1,
    },
    expiresAt: 100_000,
  });
  return {
    version: 2,
    provenance: "v2_native",
    runId: "run-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    task: "Review persistence",
    reusableAuthority: false,
    authority,
  };
}

function backgroundRecord(overrides: Partial<SubagentRunSnapshotV2> = {}): BackgroundSubagentRunV2 {
  const authority = createSubagentAuthorityV2({
    ...manifest().authority,
    grantId: "grant-background",
    treeRootId: "run-1",
    execution: "background",
    context: "fresh",
  });
  const runSnapshot = snapshot({
    execution: "background",
    context: "fresh",
    ...overrides,
  });
  return {
    version: 2,
    manifest: {
      version: 2,
      execution: "background",
      context: "fresh",
      reusableAuthority: false,
      acceptedAt: 10,
      task: runSnapshot.taskPreview,
      authority,
    },
    snapshot: runSnapshot,
    events: [{ sequence: 1, at: 10, kind: "accepted", state: "queued" }],
    steering: [],
    waitCount: 0,
    waitedMs: 0,
  };
}

function backgroundManifest(run: BackgroundSubagentRunV2): NativeSubagentPrivateRunManifestV2 {
  return {
    version: 2,
    provenance: "v2_native",
    runId: run.snapshot.runId,
    generationId: run.snapshot.generationId,
    childId: run.snapshot.childId,
    chatId: run.snapshot.chatId,
    workspaceId: run.snapshot.workspaceId,
    task: run.manifest.task,
    reusableAuthority: false,
    authority: run.manifest.authority,
  };
}

function database(snapshots: SubagentRunSnapshotV2[] = [], manifests: NativeSubagentPrivateRunManifestV2[] = []): MutableSubagentRunDatabaseV2 {
  return {
    version: 2,
    storeRevision: 2,
    migration: {
      status: "committed",
      adapterVersion: 1,
      source: "missing",
      sourceGeneration: "missing",
      sourceSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      migratedAt: 1,
    },
    snapshots,
    manifests,
    approvals: [],
    effects: [],
    backgroundRuns: [],
    pendingChatDeletions: [],
    deletionTransactions: [],
  };
}

function stateWith(databaseValue: MutableSubagentRunDatabaseV2): StorageState {
  return {
    contents: `${JSON.stringify(databaseValue, null, 2)}\n`,
    generation: "1-1-1-1-1-1-1-1-1",
    counter: 1,
    writes: 0,
  };
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function effectInput(toolCallId = "tool-call-1") {
  return {
    approvalId: `approval-${toolCallId}`,
    effectId: `effect-${toolCallId}`,
    runId: "run-1",
    chatId: "chat-1",
    childId: "child-1",
    toolCallId,
    toolName: "mcp_write",
    effectKind: "mcp_mutation" as const,
    argumentDigest: DIGEST_A,
    effectDigest: DIGEST_B,
    authorityDigest: subagentAuthorityDigestV2(manifest().authority),
    expiresAt: 100,
  };
}

function effectOwner(toolCallId = "tool-call-1") {
  return {
    approvalId: `approval-${toolCallId}`,
    effectId: `effect-${toolCallId}`,
    runId: "run-1",
    chatId: "chat-1",
  };
}

test("strict V2 store persists a native authority manifest and monotonic lifecycle", async () => {
  const state = stateWith(database());
  const store = createSubagentRunStoreV2(async () => "/private/v2", { storageFactory: () => storage(state), now: () => 20 });
  await store.initialize();
  await store.upsert(snapshot(), manifest());
  const running = snapshot({ revision: 2, state: "running", updatedAt: 30, turns: 1, tools: 1, tokens: 10 });
  await store.upsert(running, manifest());

  assert.deepEqual(await store.get("run-1"), running);
  assert.deepEqual(await store.listByChat("chat-1"), [running]);
  const persisted = parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"));
  assert.equal(persisted?.storeRevision, 4);
  assert.equal(persisted?.manifests[0]?.provenance, "v2_native");

  await assert.rejects(
    store.upsert(snapshot({ revision: 3, state: "starting", updatedAt: 40 }), manifest()),
    /lifecycle cannot move backward/u,
  );
});

test("run reservations reject an over-cap batch before any queued snapshot is written", async () => {
  const state = stateWith(database());
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    maxRuns: 1,
  });
  await store.initialize();
  await store.reserveRun("run-1");
  await assert.rejects(store.reserveRun("run-2"), /history is at capacity/u);
  assert.equal(state.writes, 0);

  store.releaseRunReservation("run-1");
  await store.reserveRun("run-2");
  store.releaseRunReservation("run-2");
  await store.reserveRun("run-1");
  await store.upsert(snapshot(), manifest());
  await assert.rejects(store.reserveRun("run-2"), /history is at capacity/u);
});

test("native manifest authority is immutable and cross-record exact", async () => {
  const snap = snapshot();
  const native = manifest();
  assert.ok(parseMutableSubagentRunDatabaseV2(database([snap], [native])));
  assert.equal(
    parseMutableSubagentRunDatabaseV2({
      ...database([snap], [native]),
      manifests: [{ ...native, childId: "child-other" }],
    }),
    undefined,
  );
  assert.equal(
    parseMutableSubagentRunDatabaseV2({
      ...database([snap], [native]),
      manifests: [{ ...native, authority: { ...native.authority, authorityRevision: 2 } }],
    }),
    undefined,
  );
});

test("corrupt canonical V2 blocks every read without rewriting evidence", async () => {
  const corrupt = `{"version":2,"version":2}`;
  const state: StorageState = {
    contents: corrupt,
    generation: "1-1-1-1-1-1-1-1-1",
    counter: 1,
    writes: 0,
  };
  const store = createSubagentRunStoreV2(async () => "/private/v2", { storageFactory: () => storage(state) });
  await assert.rejects(store.initialize(), /unreadable evidence and was preserved/u);
  assert.equal(state.contents, corrupt);
  assert.equal(state.writes, 0);
});

test("startup reconciles active native runs once and preserves manifests", async () => {
  const state = stateWith(database([snapshot({ state: "needs_attention", activity: "Needs attention." })], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", { storageFactory: () => storage(state), now: () => 50 });
  await store.initialize();
  const interrupted = await store.get("run-1");
  assert.equal(interrupted?.state, "interrupted");
  assert.equal(interrupted?.revision, 2);
  assert.equal(interrupted?.finishedAt, 50);
  assert.equal(parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"))?.manifests[0]?.provenance, "v2_native");
});

test("chat deletion is durable, blocks late writes, and clears only on completion", async () => {
  const state = stateWith(database());
  const store = createSubagentRunStoreV2(async () => "/private/v2", { storageFactory: () => storage(state) });
  await store.initialize();
  await store.upsert(snapshot(), manifest());
  await store.deleteChat("chat-1");
  assert.equal(await store.get("run-1"), null);
  assert.deepEqual(await store.pendingChatDeletions(), ["chat-1"]);
  await assert.rejects(store.upsert(snapshot(), manifest()), /no longer available/u);
  await store.completeChatDeletion("chat-1");
  assert.deepEqual(await store.pendingChatDeletions(), []);
});

test("one stale native generation is re-read and merged before V2 acknowledgement", async () => {
  const state = stateWith(database());
  state.conflicts = 1;
  const store = createSubagentRunStoreV2(async () => "/private/v2", { storageFactory: () => storage(state) });
  await store.initialize();
  await store.upsert(snapshot(), manifest());
  assert.deepEqual(await store.get("run-1"), snapshot());
  assert.equal(state.writes, 1);
  assert.equal(state.conflicts, 0);
});

test("intentional V1 rollback-journal writes advance the committed migration checkpoint", async () => {
  const state = stateWith(database());
  const store = createSubagentRunStoreV2(async () => "/private/v2", { storageFactory: () => storage(state) });
  await store.initialize();
  await store.updateV1Checkpoint({
    source: "v1",
    sourceGeneration: "a-1-1-1-1-1-1-1-1",
    sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const persisted = parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"));
  assert.equal(persisted?.migration.source, "v1");
  assert.equal(persisted?.migration.sourceGeneration, "a-1-1-1-1-1-1-1-1");
  assert.equal(persisted?.migration.sourceSha256, "a".repeat(64));
});

test("durable effects advance monotonically from preparation through terminal evidence", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await store.initialize();
  assert.equal((await store.prepareEffect(effectInput())).state, "prepared");
  clock = 21;
  assert.equal((await store.authorizeEffect(effectOwner())).state, "authorized");
  clock = 22;
  assert.equal((await store.markEffectDispatchStarted(effectOwner())).state, "dispatch_started");
  clock = 23;
  const terminalDigest = subagentEffectEvidenceDigestV2("remote_completed");
  assert.equal((await store.finishEffect({ ...effectOwner(), state: "completed", terminalDigest })).state, "completed");
  await assert.rejects(store.authorizeEffect(effectOwner()), /cannot move from completed/u);
  assert.deepEqual((await store.listEffectsByChat("chat-1")).map(({ state }) => state), ["completed"]);
  assert.deepEqual(await store.listEffectActivityForRun("run-1", "chat-1"), [{
    version: 1,
    kind: "mcp_mutation",
    state: "completed",
    label: "Remote change completed",
    updatedAt: 23,
  }]);
  const persisted = parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"));
  assert.equal(persisted?.effects[0]?.terminalDigest, terminalDigest);
  assert.equal(persisted?.approvals[0]?.state, "consumed");
});

test("expired prepared approval cannot cross the authorization barrier", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await store.initialize();
  await store.prepareEffect({ ...effectInput(), expiresAt: 21 });
  clock = 21;
  await assert.rejects(store.authorizeEffect(effectOwner()), /expired before authorization/u);
  assert.equal((await store.getEffect(effectOwner()))?.state, "prepared");
});

test("authorized approval expiring at dispatch is durably cancelled before request bytes", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await store.initialize();
  await store.prepareEffect({ ...effectInput(), expiresAt: 21 });
  await store.authorizeEffect(effectOwner());
  clock = 21;
  await assert.rejects(
    store.markEffectDispatchStarted(effectOwner()),
    /expired before dispatch/u,
  );
  assert.equal((await store.getEffect(effectOwner()))?.state, "cancelled_before_dispatch");
});

test("effect preparation rejects imported runs and authority digest drift", async () => {
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => 20,
  });
  await store.initialize();
  await assert.rejects(
    store.prepareEffect({ ...effectInput(), authorityDigest: "d".repeat(64) }),
    /ownership does not match/u,
  );

  const importedState = stateWith(database([snapshot({ authorityRevision: 0 })], []));
  importedState.contents = `${JSON.stringify({
    ...database([snapshot({ authorityRevision: 0 })], []),
    manifests: [{
      version: 2,
      provenance: "v1_import",
      runId: "run-1",
      generationId: "generation-1",
      childId: "child-1",
      chatId: "chat-1",
      workspaceId: "workspace-1",
      task: "Review persistence",
      reusableAuthority: false,
    }],
  }, null, 2)}\n`;
  const importedStore = createSubagentRunStoreV2(async () => "/private/v2-imported", {
    storageFactory: () => storage(importedState),
    now: () => 20,
  });
  await importedStore.initialize();
  await assert.rejects(
    importedStore.prepareEffect(effectInput()),
    /ownership does not match/u,
  );
});

test("startup cancels undispatched effects and marks dispatched outcomes unknown without retry", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const first = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await first.initialize();
  await first.prepareEffect(effectInput("tool-call-prepared"));
  await first.prepareEffect(effectInput("tool-call-dispatched"));
  await first.authorizeEffect(effectOwner("tool-call-dispatched"));
  await first.markEffectDispatchStarted(effectOwner("tool-call-dispatched"));

  clock = 50;
  const restarted = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await restarted.initialize();
  const effects = await restarted.listEffectsByChat("chat-1");
  assert.equal(effects.find(({ toolCallId }) => toolCallId === "tool-call-prepared")?.state, "cancelled_before_dispatch");
  assert.equal(effects.find(({ toolCallId }) => toolCallId === "tool-call-dispatched")?.state, "unknown");
});

test("private background records atomically own their matching snapshot and reject stale CAS", async () => {
  const state = stateWith(database());
  const store = createSubagentRunStoreV2(async () => "/private/v2-background", {
    storageFactory: () => storage(state),
    now: () => 20,
  });
  await store.initialize();
  const accepted = backgroundRecord();
  assert.ok(parseBackgroundSubagentRunV2(accepted));
  assert.equal(await store.background.put(accepted, null), true);
  assert.equal((await store.get("run-1"))?.execution, "background");
  assert.equal((await store.background.get("run-1"))?.snapshot.revision, 1);

  const starting = structuredClone(accepted);
  starting.snapshot = {
    ...starting.snapshot,
    revision: 2,
    state: "starting",
    activity: "Starting",
    updatedAt: 20,
  };
  starting.events = [
    ...starting.events,
    { sequence: 2, at: 20, kind: "transition", state: "starting" },
  ];
  assert.equal(await store.background.put(starting, 1), true);
  assert.equal(await store.background.put(starting, 1), false);

  const persisted = parseMutableSubagentRunDatabaseV2(
    JSON.parse(state.contents ?? "null"),
  );
  assert.equal(persisted?.backgroundRuns.length, 1);
  assert.deepEqual(persisted?.backgroundRuns[0]?.snapshot, persisted?.snapshots[0]);
  assert.deepEqual(
    persisted?.manifests[0],
    backgroundManifest(persisted!.backgroundRuns[0]!),
  );
});

test("startup reconciliation and chat deletion keep private background records synchronized", async () => {
  const accepted = backgroundRecord({ state: "running", activity: "Running", updatedAt: 10 });
  accepted.events = [
    ...accepted.events,
    { sequence: 2, at: 10, kind: "transition", state: "running" },
  ];
  const persisted = database([accepted.snapshot], [backgroundManifest(accepted)]);
  persisted.backgroundRuns = [accepted];
  const state = stateWith(persisted);
  const restarted = createSubagentRunStoreV2(async () => "/private/v2-background", {
    storageFactory: () => storage(state),
    now: () => 30,
  });
  await restarted.initialize();
  const interrupted = await restarted.background.get("run-1");
  assert.equal(interrupted?.snapshot.state, "interrupted");
  assert.equal(
    interrupted?.events[interrupted.events.length - 1]?.kind,
    "reconciled",
  );
  assert.deepEqual(interrupted?.snapshot, await restarted.get("run-1"));

  await restarted.preflightChatDeletion("chat-1");
  await restarted.deleteChat("chat-1");
  const deleted = parseMutableSubagentRunDatabaseV2(
    JSON.parse(state.contents ?? "null"),
  );
  assert.equal(deleted?.backgroundRuns.length, 0);
  assert.equal(deleted?.snapshots.length, 0);
});

test("pre-dispatch durability failure prevents a prepared acknowledgement", async () => {
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => 20,
  });
  await store.initialize();
  state.failWrites = 1;
  await assert.rejects(store.prepareEffect(effectInput()), /simulated durable write failure/u);
  assert.equal(parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"))?.effects.length, 0);
});

test("failed terminal persistence stays locally visible as unknown", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await store.initialize();
  await store.prepareEffect(effectInput());
  await store.authorizeEffect(effectOwner());
  await store.markEffectDispatchStarted(effectOwner());
  clock = 30;
  state.failWrites = 1;
  await assert.rejects(
    store.finishEffect({
      ...effectOwner(),
      state: "remote_error",
      terminalDigest: subagentEffectEvidenceDigestV2("remote_error"),
    }),
    /simulated durable write failure/u,
  );
  assert.equal((await store.getEffect(effectOwner()))?.state, "unknown");
  assert.equal((await store.listEffectsByChat("chat-1"))[0]?.state, "unknown");
  assert.equal((await store.finishEffect({
    ...effectOwner(),
    state: "completed",
    terminalDigest: subagentEffectEvidenceDigestV2("late_completion"),
  })).state, "unknown");
  await store.preflightChatDeletion("chat-1");
  await store.deleteChat("chat-1");
  assert.equal(parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"))?.effects.length, 0);
});

test("a proven externally persisted terminal outcome supersedes conservative local unknown", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await store.initialize();
  await store.prepareEffect(effectInput());
  await store.authorizeEffect(effectOwner());
  await store.markEffectDispatchStarted(effectOwner());
  clock = 30;
  state.failWrites = 1;
  await assert.rejects(store.finishEffect({
    ...effectOwner(),
    state: "completed",
    terminalDigest: subagentEffectEvidenceDigestV2("first_completion"),
  }));

  const durable = parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"))!;
  const terminalDigest = subagentEffectEvidenceDigestV2("external_completion");
  durable.effects[0] = {
    ...durable.effects[0]!,
    state: "completed",
    updatedAt: 31,
    terminalDigest,
  };
  durable.approvals[0] = { ...durable.approvals[0]!, updatedAt: 31 };
  state.contents = `${JSON.stringify(durable, null, 2)}\n`;
  assert.equal((await store.getEffect(effectOwner()))?.state, "completed");
  assert.equal((await store.getEffect(effectOwner()))?.terminalDigest, terminalDigest);
});

test("generation-conflict terminalization is not shadowed by conservative unknown", async () => {
  let clock = 20;
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => clock,
  });
  await store.initialize();
  await store.prepareEffect(effectInput());
  await store.authorizeEffect(effectOwner());
  await store.markEffectDispatchStarted(effectOwner());
  clock = 30;
  const competingDigest = subagentEffectEvidenceDigestV2("competing_completion");
  state.conflicts = 1;
  state.onConflict = () => {
    const durable = parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"))!;
    durable.storeRevision += 1;
    durable.effects[0] = {
      ...durable.effects[0]!,
      state: "completed",
      updatedAt: 30,
      terminalDigest: competingDigest,
    };
    durable.approvals[0] = { ...durable.approvals[0]!, updatedAt: 30 };
    state.contents = `${JSON.stringify(durable, null, 2)}\n`;
  };
  await assert.rejects(
    store.finishEffect({
      ...effectOwner(),
      state: "remote_error",
      terminalDigest: subagentEffectEvidenceDigestV2("losing_completion"),
    }),
    /must be dispatch-started/u,
  );
  const proven = await store.getEffect(effectOwner());
  assert.equal(proven?.state, "completed");
  assert.equal(proven?.terminalDigest, competingDigest);
});

test("chat deletion blocks active effects and removes terminal effect evidence with its tombstone", async () => {
  const state = stateWith(database([snapshot()], [manifest()]));
  const store = createSubagentRunStoreV2(async () => "/private/v2", {
    storageFactory: () => storage(state),
    now: () => 20,
  });
  await store.initialize();
  await store.prepareEffect(effectInput());
  await assert.rejects(store.deleteChat("chat-1"), /active durable effects/u);
  assert.ok(await store.get("run-1"));
  await store.cancelEffectBeforeDispatch(effectOwner());
  await store.deleteChat("chat-1");
  const persisted = parseMutableSubagentRunDatabaseV2(JSON.parse(state.contents ?? "null"));
  assert.equal(persisted?.effects.length, 0);
  assert.equal(persisted?.approvals.length, 0);
  assert.deepEqual(persisted?.pendingChatDeletions, ["chat-1"]);
});
