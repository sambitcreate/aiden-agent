import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptSubagentRunSnapshotV1ToV2,
  adaptSubagentRunSnapshotV2ToV1,
  parseSubagentHistoryDetailV1,
  parseSubagentRunSnapshot,
  parseSubagentRunSnapshotV1,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV1,
  type SubagentRunSnapshotV2,
} from "./subagent-runs.js";

function v1(
  state: SubagentRunSnapshotV1["state"] = "completed",
): SubagentRunSnapshotV1 {
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
    taskPreview: "Review the authority boundary.",
    state,
    ...(state === "queued" || state === "starting" || state === "running"
      ? { activity: "Reading workspace files" }
      : { finishedAt: 2_000, terminalMarkdown: "Complete." }),
    startedAt: 1_000,
    updatedAt: 2_000,
    modelId: "test-model",
    turns: 2,
    tools: 3,
    tokens: 100,
    warnings: [],
  };
}

function v2(
  state: SubagentRunSnapshotV2["state"] = "completed",
): SubagentRunSnapshotV2 {
  return {
    ...v1(
      state === "needs_attention"
        ? "running"
        : state === "stopped"
          ? "interrupted"
          : state === "unknown"
            ? "failed"
            : state,
    ),
    version: 2,
    state,
    ...(state === "needs_attention"
      ? {
          activity: "Needs attention.",
          finishedAt: undefined,
          terminalMarkdown: undefined,
        }
      : {}),
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
  };
}

test("V1 parsers remain exact while the dispatcher accepts exact V2", () => {
  const snapshot = v2();
  assert.equal(parseSubagentRunSnapshotV1(snapshot), undefined);
  assert.deepEqual(parseSubagentRunSnapshotV2(snapshot), snapshot);
  assert.deepEqual(parseSubagentRunSnapshot(snapshot), snapshot);
  assert.equal(
    parseSubagentRunSnapshot({ ...snapshot, privateGrantId: "grant-1" }),
    undefined,
  );
  assert.equal(
    parseSubagentRunSnapshot({ ...snapshot, version: 3 }),
    undefined,
  );
});

test("V1 migration preserves terminal presentation and interrupts active evidence", () => {
  const terminal = adaptSubagentRunSnapshotV1ToV2(v1());
  assert.equal(terminal?.state, "completed");
  assert.equal(terminal?.authorityRevision, 0);
  assert.equal(terminal?.execution, "foreground");
  assert.equal(terminal?.context, "fresh");
  assert.deepEqual(terminal && adaptSubagentRunSnapshotV2ToV1(terminal), v1());

  const active = adaptSubagentRunSnapshotV1ToV2(v1("running"));
  assert.equal(active?.state, "interrupted");
  assert.equal(active?.finishedAt, active?.updatedAt);
});

test("V2 lifecycle-only states project through the unchanged V1 parser", () => {
  const attention = v2("needs_attention");
  const attentionV1 = adaptSubagentRunSnapshotV2ToV1(attention);
  assert.equal(attentionV1?.state, "running");
  assert.equal(attentionV1?.activity, "Needs attention.");

  const stopped = v2("stopped");
  const stoppedV1 = adaptSubagentRunSnapshotV2ToV1(stopped);
  assert.equal(stoppedV1?.state, "interrupted");
  assert.ok(parseSubagentRunSnapshotV1(stoppedV1));
});

test("V2 lineage and retry identities are exact and non-self-referential", () => {
  assert.equal(
    parseSubagentRunSnapshotV2({ ...v2(), parentRunId: "run-parent" }),
    undefined,
  );
  assert.equal(
    parseSubagentRunSnapshotV2({
      ...v2(),
      depth: 2,
      parentRunId: "run-1",
    }),
    undefined,
  );
  assert.ok(
    parseSubagentRunSnapshotV2({
      ...v2(),
      depth: 2,
      parentRunId: "run-parent",
      retryOfRunId: "run-prior",
    }),
  );
  assert.equal(
    parseSubagentRunSnapshotV2({ ...v2(), retryOfRunId: "run-1" }),
    undefined,
  );
});

test("needs-attention activity is exact evidence and never silently normalized", () => {
  const attention = v2("needs_attention");
  assert.ok(parseSubagentRunSnapshotV2(attention));
  const { activity: _activity, ...missing } = attention;
  assert.equal(parseSubagentRunSnapshotV2(missing), undefined);
  assert.equal(
    parseSubagentRunSnapshotV2({
      ...attention,
      activity: "Waiting for a secret",
    }),
    undefined,
  );
  assert.equal(
    parseSubagentRunSnapshotV2({ ...attention, activity: "x".repeat(10_000) }),
    undefined,
  );
});

test("history detail accepts only bounded sanitized effect activity envelopes", () => {
  const detail = {
    version: 1,
    snapshot: v2(),
    effects: [
      {
        version: 1,
        kind: "mcp_mutation",
        state: "unknown",
        label:
          "Remote change outcome unknown. Check the remote system before retrying.",
        updatedAt: 2_100,
      },
    ],
  };
  assert.deepEqual(parseSubagentHistoryDetailV1(detail), detail);
  assert.equal(
    parseSubagentHistoryDetailV1({
      ...detail,
      effects: [{ ...detail.effects[0], terminalDigest: "a".repeat(64) }],
    }),
    undefined,
  );
  assert.equal(
    parseSubagentHistoryDetailV1({ ...detail, rawResult: "secret" }),
    undefined,
  );
  assert.equal(
    parseSubagentHistoryDetailV1({
      ...detail,
      effects: Array.from({ length: 513 }, () => detail.effects[0]),
    }),
    undefined,
  );
});
