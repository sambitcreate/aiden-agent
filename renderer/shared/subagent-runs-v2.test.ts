import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptSubagentRunSnapshotV1ToV2,
  adaptSubagentRunSnapshotV2ToV1,
  MAX_SUBAGENT_ACTIVITY_CHARS,
  SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY,
  subagentPendingQuestion,
  subagentPendingQuestionActivity,
  parseSubagentHistoryDetailV1,
  parseSubagentRunSnapshot,
  parseSubagentRunSnapshotV1,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV1,
  type SubagentRunSnapshotV2,
} from "./subagent-runs.js";

function v1(state: SubagentRunSnapshotV1["state"] = "completed"): SubagentRunSnapshotV1 {
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

function v2(state: SubagentRunSnapshotV2["state"] = "completed"): SubagentRunSnapshotV2 {
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
  assert.equal(parseSubagentRunSnapshot({ ...snapshot, privateGrantId: "grant-1" }), undefined);
  assert.equal(parseSubagentRunSnapshot({ ...snapshot, version: 3 }), undefined);
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

test("projection provenance is optional, closed, cloned, and preserved across adapters", () => {
  const source = {
    ...v1(),
    projectionNotices: ["task_truncated", "report_truncated", "display_filtered"] as const,
  };
  const parsedV1 = parseSubagentRunSnapshotV1(source);
  assert.deepEqual(parsedV1?.projectionNotices, source.projectionNotices);
  assert.notEqual(parsedV1?.projectionNotices, source.projectionNotices);

  const projectedV2 = parsedV1 && adaptSubagentRunSnapshotV1ToV2(parsedV1);
  assert.deepEqual(projectedV2?.projectionNotices, source.projectionNotices);
  assert.deepEqual(projectedV2 && adaptSubagentRunSnapshotV2ToV1(projectedV2), parsedV1);
  assert.equal(
    parseSubagentRunSnapshotV2({ ...v2(), projectionNotices: ["not_a_notice"] }),
    undefined,
  );
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
  assert.equal(parseSubagentRunSnapshotV2({ ...v2(), parentRunId: "run-parent" }), undefined);
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
  assert.equal(parseSubagentRunSnapshotV2({ ...v2(), retryOfRunId: "run-1" }), undefined);
});

test("needs-attention activity carries the pending question and stays bounded", () => {
  const attention = v2("needs_attention");
  assert.ok(parseSubagentRunSnapshotV2(attention));
  const { activity: _activity, ...missing } = attention;
  assert.equal(parseSubagentRunSnapshotV2(missing), undefined);

  const question = "Which branch should I rebase onto: main or release/2.4?";
  const asking = parseSubagentRunSnapshotV2({ ...attention, activity: question });
  assert.equal(asking?.activity, question);
  assert.equal(subagentPendingQuestion(asking), question);
  const asV1 = asking && adaptSubagentRunSnapshotV2ToV1(asking);
  assert.equal(asV1?.state, "running");
  assert.equal(asV1?.activity, question);

  assert.equal(
    parseSubagentRunSnapshotV2({ ...attention, activity: "x".repeat(10_000) }),
    undefined,
  );
  assert.equal(
    parseSubagentRunSnapshotV2({ ...attention, activity: "Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD?" }),
    undefined,
  );
});

test("pending question falls back to generic copy only when no text exists", () => {
  assert.equal(subagentPendingQuestion(v2("needs_attention")), undefined);
  assert.equal(subagentPendingQuestion({ state: "running", activity: "Approve the push?" }), undefined);
  assert.equal(subagentPendingQuestion({ state: "needs_attention" }), undefined);

  for (const empty of [undefined, 42, "", "   \n\t  "]) {
    assert.equal(subagentPendingQuestionActivity(empty), SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY);
  }
  assert.equal(
    subagentPendingQuestionActivity("Approve   writing\nto package.json?\r\n"),
    "Approve writing to package.json?",
  );
});

test("pending question activity is truncated at a word boundary and parses", () => {
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
  const activity = subagentPendingQuestionActivity(`Should I ${words}?`);
  assert.ok(activity.length <= MAX_SUBAGENT_ACTIVITY_CHARS);
  assert.ok(activity.startsWith("Should I word0 word1"));
  // The cut lands between whole words and is marked as elided.
  assert.match(activity, /word\d+\.\.\.$/u);
  const keptWords = activity.slice(0, -3).split(" ");
  assert.ok(words.split(" ").includes(keptWords[keptWords.length - 1]!));
  assert.ok(parseSubagentRunSnapshotV2({ ...v2("needs_attention"), activity }));

  // An unbroken run of emoji never splits a surrogate pair.
  const emoji = subagentPendingQuestionActivity("😀".repeat(200));
  assert.ok(emoji.length <= MAX_SUBAGENT_ACTIVITY_CHARS);
  assert.ok(emoji.endsWith("..."));
  const kept = emoji.slice(0, -3);
  assert.ok(kept.length > 0);
  assert.equal(kept, "😀".repeat(kept.length / 2));
});

test("pending question activity redacts secrets before it reaches a snapshot", () => {
  const activity = subagentPendingQuestionActivity(
    "Can I use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD for the deploy?",
  );
  assert.doesNotMatch(activity, /abcdefghijklmnopqrstuvwxyz0123456789/u);
  assert.match(activity, /^Can I use .+ for the deploy\?$/u);
  assert.ok(parseSubagentRunSnapshotV2({ ...v2("needs_attention"), activity }));
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
        label: "Remote change outcome unknown. Check the remote system before retrying.",
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
  assert.equal(parseSubagentHistoryDetailV1({ ...detail, rawResult: "secret" }), undefined);
  assert.equal(
    parseSubagentHistoryDetailV1({
      ...detail,
      effects: Array.from({ length: 513 }, () => detail.effects[0]),
    }),
    undefined,
  );
});
