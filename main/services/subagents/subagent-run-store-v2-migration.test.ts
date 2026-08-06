import assert from "node:assert/strict";
import test from "node:test";
import type {
  SubagentRunSnapshotV1,
  SubagentRunSnapshotV2,
} from "../../../renderer/shared/subagent-runs.js";
import { createSubagentAuthorityV2 } from "./authority-v2.js";
import {
  migrateSubagentRunStoreV2,
  parseSubagentRunDatabaseV2,
} from "./subagent-run-store-v2-migration.js";
import type {
  SubagentRunStoreGeneration,
  SubagentRunStoreStorage,
} from "./subagent-run-store-io.js";

interface MemoryStorageState {
  contents?: Buffer;
  generation: SubagentRunStoreGeneration;
  writes: number;
  mutateAfterWrite?: () => void;
}

function memoryStorage(state: MemoryStorageState): SubagentRunStoreStorage {
  return {
    cleanup: async () => false,
    read: async () =>
      state.contents
        ? { status: "data", contents: Buffer.from(state.contents), generation: state.generation }
        : { status: "missing", contents: undefined, generation: "missing" },
    write: async (expected, contents) => {
      if (expected !== state.generation) throw new Error("destination changed");
      state.writes += 1;
      state.contents = Buffer.from(contents, "utf8");
      state.generation = `${state.writes.toString(16)}-1-1-1-1-1-1-1-1`;
      state.mutateAfterWrite?.();
      state.mutateAfterWrite = undefined;
      return state.generation;
    },
    syncDirectory: async () => undefined,
    close: async () => undefined,
  };
}

function snapshot(state: SubagentRunSnapshotV1["state"] = "completed"): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    groupId: "group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review migration.",
    state,
    ...(state === "running" ? { activity: "Reading files" } : { finishedAt: 2_000 }),
    startedAt: 1_000,
    updatedAt: 2_000,
    modelId: "test-model",
    turns: 1,
    tools: 1,
    tokens: 10,
    warnings: [],
  };
}

function v1State(runs: SubagentRunSnapshotV1[] = [snapshot()]): MemoryStorageState {
  return {
    contents: Buffer.from(
      `${JSON.stringify({ version: 1, runs, pendingChatDeletions: [] }, null, 2)}\n`,
      "utf8",
    ),
    generation: "a-1-1-1-1-1-1-1-1",
    writes: 0,
  };
}

test("parallel V2 migration commits without changing V1 bytes", async () => {
  const v1 = v1State([snapshot(), { ...snapshot("running"), runId: "run-2", childId: "child-2" }]);
  const original = Buffer.from(v1.contents!);
  const v2: MemoryStorageState = { generation: "missing", writes: 0 };
  const migrated = await migrateSubagentRunStoreV2(
    memoryStorage(v1),
    memoryStorage(v2),
    () => 3_000,
  );

  assert.equal(migrated.migration.status, "committed");
  assert.equal(migrated.snapshots[0]?.state, "completed");
  assert.equal(migrated.snapshots[1]?.state, "interrupted");
  assert.ok(migrated.manifests.every(({ reusableAuthority }) => reusableAuthority === false));
  assert.deepEqual(v1.contents, original);
  assert.equal(v1.writes, 0);
  assert.equal(v2.writes, 2);
});

test("prepared migration resumes and committed migration is idempotent", async () => {
  const v1 = v1State();
  const v2: MemoryStorageState = { generation: "missing", writes: 0 };
  const first = await migrateSubagentRunStoreV2(memoryStorage(v1), memoryStorage(v2), () => 3_000);
  const writes = v2.writes;
  const second = await migrateSubagentRunStoreV2(memoryStorage(v1), memoryStorage(v2), () => 4_000);
  assert.deepEqual(second, first);
  assert.equal(v2.writes, writes);
});

test("source drift after prepare preserves both stores and blocks commit", async () => {
  const v1 = v1State();
  const original = Buffer.from(v1.contents!);
  const v2: MemoryStorageState = { generation: "missing", writes: 0 };
  v2.mutateAfterWrite = () => {
    v1.contents = Buffer.from(`${original.toString("utf8")} `, "utf8");
    v1.generation = "b-1-1-1-1-1-1-1-1";
  };
  await assert.rejects(
    migrateSubagentRunStoreV2(memoryStorage(v1), memoryStorage(v2), () => 3_000),
    /changed before/u,
  );
  assert.equal(v2.writes, 1);
  assert.match(v2.contents?.toString("utf8") ?? "", /"status": "prepared"/u);
});

test("invalid V1 and corrupt V2 evidence fail closed without fallback or rewrite", async () => {
  const invalidV1: MemoryStorageState = {
    contents: Buffer.from('{"version":1,"version":1,"runs":[]}'),
    generation: "a-1-1-1-1-1-1-1-1",
    writes: 0,
  };
  const emptyV2: MemoryStorageState = { generation: "missing", writes: 0 };
  await assert.rejects(migrateSubagentRunStoreV2(memoryStorage(invalidV1), memoryStorage(emptyV2)));
  assert.equal(invalidV1.writes, 0);
  assert.equal(emptyV2.writes, 0);

  const emptyFileV1: MemoryStorageState = {
    contents: Buffer.alloc(0),
    generation: "d-1-1-1-1-1-1-1-1",
    writes: 0,
  };
  const missingV2: MemoryStorageState = { generation: "missing", writes: 0 };
  await assert.rejects(migrateSubagentRunStoreV2(memoryStorage(emptyFileV1), memoryStorage(missingV2)));
  assert.equal(emptyFileV1.writes, 0);
  assert.equal(missingV2.writes, 0);

  const validV1 = v1State();
  const corruptV2: MemoryStorageState = {
    contents: Buffer.from("not json"),
    generation: "c-1-1-1-1-1-1-1-1",
    writes: 0,
  };
  await assert.rejects(
    migrateSubagentRunStoreV2(memoryStorage(validV1), memoryStorage(corruptV2)),
    /V2 migration evidence/u,
  );
  assert.equal(corruptV2.writes, 0);
});

test("committed migration verification accepts later exact native V2 manifests", async () => {
  const v1: MemoryStorageState = { generation: "missing", writes: 0 };
  const v2: MemoryStorageState = { generation: "missing", writes: 0 };
  const migrated = await migrateSubagentRunStoreV2(
    memoryStorage(v1),
    memoryStorage(v2),
    () => 3_000,
  );
  const run: SubagentRunSnapshotV2 = {
    version: 2,
    runId: "run-native",
    groupId: "group-native",
    generationId: "generation-native",
    childId: "child-native",
    chatId: "chat-native",
    workspaceId: "workspace-native",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review native persistence.",
    state: "completed",
    startedAt: 3_000,
    updatedAt: 4_000,
    finishedAt: 4_000,
    modelId: "test-model",
    turns: 1,
    tools: 0,
    tokens: 10,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
  };
  const authority = createSubagentAuthorityV2({
    grantId: "grant-native",
    treeRootId: "tree-native",
    runId: run.runId,
    depth: 1,
    authorityRevision: 1,
    generationId: run.generationId,
    chatId: run.chatId,
    workspaceId: run.workspaceId,
    workspaceRevision: "workspace-revision-native",
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
  v2.contents = Buffer.from(
    `${JSON.stringify({
      ...migrated,
      storeRevision: migrated.storeRevision + 1,
      snapshots: [run],
      manifests: [
        {
          version: 2,
          provenance: "v2_native",
          runId: run.runId,
          generationId: run.generationId,
          childId: run.childId,
          chatId: run.chatId,
          workspaceId: run.workspaceId,
          task: run.taskPreview,
          reusableAuthority: false,
          authority,
        },
      ],
    })}\n`,
    "utf8",
  );
  v2.generation = "f-1-1-1-1-1-1-1-1";

  const verified = await migrateSubagentRunStoreV2(memoryStorage(v1), memoryStorage(v2));
  assert.equal(verified.snapshots[0]?.runId, run.runId);
  assert.equal(v2.writes, 2);
});

test("migration parser enforces the same imported manifest composition as canonical V2", async () => {
  const v1 = v1State();
  const v2: MemoryStorageState = { generation: "missing", writes: 0 };
  const migrated = await migrateSubagentRunStoreV2(memoryStorage(v1), memoryStorage(v2));
  assert.ok(parseSubagentRunDatabaseV2(migrated));
  assert.equal(
    parseSubagentRunDatabaseV2({
      ...migrated,
      manifests: [{ ...migrated.manifests[0]!, task: "Different task" }],
    }),
    undefined,
  );
  assert.equal(
    parseSubagentRunDatabaseV2({
      ...migrated,
      snapshots: [{ ...migrated.snapshots[0]!, authorityRevision: 1 }],
    }),
    undefined,
  );
});
