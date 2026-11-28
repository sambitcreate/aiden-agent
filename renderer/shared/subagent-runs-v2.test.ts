import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptSubagentRunSnapshotV1ToV2,
  adaptSubagentRunSnapshotV2ToV1,
  isSubagentRunStateTerminal,
  MAX_SUBAGENT_ACTIVITY_CHARS,
  SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY,
  subagentPendingQuestion,
  subagentPendingQuestionActivity,
  subagentRunSnapshotUpdateIsMonotonic,
  subagentRunStateProgresses,
  parseSubagentHistoryDetailV1,
  parseSubagentRunSnapshot,
  parseSubagentRunSnapshotV1,
  parseSubagentRunSnapshotV2,
  parsedSubagentRunSnapshotUpdateIsMonotonic,
  type SubagentRunSnapshotV1,
  type SubagentRunSnapshotV2,
  type SubagentRunStateV2,
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

test("recorded child model and effort are optional, validated, and survive adapters", () => {
  const legacy = parseSubagentRunSnapshotV1(v1());
  assert.ok(legacy);
  assert.equal("providerId" in legacy, false);
  assert.equal("thinkingLevel" in legacy, false);
  assert.ok(parseSubagentRunSnapshotV2(v2()));

  const recorded = {
    ...v2(),
    providerId: "anthropic",
    modelId: "claude-haiku",
    thinkingLevel: "low" as const,
    modelSelection: "requested" as const,
  };
  const parsed = parseSubagentRunSnapshot(recorded);
  assert.equal(parsed?.providerId, "anthropic");
  assert.equal(parsed?.thinkingLevel, "low");
  assert.equal(parsed?.modelSelection, "requested");
  const asV1 = parsed?.version === 2 ? adaptSubagentRunSnapshotV2ToV1(parsed) : undefined;
  assert.equal(asV1?.thinkingLevel, "low");
  assert.equal(parseSubagentRunSnapshotV1(asV1)?.modelSelection, "requested");

  assert.equal(parseSubagentRunSnapshot({ ...recorded, thinkingLevel: "ultra" }), undefined);
  assert.equal(parseSubagentRunSnapshot({ ...recorded, modelSelection: "guessed" }), undefined);
  assert.equal(parseSubagentRunSnapshot({ ...recorded, providerId: "" }), undefined);
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
    parseSubagentRunSnapshotV2({
      ...attention,
      activity: "Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD?",
    }),
    undefined,
  );
});

test("pending question falls back to generic copy only when no text exists", () => {
  assert.equal(subagentPendingQuestion(v2("needs_attention")), undefined);
  assert.equal(
    subagentPendingQuestion({ state: "running", activity: "Approve the push?" }),
    undefined,
  );
  assert.equal(subagentPendingQuestion({ state: "needs_attention" }), undefined);

  for (const empty of [undefined, 42, "", "   \n\t  "]) {
    assert.equal(
      subagentPendingQuestionActivity(empty),
      SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY,
    );
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

test("pending questions redact control-split credentials before flattening", () => {
  for (const control of ["\u000b", "\u0000", "\u001b"]) {
    const activity = subagentPendingQuestionActivity(
      `Use s${control}k-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD?`,
    );
    assert.doesNotMatch(activity, /abcdefghijklmnopqrstuvwxyz0123456789/u);
    assert.ok(parseSubagentRunSnapshotV2({ ...v2("needs_attention"), activity }));
  }
});

test("subagentRunStateProgresses enforces the exhaustive transition matrix for allowStopped true and false", () => {
  const allStates: readonly SubagentRunStateV2[] = [
    "queued",
    "starting",
    "running",
    "needs_attention",
    "completed",
    "failed",
    "timed_out",
    "interrupted",
    "stopped",
    "unknown",
  ];

  // Explicit oracle table of allowed target states per source state (with allowStopped: true).
  const expectedAllowStoppedTrue: Record<SubagentRunStateV2, ReadonlySet<SubagentRunStateV2>> = {
    queued: new Set([
      "queued",
      "starting",
      "running",
      "needs_attention",
      "completed",
      "failed",
      "timed_out",
      "interrupted",
      "stopped",
      "unknown",
    ]),
    starting: new Set([
      "starting",
      "running",
      "needs_attention",
      "completed",
      "failed",
      "timed_out",
      "interrupted",
      "stopped",
      "unknown",
    ]),
    running: new Set([
      "running",
      "needs_attention",
      "completed",
      "failed",
      "timed_out",
      "interrupted",
      "stopped",
      "unknown",
    ]),
    needs_attention: new Set([
      "running",
      "needs_attention",
      "completed",
      "failed",
      "timed_out",
      "interrupted",
      "stopped",
      "unknown",
    ]),
    completed: new Set(),
    failed: new Set(),
    timed_out: new Set(),
    interrupted: new Set(),
    stopped: new Set(),
    unknown: new Set(),
  };

  for (const current of allStates) {
    assert.equal(
      isSubagentRunStateTerminal(current),
      expectedAllowStoppedTrue[current].size === 0,
      `terminal classification for ${current}`,
    );
    for (const next of allStates) {
      const allowedWithStopped = expectedAllowStoppedTrue[current].has(next);
      assert.equal(
        subagentRunStateProgresses(current, next),
        allowedWithStopped,
        `default progression ${current} -> ${next}`,
      );
      assert.equal(
        subagentRunStateProgresses(current, next, { allowStopped: true }),
        allowedWithStopped,
        `allowStopped:true progression ${current} -> ${next}`,
      );
      assert.equal(
        subagentRunStateProgresses(current, next, { allowStopped: false }),
        allowedWithStopped && next !== "stopped",
        `allowStopped:false progression ${current} -> ${next}`,
      );
    }
  }

  // Unrecognized states at runtime are rejected rather than falling through.
  assert.equal(
    subagentRunStateProgresses("bogus" as SubagentRunStateV2, "running"),
    false,
  );
  assert.equal(
    subagentRunStateProgresses("queued", "bogus" as SubagentRunStateV2),
    false,
  );
});

test("subagentRunSnapshotUpdateIsMonotonic enforces state, identity, and exact-replay rules", () => {
  const queued = v2("queued");
  const running: SubagentRunSnapshotV2 = {
    ...v2("running"),
    revision: 2,
    updatedAt: 2_500,
    turns: 3,
    tools: 4,
    tokens: 150,
    milestones: ["reading"],
  };
  const attention: SubagentRunSnapshotV2 = {
    ...v2("needs_attention"),
    revision: 3,
    updatedAt: 2_600,
    turns: 3,
    tools: 4,
    tokens: 150,
    milestones: ["reading"],
  };
  const stopped: SubagentRunSnapshotV2 = {
    ...v2("stopped"),
    revision: 4,
    updatedAt: 2_700,
    finishedAt: 2_700,
    turns: 3,
    tools: 4,
    tokens: 150,
    milestones: ["reading"],
  };

  assert.equal(subagentRunSnapshotUpdateIsMonotonic(queued, running), true);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(running, attention), true);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(attention, { ...running, revision: 4, updatedAt: 2_650 }), true);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(attention, stopped), true);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(stopped, { ...running, revision: 5, updatedAt: 2_800 }), false);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(running, { ...queued, revision: 3, updatedAt: 2_600 }), false);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(running, running), false);
  assert.equal(subagentRunSnapshotUpdateIsMonotonic(running, running, { allowExactReplay: true }), true);
  assert.equal(
    subagentRunSnapshotUpdateIsMonotonic(queued, { ...running, label: "Renamed" }),
    false,
  );
});

test("parsedSubagentRunSnapshotUpdateIsMonotonic matches raw monotonicity rules without re-parsing", () => {
  const queued = parseSubagentRunSnapshotV2({
    ...v2("queued"),
    projectionNotices: ["task_truncated"],
  })!;
  const running = parseSubagentRunSnapshotV2({
    ...v2("running"),
    revision: 2,
    updatedAt: 2_500,
    turns: 3,
    tools: 4,
    tokens: 150,
    milestones: ["reading"],
    projectionNotices: ["task_truncated"],
  })!;
  const completed = parseSubagentRunSnapshotV2({
    ...v2("completed"),
    revision: 3,
    updatedAt: 2_900,
    finishedAt: 2_900,
    turns: 4,
    tools: 5,
    tokens: 220,
    milestones: ["reading", "composing"],
    projectionNotices: ["task_truncated", "report_truncated"],
    warnings: ["Minor warning"],
  })!;

  const pairs: Array<
    [SubagentRunSnapshotV2, SubagentRunSnapshotV2, { allowExactReplay?: boolean } | undefined, boolean]
  > = [
    [queued, running, undefined, true],
    [running, completed, undefined, true],
    [parseSubagentRunSnapshotV2(v2("queued"))!, running, undefined, false],
    [completed, { ...running, revision: 4, updatedAt: 3_000 }, undefined, false],
    [running, running, undefined, false],
    [running, structuredClone(running), { allowExactReplay: true }, true],
    [completed, structuredClone(completed), { allowExactReplay: true }, true],
    [
      completed,
      { ...completed, warnings: ["Rewritten on same revision"] },
      { allowExactReplay: true },
      false,
    ],
    [
      running,
      { ...running, revision: 3, milestones: ["composing"] },
      undefined,
      false,
    ],
    [
      running,
      { ...running, revision: 3, authorityRevision: 2 },
      undefined,
      false,
    ],
  ];

  for (const [current, next, options, expected] of pairs) {
    assert.equal(parsedSubagentRunSnapshotUpdateIsMonotonic(current, next, options), expected);
    assert.equal(subagentRunSnapshotUpdateIsMonotonic(current, next, options), expected);
  }
});

test("adaptSubagentRunSnapshotV2ToV1 validates once and returns fresh array clones", () => {
  const source = {
    ...v2("stopped"),
    milestones: ["reading"] as SubagentRunSnapshotV2["milestones"],
    projectionNotices: ["display_filtered"] as SubagentRunSnapshotV2["projectionNotices"],
    warnings: ["Stopped cleanly"],
  };
  let taskPreviewReads = 0;
  Object.defineProperty(source, "taskPreview", {
    enumerable: true,
    get() {
      taskPreviewReads += 1;
      return "Review the authority boundary.";
    },
  });

  const adapted = adaptSubagentRunSnapshotV2ToV1(source);
  assert.ok(adapted);
  assert.equal(taskPreviewReads, 1);
  assert.equal(adapted.version, 1);
  assert.equal(adapted.state, "interrupted");
  assert.notEqual(adapted.warnings, source.warnings);
  assert.notEqual(adapted.milestones, source.milestones);
  assert.notEqual(adapted.projectionNotices, source.projectionNotices);
});
