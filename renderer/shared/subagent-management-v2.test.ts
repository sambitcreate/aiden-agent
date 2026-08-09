import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunSnapshotV2 } from "./subagent-runs.js";
import { parseSubagentManagementResultV2 } from "./subagent-management-v2.js";

function snapshot(overrides: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId: "run-one",
    groupId: "group-one",
    generationId: "generation-one",
    childId: "child-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review the owner boundary.",
    state: "running",
    activity: "Reviewing workspace context",
    startedAt: 100,
    updatedAt: 100,
    modelId: "model-one",
    turns: 0,
    tools: 0,
    tokens: 0,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 3,
    ...overrides,
  };
}

test("management results are exact and renderer-safe", () => {
  const run = snapshot();
  assert.deepEqual(parseSubagentManagementResultV2({ version: 2, action: "status", snapshot: run }), {
    version: 2,
    action: "status",
    snapshot: run,
  });
  assert.deepEqual(
    parseSubagentManagementResultV2({
      version: 2,
      action: "wait",
      snapshot: run,
      timedOut: true,
    }),
    { version: 2, action: "wait", snapshot: run, timedOut: true },
  );
  assert.equal(
    parseSubagentManagementResultV2({
      version: 2,
      action: "stop",
      snapshot: run,
      changed: true,
      privateGrant: "never",
    }),
    undefined,
  );
  assert.equal(
    parseSubagentManagementResultV2({ version: 2, action: "wait", snapshot: run, timedOut: "yes" }),
    undefined,
  );
});

test("retry results require exact lineage and owner identity", () => {
  const source = snapshot({
    state: "completed",
    activity: undefined,
    finishedAt: 200,
    updatedAt: 200,
  });
  const retry = snapshot({
    runId: "run-retry",
    childId: "child-retry",
    groupId: "group-retry",
    retryOfRunId: source.runId,
    state: "queued",
  });
  assert.ok(
    parseSubagentManagementResultV2({
      version: 2,
      action: "retry",
      sourceSnapshot: source,
      snapshot: retry,
    }),
  );
  assert.equal(
    parseSubagentManagementResultV2({
      version: 2,
      action: "retry",
      sourceSnapshot: source,
      snapshot: { ...retry, retryOfRunId: "run-other" },
    }),
    undefined,
  );
});
