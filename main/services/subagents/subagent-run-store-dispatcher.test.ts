import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunSnapshotV1, SubagentRunSnapshotV2 } from "../../../renderer/shared/subagent-runs.js";
import { createSubagentRunStoreDispatcher } from "./subagent-run-store-dispatcher.js";
import type { MutableSubagentPrivateRunManifestV2 } from "./subagent-run-store-v2-core.js";

function v1(): SubagentRunSnapshotV1 {
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
    taskPreview: "Review persistence",
    state: "completed",
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    modelId: "test-model",
    turns: 1,
    tools: 1,
    tokens: 10,
    warnings: [],
  };
}

function v2(state: SubagentRunSnapshotV2["state"] = "completed"): SubagentRunSnapshotV2 {
  return {
    ...v1(),
    version: 2,
    state,
    ...(state === "needs_attention" ? { finishedAt: undefined, activity: "Needs attention." } : {}),
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 0,
  };
}

const importedManifest: MutableSubagentPrivateRunManifestV2 = {
  version: 2,
  provenance: "v1_import",
  runId: "run-1",
  generationId: "generation-1",
  childId: "child-1",
  chatId: "chat-1",
  workspaceId: "workspace-1",
  task: "Review persistence",
  reusableAuthority: false,
};

function stores(log: string[], overrides: { v1Get?: () => Promise<SubagentRunSnapshotV1 | null>; v2Get?: () => Promise<SubagentRunSnapshotV2 | null>; v2Delete?: () => Promise<void>; v2PreflightDelete?: () => Promise<void> } = {}) {
  const v1Store = {
    async initialize() { log.push("v1.initialize"); },
    async upsert(snapshot: unknown) { log.push("v1.upsert"); return snapshot as SubagentRunSnapshotV1; },
    async get() { log.push("v1.get"); return overrides.v1Get ? overrides.v1Get() : v1(); },
    async listByChat() { log.push("v1.list"); return [v1()]; },
    async deleteChat() { log.push("v1.delete"); },
    async pendingChatDeletions() { log.push("v1.pending"); return ["chat-v1"]; },
    async completeChatDeletion() { log.push("v1.complete"); },
    async flush() {},
    async close() {},
  };
  const v2Store = {
    async initialize() { log.push("v2.initialize"); },
    async upsert(snapshot: unknown) { log.push("v2.upsert"); return snapshot as SubagentRunSnapshotV2; },
    async get() { log.push("v2.get"); return overrides.v2Get ? overrides.v2Get() : v2(); },
    async listByChat() { log.push("v2.list"); return [v2()]; },
    async preflightChatDeletion() { log.push("v2.preflight-delete"); await overrides.v2PreflightDelete?.(); },
    async deleteChat() { log.push("v2.delete"); await overrides.v2Delete?.(); },
    async pendingChatDeletions() { log.push("v2.pending"); return ["chat-v2"]; },
    async completeChatDeletion() { log.push("v2.complete"); },
    async flush() {},
    async close() {},
  };
  return { v1Store, v2Store };
}

test("explicit V1 rollback never opens V2 and drops V2-only fields through the exact adapter", async () => {
  const log: string[] = [];
  const { v1Store, v2Store } = stores(log);
  const dispatcher = createSubagentRunStoreDispatcher({ selection: "v1", v1: v1Store as never, v2: v2Store as never });
  await dispatcher.initialize();
  const saved = await dispatcher.upsert(v2("stopped"), importedManifest);
  assert.equal(saved.version, 1);
  assert.equal(saved.state, "interrupted");
  assert.deepEqual(log, ["v1.initialize", "v1.upsert"]);
});

test("V2 selection never falls back to V1 when canonical history fails", async () => {
  const log: string[] = [];
  const failure = new Error("canonical V2 is corrupt");
  const { v1Store, v2Store } = stores(log, { v2Get: async () => { throw failure; } });
  const dispatcher = createSubagentRunStoreDispatcher({
    selection: "v2",
    v1: v1Store as never,
    v2: v2Store as never,
    prepareV2: async () => { log.push("v2.prepare"); },
    checkpointV1Mutation: async () => { log.push("v2.checkpoint"); },
  });
  await dispatcher.initialize();
  await assert.rejects(dispatcher.get("run-1"), failure);
  assert.deepEqual(log, ["v2.prepare", "v2.initialize", "v2.get"]);
});

test("V2 can expose an exact V1 renderer projection without mutating canonical data", async () => {
  const log: string[] = [];
  const attention = v2("needs_attention");
  const { v1Store, v2Store } = stores(log, { v2Get: async () => attention });
  const dispatcher = createSubagentRunStoreDispatcher({
    selection: "v2",
    projection: "v1",
    v1: v1Store as never,
    v2: v2Store as never,
    prepareV2: async () => { log.push("v2.prepare"); },
    checkpointV1Mutation: async () => { log.push("v2.checkpoint"); },
  });
  await dispatcher.initialize();
  const projected = await dispatcher.get("run-1");
  assert.equal(projected?.version, 1);
  assert.equal(projected?.state, "running");
  assert.equal(projected?.activity, "Needs attention.");
  assert.equal(attention.version, 2);
  assert.equal(attention.state, "needs_attention");
});

test("V2 deletion installs V1 first, unions recovery markers, and clears V1 last", async () => {
  const log: string[] = [];
  const { v1Store, v2Store } = stores(log);
  const dispatcher = createSubagentRunStoreDispatcher({
    selection: "v2",
    v1: v1Store as never,
    v2: v2Store as never,
    prepareV2: async () => { log.push("v2.prepare"); },
    checkpointV1Mutation: async () => { log.push("v2.checkpoint"); },
  });
  await dispatcher.initialize();
  await dispatcher.deleteChat("chat-1");
  assert.deepEqual(await dispatcher.pendingChatDeletions(), ["chat-v1", "chat-v2"]);
  await dispatcher.completeChatDeletion("chat-1");
  assert.deepEqual(log, [
    "v2.prepare",
    "v2.initialize",
    "v2.preflight-delete",
    "v1.delete",
    "v2.delete",
    "v2.checkpoint",
    "v1.pending",
    "v2.pending",
    "v2.complete",
    "v1.complete",
    "v2.checkpoint",
  ]);
});

test("V2 activation refuses to open canonical storage without production migration seams", async () => {
  const log: string[] = [];
  const { v1Store, v2Store } = stores(log);
  const dispatcher = createSubagentRunStoreDispatcher({ selection: "v2", v1: v1Store as never, v2: v2Store as never });
  await assert.rejects(dispatcher.initialize(), /requires migration preparation and V1 checkpoint coordination/u);
  assert.deepEqual(log, []);
});

test("V2 deletion never advances the V1 checkpoint before its own tombstone", async () => {
  const log: string[] = [];
  const failure = new Error("V2 tombstone failed");
  const { v1Store, v2Store } = stores(log, {
    v2Delete: async () => {
      throw failure;
    },
  });
  const dispatcher = createSubagentRunStoreDispatcher({
    selection: "v2",
    v1: v1Store as never,
    v2: v2Store as never,
    prepareV2: async () => { log.push("v2.prepare"); },
    checkpointV1Mutation: async () => { log.push("v2.checkpoint"); },
  });
  await dispatcher.initialize();
  await assert.rejects(dispatcher.deleteChat("chat-1"), failure);
  assert.deepEqual(log, ["v2.prepare", "v2.initialize", "v2.preflight-delete", "v1.delete", "v2.delete"]);
});

test("V2 active-effect preflight leaves both stores untouched", async () => {
  const log: string[] = [];
  const failure = new Error("active durable effects");
  const { v1Store, v2Store } = stores(log, {
    v2PreflightDelete: async () => {
      throw failure;
    },
  });
  const dispatcher = createSubagentRunStoreDispatcher({
    selection: "v2",
    v1: v1Store as never,
    v2: v2Store as never,
    prepareV2: async () => { log.push("v2.prepare"); },
    checkpointV1Mutation: async () => { log.push("v2.checkpoint"); },
  });
  await dispatcher.initialize();
  await assert.rejects(dispatcher.deleteChat("chat-1"), failure);
  assert.deepEqual(log, ["v2.prepare", "v2.initialize", "v2.preflight-delete"]);
});
