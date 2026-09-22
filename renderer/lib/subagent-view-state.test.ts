import assert from "node:assert/strict";
import test from "node:test";

import type {
  SubagentMessageReferenceV1,
  SubagentRunSnapshotV1,
  SubagentRunSnapshotV2,
} from "../shared/subagent-runs.js";
import { adaptSubagentRunSnapshotV2ToV1 } from "../shared/subagent-runs.js";
import {
  buildSubagentRunViews,
  captureSubagentDetailRequest,
  deriveSubagentRunPresentation,
  formatSubagentElapsed,
  isSubagentSelectionValid,
  isSubagentRunViewHandoffPending,
  isSubagentRunViewSaveDelayed,
  isSubagentRunViewStale,
  mergeSubagentHistorySnapshot,
  mergeSubagentSnapshot,
  mergeSubagentSnapshots,
  reconcileSubagentPersistenceHandoff,
  resolveSubagentDetailResult,
  resolveSubagentSelection,
  splitSubagentRunViews,
  subagentElapsedLabel,
  subagentStatusLabel,
  summarizeSubagentRunViews,
  type SubagentRunView,
} from "./subagent-view-state.js";

function snapshot(overrides: Partial<SubagentRunSnapshotV1> = {}): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    groupId: "generation-1:group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review the implementation.",
    state: "completed",
    startedAt: 1_000,
    updatedAt: 3_000,
    finishedAt: 3_000,
    modelId: "model-1",
    turns: 2,
    tools: 1,
    tokens: 100,
    warnings: [],
    ...overrides,
  };
}

type V2TerminalState = "completed" | "failed" | "timed_out" | "interrupted" | "stopped" | "unknown";

function v2TerminalSnapshot(state: V2TerminalState): SubagentRunSnapshotV2 {
  const v1State = state === "stopped" ? "interrupted" : state === "unknown" ? "failed" : state;
  return {
    ...snapshot({
      runId: `run-v2-${state}`,
      childId: `child-v2-${state}`,
      state: v1State,
      updatedAt: 3_000,
      finishedAt: 3_000,
    }),
    version: 2,
    state,
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
  };
}

function legacyReference(
  runIds: string[],
  counts: Pick<SubagentMessageReferenceV1, "completed" | "failed" | "timedOut" | "interrupted"> = {
    completed: runIds.length,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  },
): SubagentMessageReferenceV1 {
  return {
    version: 1,
    generationId: "generation-1",
    runIds,
    total: runIds.length,
    ...counts,
  };
}

function enrichedReference(): SubagentMessageReferenceV1 {
  return {
    version: 1,
    generationId: "generation-1",
    runIds: ["run-1"],
    items: [{ runId: "run-1", label: "Persisted review", role: "reviewer", state: "completed" }],
    total: 1,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
}

function terminalReference(value: SubagentRunSnapshotV1): SubagentMessageReferenceV1 {
  assert.ok(value.finishedAt !== undefined);
  assert.ok(
    value.state === "completed" ||
      value.state === "failed" ||
      value.state === "timed_out" ||
      value.state === "interrupted",
  );
  return {
    version: 1,
    generationId: value.generationId,
    runIds: [value.runId],
    items: [
      {
        runId: value.runId,
        label: value.label,
        role: value.role,
        state: value.state,
      },
    ],
    total: 1,
    completed: value.state === "completed" ? 1 : 0,
    failed: value.state === "failed" ? 1 : 0,
    timedOut: value.state === "timed_out" ? 1 : 0,
    interrupted: value.state === "interrupted" ? 1 : 0,
  };
}

test("snapshot merging is revision-monotonic and bound to immutable ownership", () => {
  const current = snapshot({ state: "running", finishedAt: undefined });
  const canonicalCurrent = mergeSubagentSnapshot(undefined, current)!;
  assert.deepEqual(
    mergeSubagentSnapshot(current, snapshot({ revision: 1, label: "Replayed" })),
    canonicalCurrent,
  );
  assert.equal(
    mergeSubagentSnapshot(
      current,
      snapshot({ revision: 2, state: "running", finishedAt: undefined }),
    )?.revision,
    2,
  );
  assert.deepEqual(
    mergeSubagentSnapshot(current, snapshot({ revision: 3, groupId: "generation-1:replacement" })),
    canonicalCurrent,
  );
  assert.deepEqual(
    mergeSubagentSnapshot(current, snapshot({ revision: 3, startedAt: 999 })),
    canonicalCurrent,
  );
  assert.equal(
    mergeSubagentSnapshot(undefined, snapshot({ chatId: "other-chat" }), {
      chatId: "chat-1",
      workspaceId: "workspace-1",
    }),
    undefined,
  );
  assert.equal(
    mergeSubagentSnapshot(undefined, snapshot({ workspaceId: "other-workspace" }), {
      chatId: "chat-1",
      workspaceId: "workspace-1",
    }),
    undefined,
  );
});

test("snapshot merging rejects terminal revival, display drift, and backward progress", () => {
  for (const terminalState of ["stopped", "unknown"] as const) {
    const terminal = v2TerminalSnapshot(terminalState);
    const running = {
      ...terminal,
      revision: 2,
      state: "running" as const,
      updatedAt: 4_000,
      finishedAt: undefined,
    };
    const completed = {
      ...terminal,
      revision: 2,
      state: "completed" as const,
      updatedAt: 4_000,
      finishedAt: 4_000,
    };
    assert.deepEqual(mergeSubagentSnapshot(terminal, running), terminal);
    assert.deepEqual(mergeSubagentSnapshot(terminal, completed), terminal);
  }

  const active = snapshot({
    revision: 2,
    state: "running",
    updatedAt: 2_000,
    finishedAt: undefined,
    turns: 2,
    tools: 2,
    tokens: 200,
    milestones: ["reading", "searching"],
    projectionNotices: ["task_truncated"],
  });
  const canonicalActive = mergeSubagentSnapshot(undefined, active)!;
  const next: SubagentRunSnapshotV1 = {
    ...active,
    revision: 3,
    updatedAt: 3_000,
    turns: 3,
    tools: 3,
    tokens: 300,
    milestones: ["reading", "searching", "composing"],
  };
  assert.equal(mergeSubagentSnapshot(active, next)?.revision, 3);

  for (const drift of [
    { role: "planner" as const },
    { label: "Rewritten label" },
    { taskPreview: "Rewritten task" },
    { modelId: "other-model" },
  ]) {
    assert.deepEqual(mergeSubagentSnapshot(active, { ...next, ...drift }), canonicalActive);
  }
  for (const regression of [
    { updatedAt: 1_999 },
    { turns: 1 },
    { tools: 1 },
    { tokens: 199 },
    { milestones: ["reading"] },
    { milestones: ["searching", "reading", "composing"] },
    { projectionNotices: undefined },
    { state: "starting" as const },
  ]) {
    assert.deepEqual(
      mergeSubagentSnapshot(active, { ...next, ...regression } as SubagentRunSnapshotV1),
      canonicalActive,
    );
  }
});

test("a newer terminal snapshot atomically rejects stale history and its effects", () => {
  const owner = { chatId: "chat-1", workspaceId: "workspace-1" };
  const newerTerminal = snapshot({
    revision: 3,
    state: "failed",
    updatedAt: 5_000,
    finishedAt: 5_000,
    error: "Current failure",
  });
  const staleHistory = snapshot({
    revision: 2,
    state: "completed",
    updatedAt: 4_000,
    finishedAt: 4_000,
    terminalMarkdown: "Stale success",
  });
  const cached = snapshot({
    runId: "cached-run",
    childId: "cached-child",
    revision: 1,
  });
  let effects = ["accepted-current-effect"];
  const merged = mergeSubagentHistorySnapshot([cached], [], [newerTerminal], staleHistory, owner);
  if (merged.accepted) effects = ["stale-history-effect"];

  assert.equal(merged.accepted, false);
  assert.deepEqual(merged.loadedSnapshots, [cached]);
  assert.deepEqual(effects, ["accepted-current-effect"]);
});

test("terminal detail remains continuous while live state hands off to persistence", () => {
  const owner = { chatId: "chat-1", workspaceId: "workspace-1" };
  const terminal = snapshot({
    revision: 7,
    label: "Final review",
    activity: "Writing a bounded report",
  });
  const awaitingReference = reconcileSubagentPersistenceHandoff([], [], [terminal], [], [], owner);

  assert.deepEqual(awaitingReference.liveSnapshots, []);
  assert.deepEqual(awaitingReference.loadedSnapshots, []);
  assert.equal(awaitingReference.handoffSnapshots[0]?.revision, 7);
  const gapView = buildSubagentRunViews(
    owner.chatId,
    [],
    awaitingReference.handoffSnapshots,
    owner.workspaceId,
  )[0];
  assert.equal(gapView?.runId, terminal.runId);
  assert.equal(gapView?.snapshot?.revision, 7);
  assert.equal(isSubagentRunViewHandoffPending(gapView!, awaitingReference.handoffSnapshots), true);
  assert.deepEqual(
    deriveSubagentRunPresentation(gapView!, awaitingReference.handoffSnapshots, 4_000, 30_000),
    { state: "saving", label: "Saving subagent result · child outcome: Done" },
  );

  const messages = [
    {
      id: "message-1",
      createdAt: 10,
      subagents: terminalReference(terminal),
    },
  ];
  const persisted = reconcileSubagentPersistenceHandoff(
    awaitingReference.loadedSnapshots,
    awaitingReference.handoffSnapshots,
    awaitingReference.liveSnapshots,
    [],
    messages,
    owner,
  );

  assert.deepEqual(persisted.handoffSnapshots, []);
  assert.equal(persisted.loadedSnapshots[0]?.revision, 7);
  const savedView = buildSubagentRunViews(
    owner.chatId,
    messages,
    persisted.loadedSnapshots,
    owner.workspaceId,
  )[0];
  assert.equal(savedView?.referenceMessageId, "message-1");
  assert.equal(savedView?.snapshot?.revision, 7);
  assert.equal(isSubagentRunViewHandoffPending(savedView!, persisted.handoffSnapshots), false);
  assert.deepEqual(
    deriveSubagentRunPresentation(savedView!, persisted.handoffSnapshots, 4_000, 30_000),
    { state: "terminal", label: "Done" },
  );
});

test("V2 terminal handoff preserves outcome and bounds delayed saving", () => {
  const owner = { chatId: "chat-1", workspaceId: "workspace-1" };
  const delayAfterMs = 30_000;
  const terminalStates: readonly [V2TerminalState, string][] = [
    ["completed", "Done"],
    ["failed", "Failed"],
    ["timed_out", "Timed out"],
    ["interrupted", "Interrupted"],
    ["stopped", "Stopped"],
    ["unknown", "Outcome unknown"],
  ];

  for (const [state, outcome] of terminalStates) {
    const terminal = v2TerminalSnapshot(state);
    const original = structuredClone(terminal);
    const handoff = reconcileSubagentPersistenceHandoff([], [], [terminal], [], [], owner);
    const view = buildSubagentRunViews(
      owner.chatId,
      [],
      handoff.handoffSnapshots,
      owner.workspaceId,
    )[0]!;

    assert.equal(view.snapshot?.version, 2);
    assert.equal(isSubagentRunViewHandoffPending(view, handoff.handoffSnapshots), true);
    assert.equal(isSubagentRunViewSaveDelayed(view, 32_999, delayAfterMs), false);
    assert.deepEqual(
      deriveSubagentRunPresentation(view, handoff.handoffSnapshots, 32_999, delayAfterMs),
      { state: "saving", label: `Saving subagent result · child outcome: ${outcome}` },
    );

    assert.equal(isSubagentRunViewSaveDelayed(view, 33_000, delayAfterMs), true);
    const delayed = deriveSubagentRunPresentation(
      view,
      handoff.handoffSnapshots,
      33_000,
      delayAfterMs,
    );
    assert.deepEqual(delayed, {
      state: "save_delayed",
      label: `Save delayed · child outcome: ${outcome}`,
    });
    assert.equal(
      deriveSubagentRunPresentation(view, handoff.handoffSnapshots, Number.MAX_VALUE, delayAfterMs)
        .state,
      "save_delayed",
    );
    assert.ok(delayed.label.length < 96);
    assert.doesNotMatch(delayed.label, /attached|saved successfully/iu);
    assert.deepEqual(view.snapshot, original);
    assert.deepEqual(terminal, original);
  }

  for (const state of ["stopped", "unknown"] as const) {
    const terminal = v2TerminalSnapshot(state);
    const projected = adaptSubagentRunSnapshotV2ToV1(terminal);
    assert.ok(projected);
    assert.equal(projected.state, state === "stopped" ? "interrupted" : "failed");
    const awaitingReference = reconcileSubagentPersistenceHandoff(
      [],
      [],
      [terminal],
      [],
      [],
      owner,
    );
    const promoted = reconcileSubagentPersistenceHandoff(
      [],
      awaitingReference.handoffSnapshots,
      [],
      [],
      [{ id: `message-${state}`, createdAt: 10, subagents: terminalReference(projected) }],
      owner,
    );
    assert.deepEqual(promoted.handoffSnapshots, []);
    assert.equal(promoted.loadedSnapshots[0]?.version, 2);
    assert.equal(promoted.loadedSnapshots[0]?.state, state);
  }

  const completed = v2TerminalSnapshot("completed");
  const awaitingReference = reconcileSubagentPersistenceHandoff([], [], [completed], [], [], owner);
  const matchingReference = legacyReference([completed.runId]);
  const promoted = reconcileSubagentPersistenceHandoff(
    awaitingReference.loadedSnapshots,
    awaitingReference.handoffSnapshots,
    awaitingReference.liveSnapshots,
    [],
    [{ id: "message-v2", createdAt: 10, subagents: matchingReference }],
    owner,
  );
  assert.deepEqual(promoted.handoffSnapshots, []);
  const promotedView = buildSubagentRunViews(
    owner.chatId,
    [{ id: "message-v2", createdAt: 10, subagents: matchingReference }],
    promoted.loadedSnapshots,
    owner.workspaceId,
  )[0]!;
  assert.equal(isSubagentRunViewHandoffPending(promotedView, promoted.handoffSnapshots), false);
  assert.deepEqual(
    deriveSubagentRunPresentation(promotedView, promoted.handoffSnapshots, 33_000, delayAfterMs),
    { state: "terminal", label: "Done" },
  );

  const conflictingReference = { ...matchingReference, generationId: "generation-other" };
  const conflict = reconcileSubagentPersistenceHandoff(
    [],
    [completed],
    [],
    [],
    [{ id: "message-v2-conflict", createdAt: 11, subagents: conflictingReference }],
    owner,
  );
  assert.deepEqual(conflict.handoffSnapshots, []);
  assert.deepEqual(conflict.loadedSnapshots, []);
});

test("persistence handoff rejects stale owners and conflicting saved identities", () => {
  const owner = { chatId: "chat-1", workspaceId: "workspace-1" };
  const terminal = snapshot({ revision: 7, label: "Final review" });
  const wrongOwner = reconcileSubagentPersistenceHandoff([], [], [terminal], [], [], {
    chatId: "chat-2",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(wrongOwner.handoffSnapshots, []);

  const conflictingReference = terminalReference(terminal);
  conflictingReference.items![0] = {
    ...conflictingReference.items![0]!,
    label: "Different persisted run",
  };
  const conflict = reconcileSubagentPersistenceHandoff(
    [],
    [terminal],
    [],
    [],
    [{ id: "message-1", createdAt: 10, subagents: conflictingReference }],
    owner,
  );
  assert.deepEqual(conflict.handoffSnapshots, []);
  assert.deepEqual(conflict.loadedSnapshots, []);

  const generationConflictReference = terminalReference(terminal);
  generationConflictReference.generationId = "generation-other";
  const generationConflict = reconcileSubagentPersistenceHandoff(
    [],
    [terminal],
    [],
    [],
    [{ id: "message-generation-conflict", createdAt: 11, subagents: generationConflictReference }],
    owner,
  );
  assert.deepEqual(generationConflict.handoffSnapshots, []);
  assert.deepEqual(generationConflict.loadedSnapshots, []);

  const laterGeneration = snapshot({
    runId: "run-later",
    groupId: "generation-2:group-1",
    generationId: "generation-2",
    childId: "child-later",
    state: "running",
    updatedAt: 8_000,
    finishedAt: undefined,
  });
  const unmatchedOlderGeneration = reconcileSubagentPersistenceHandoff(
    [],
    [terminal],
    [],
    [laterGeneration],
    [],
    owner,
  );
  assert.deepEqual(unmatchedOlderGeneration.handoffSnapshots, []);

  const newest = snapshot({
    ...terminal,
    revision: 8,
    updatedAt: 4_000,
    finishedAt: 4_000,
  });
  const monotonic = reconcileSubagentPersistenceHandoff(
    [newest],
    [terminal],
    [],
    [],
    [
      {
        id: "message-1",
        createdAt: 10,
        subagents: terminalReference(terminal),
      },
    ],
    owner,
  );
  assert.equal(monotonic.loadedSnapshots[0]?.revision, 8);
});

test("snapshot batches deduplicate by run ID, retain newest revisions, and sort stably", () => {
  const early = snapshot({
    runId: "run-early",
    childId: "child-early",
    state: "running",
    startedAt: 100,
    updatedAt: 200,
    finishedAt: undefined,
  });
  const late = snapshot({
    runId: "run-late",
    childId: "child-late",
    startedAt: 500,
    updatedAt: 600,
    finishedAt: 600,
  });
  const merged = mergeSubagentSnapshots(
    [late, early],
    [
      snapshot({
        ...early,
        revision: 2,
        updatedAt: 300,
      }),
      snapshot({
        ...late,
        revision: 1,
        label: "Same revision replay",
      }),
      snapshot({ runId: "wrong-chat", childId: "wrong-chat", chatId: "chat-2" }),
    ],
    { chatId: "chat-1", workspaceId: "workspace-1" },
  );

  assert.deepEqual(
    merged.map(({ runId }) => runId),
    ["run-early", "run-late"],
  );
  assert.equal(merged[0]?.revision, 2);
  assert.equal(merged[0]?.label, "Review");
  assert.equal(merged[1]?.label, "Review");
});

test("current-chat views combine durable metadata and live snapshots without duplicate rows", () => {
  const messages = [
    { id: "message-1", createdAt: 10, subagents: enrichedReference() },
    {
      id: "message-2",
      createdAt: 20,
      subagents: legacyReference(["run-1", "run-legacy"]),
    },
  ];
  const live = [
    snapshot({ revision: 2, label: "Live review" }),
    snapshot({
      runId: "run-live",
      groupId: "generation-live:group-1",
      generationId: "generation-live",
      childId: "child-live",
      revision: 4,
      role: "scout",
      label: "Explore",
      state: "running",
      startedAt: 4_000,
      updatedAt: 5_000,
      finishedAt: undefined,
    }),
    snapshot({ runId: "wrong-chat", childId: "wrong-chat", chatId: "chat-2" }),
    snapshot({
      runId: "wrong-workspace",
      childId: "wrong-workspace",
      workspaceId: "workspace-2",
    }),
  ];
  const views = buildSubagentRunViews("chat-1", messages, live, "workspace-1");

  assert.deepEqual(
    views.map(({ runId }) => runId),
    ["run-1", "run-legacy", "run-live"],
  );
  assert.deepEqual(
    views.map(({ source }) => source),
    ["live", "message", "live"],
  );
  assert.deepEqual(
    views.map(({ label }) => label),
    ["Live review", "Subagent 2", "Explore"],
  );
  assert.equal(views[0]?.referenceMessageId, "message-1");
  assert.equal(views[1]?.role, "unknown");
  assert.equal(views[1]?.state, "unknown");
  assert.equal(views[1]?.terminal, true);
  assert.equal(views[2]?.terminal, false);
  assert.deepEqual(
    buildSubagentRunViews("/Users/alice/private-chat", messages, live, "workspace-1"),
    [],
  );
});

test("view ordering keys do not change when a live revision advances", () => {
  const before = buildSubagentRunViews(
    "chat-1",
    [{ id: "message-1", createdAt: 10, subagents: enrichedReference() }],
    [snapshot()],
  );
  const after = buildSubagentRunViews(
    "chat-1",
    [{ id: "message-1", createdAt: 10, subagents: enrichedReference() }],
    [snapshot({ revision: 9, updatedAt: 4_000, finishedAt: 4_000 })],
  );
  assert.equal(before[0]?.sortKey, after[0]?.sortKey);
  assert.equal(after[0]?.snapshot?.revision, 9);
});

test("a same run ID from another generation cannot enrich a persisted reference", () => {
  const views = buildSubagentRunViews(
    "chat-1",
    [{ id: "message-1", createdAt: 10, subagents: enrichedReference() }],
    [
      snapshot({
        generationId: "generation-other",
        groupId: "generation-other:group-1",
        label: "Wrong generation",
      }),
    ],
  );
  assert.equal(views.length, 1);
  assert.equal(views[0]?.source, "message");
  assert.equal(views[0]?.label, "Persisted review");
  assert.equal(views[0]?.snapshot, undefined);
});

test("split and summary helpers deduplicate before counting active and done runs", () => {
  const active = buildSubagentRunViews(
    "chat-1",
    [],
    [
      snapshot({
        state: "running",
        finishedAt: undefined,
      }),
    ],
  )[0]!;
  const done: SubagentRunView = {
    runId: "run-done",
    generationId: "generation-1",
    label: "Done",
    role: "planner",
    state: "failed",
    terminal: true,
    source: "message",
    sortKey: "0:done",
  };
  const duplicateWithoutSnapshot = { ...active, snapshot: undefined, source: "message" as const };
  const split = splitSubagentRunViews([duplicateWithoutSnapshot, done, active]);

  assert.deepEqual(
    split.active.map(({ runId }) => runId),
    ["run-1"],
  );
  assert.deepEqual(
    split.done.map(({ runId }) => runId),
    ["run-done"],
  );
  assert.deepEqual(summarizeSubagentRunViews([duplicateWithoutSnapshot, done, active]), {
    total: 2,
    active: 1,
    done: 1,
    completed: 0,
    failed: 1,
    timedOut: 0,
    interrupted: 0,
    stopped: 0,
    unknown: 0,
  });
});

test("selection helpers retain valid selection and repair stale selection", () => {
  const views = buildSubagentRunViews(
    "chat-1",
    [{ id: "message-1", createdAt: 10, subagents: legacyReference(["run-1", "run-2"]) }],
    [],
  );
  assert.equal(isSubagentSelectionValid("run-2", views), true);
  assert.equal(isSubagentSelectionValid("missing", views), false);
  assert.equal(isSubagentSelectionValid(undefined, views), false);
  assert.equal(resolveSubagentSelection("run-2", views), "run-2");
  assert.equal(resolveSubagentSelection("missing", views), "run-1");
  assert.equal(resolveSubagentSelection(undefined, []), undefined);
});

test("status and elapsed labels are deterministic for active and terminal runs", () => {
  const active = buildSubagentRunViews(
    "chat-1",
    [],
    [snapshot({ state: "running", updatedAt: 2_000, finishedAt: undefined })],
  )[0]!;
  const done = buildSubagentRunViews("chat-1", [], [snapshot()])[0]!;

  assert.equal(subagentStatusLabel("running"), "Working");
  assert.equal(subagentStatusLabel("completed"), "Done");
  assert.equal(subagentStatusLabel("unknown"), "Outcome unknown");
  assert.equal(subagentElapsedLabel(active, 3_725_000), "1h 2m 4s");
  assert.equal(subagentElapsedLabel(done, 9_999_999), "2s");
  assert.equal(formatSubagentElapsed(90_061_000), "1d 1h 1m");
  assert.equal(formatSubagentElapsed(Number.NaN), "0s");
  assert.equal(
    subagentElapsedLabel({
      runId: "legacy",
      generationId: "generation-1",
      label: "Legacy",
      role: "unknown",
      state: "unknown",
      terminal: true,
      source: "message",
      sortKey: "legacy",
    }),
    undefined,
  );
});

test("stale-active presentation is clock-injected, bounded, and terminal-safe", () => {
  const active = buildSubagentRunViews(
    "chat-1",
    [],
    [
      snapshot({
        state: "running",
        updatedAt: 1_000,
        finishedAt: undefined,
        activity: "Reading workspace context",
      }),
    ],
  )[0]!;
  const before = structuredClone(active.snapshot);

  assert.equal(isSubagentRunViewStale(active, 5_999, 5_000), false);
  assert.deepEqual(deriveSubagentRunPresentation(active, [], 5_999, 5_000), {
    state: "active",
    label: "Working",
  });
  assert.equal(isSubagentRunViewStale(active, 6_000, 5_000), true);
  const stale = deriveSubagentRunPresentation(active, [], 6_000, 5_000);
  assert.deepEqual(stale, {
    state: "stale_active",
    label: "Still working; last update 5s ago",
  });
  assert.ok(stale.label.length < 96);
  assert.deepEqual(active.snapshot, before);

  const terminal = buildSubagentRunViews(
    "chat-1",
    [],
    [snapshot({ updatedAt: 1_000, finishedAt: 1_000 })],
  )[0]!;
  assert.equal(isSubagentRunViewStale(terminal, Number.MAX_VALUE, 0), false);
  assert.deepEqual(deriveSubagentRunPresentation(terminal, [], Number.MAX_VALUE, 0), {
    state: "terminal",
    label: "Done",
  });

  const bounded = deriveSubagentRunPresentation(active, [], Number.MAX_VALUE, 0);
  assert.equal(bounded.state, "stale_active");
  assert.ok(bounded.label.length < 96);
  assert.match(bounded.label, /^Still working; last update \d+d \d+h \d+m ago$/u);
});

test("detail results are rejected after request, chat, or selection ownership changes", () => {
  const view = buildSubagentRunViews("chat-1", [], [snapshot({ revision: 2 })])[0]!;
  const request = captureSubagentDetailRequest("chat-1", view, "workspace-1");
  const current = snapshot({ revision: 3 });
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-1", current)?.revision,
    3,
  );
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-1", current, current)?.revision,
    3,
    "an exact persisted replay is an idempotent refresh",
  );
  const driftedRefresh = snapshot({
    ...current,
    revision: 4,
    label: "Rewritten by history",
    updatedAt: 4_000,
    finishedAt: 4_000,
  });
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-1", driftedRefresh, current),
    undefined,
  );
  assert.deepEqual(
    mergeSubagentSnapshot(current, driftedRefresh),
    current,
    "a rejected history refresh preserves the last-good cached snapshot",
  );
  assert.equal(
    resolveSubagentDetailResult(request, { ...request }, "chat-1", "run-1", current),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-2", "run-1", current),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-2", current),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(
      request,
      request,
      "chat-1",
      "run-1",
      snapshot({ runId: "run-2", childId: "child-2" }),
    ),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(
      request,
      request,
      "chat-1",
      "run-1",
      snapshot({ workspaceId: "workspace-2" }),
    ),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-1", {
      ...current,
      terminalMarkdown: "/Users/alice/private.txt",
    }),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-1", snapshot({ revision: 1 })),
    undefined,
  );
  assert.equal(
    resolveSubagentDetailResult(request, request, "chat-1", "run-1", null),
    undefined,
    "a current persisted-detail lookup that returns null is not a successful refresh",
  );
});
