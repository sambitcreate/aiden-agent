import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalPrompt } from "./ipc";
import type {
  SubagentRunGrantApprovalDetails,
  SubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant";
import type { AgentStep } from "../shared/generation-timeline";
import type { SubagentRunSnapshotV2 } from "../shared/subagent-runs";
import { mergeSubagentTranscript, type SubagentTranscriptV1 } from "../shared/subagent-transcript";
import {
  MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS,
  rememberSubagentHelperTranscript,
  subagentFailureReason,
  subagentHelperApprovalFor,
  subagentHelperApprovalsFor,
  subagentHelperBlocks,
  subagentHelperHasActiveHelpers,
  subagentHelperProblem,
  subagentHelperTimeline,
  subagentHelperTranscriptRefetchReason,
  subagentHelperWorkSummary,
  withSubagentApprovalWaitSnapshots,
  withSubagentApprovalWaitViews,
  type SavedSubagentHelperTranscripts,
} from "./subagent-helper-chat-state";

function toolStep(id: string, extra: Partial<Extract<AgentStep, { kind: "tool" }>> = {}): AgentStep {
  return {
    id,
    order: 1,
    kind: "tool",
    toolCallId: `call-${id}`,
    toolName: "read",
    label: "Read a file",
    status: "completed",
    startedAt: 1_000,
    updatedAt: 1_100,
    finishedAt: 1_100,
    ...extra,
  };
}

function transcript(
  runId: string,
  revision: number,
  messages: Array<{ text: string; steps?: AgentStep[]; finishedAt?: number }> = [],
): SubagentTranscriptV1 {
  return {
    version: 1,
    runId,
    revision,
    trimmed: false,
    entries: [
      { kind: "task", text: "Find the parser." },
      ...messages.map((message) => ({
        kind: "message" as const,
        text: message.text,
        steps: message.steps ?? [],
        startedAt: 1_000,
        ...(message.finishedAt === undefined ? {} : { finishedAt: message.finishedAt }),
      })),
    ],
  };
}

test("the work summary counts tool steps across messages and lists each changed file once", () => {
  const summary = subagentHelperWorkSummary(
    transcript("run-1", 3, [
      {
        text: "Looking.",
        steps: [
          toolStep("a"),
          { id: "t", order: 2, kind: "thinking", startedAt: 1_000, updatedAt: 1_000 },
          toolStep("b", { target: "src/a.ts", lineChanges: { additions: 2, deletions: 0 } }),
        ],
      },
      {
        text: "Editing.",
        steps: [
          toolStep("c", { target: "src/b.ts", lineChanges: { additions: 1, deletions: 1 } }),
          toolStep("d", { target: "src/a.ts", lineChanges: { additions: 1, deletions: 0 } }),
          toolStep("e", { target: "src/read-only.ts" }),
        ],
      },
    ]),
  );
  assert.deepEqual(summary, { steps: 5, changedFiles: ["src/a.ts", "src/b.ts"] });
  assert.deepEqual(subagentHelperWorkSummary(null), { steps: 0, changedFiles: [] });
});

test("only a helper that ended without finishing gets a problem, explained in plain words", () => {
  const work = { steps: 4, changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] };
  const scout = { label: "Scout", tools: 4 };
  assert.equal(subagentHelperProblem({ ...scout, state: "running" }, work), null);
  assert.equal(subagentHelperProblem({ ...scout, state: "completed" }, work), null);
  assert.equal(subagentHelperProblem({ ...scout, state: "needs_attention" }, work), null);

  const stopped = subagentHelperProblem({ ...scout, state: "stopped" }, work);
  assert.equal(stopped?.tone, "stopped");
  assert.equal(
    stopped?.text,
    "You stopped this helper after 4 steps. It changed src/a.ts, src/b.ts and 1 more.",
  );
  assert.equal(
    stopped?.retryText,
    "Please retry the helper \u201cScout\u201d. It was stopped after 4 steps and changed src/a.ts, src/b.ts and 1 more.",
  );

  // A helper stopped before any step says nothing about a step count.
  const early = subagentHelperProblem(
    { ...scout, tools: 0, state: "stopped" },
    { steps: 0, changedFiles: [] },
  );
  assert.equal(early?.text, "You stopped this helper. It didn't change any files.");
  assert.doesNotMatch(early?.retryText ?? "", /\d+ steps?/u);

  const timedOut = subagentHelperProblem(
    { ...scout, tools: 1, state: "timed_out" },
    { steps: 1, changedFiles: [] },
  );
  assert.equal(timedOut?.tone, "failed");
  assert.equal(timedOut?.text, "This helper ran out of time after 1 step. It didn't change any files.");
  assert.match(timedOut?.retryText ?? "", /It timed out after 1 step and didn't change any files\.$/u);
});

test("a failed helper says it couldn't finish, adding the reason only when it tells the person something", () => {
  const failed = subagentHelperProblem(
    { state: "failed", label: "Scout", tools: 0, error: "The provider refused the request " },
    { steps: 0, changedFiles: ["README.md"] },
  );
  assert.equal(
    failed?.text,
    "This helper couldn't finish. The provider refused the request. It changed README.md.",
  );
  assert.match(failed?.retryText ?? "", /It failed and changed README\.md\.$/u);

  // Host fallbacks that only restate the failure are not repeated, old or new.
  for (const error of ["This helper couldn't finish.", "The child model could not complete this task."]) {
    const generic = subagentHelperProblem(
      { state: "failed", label: "Scout", tools: 2, error },
      { steps: 2, changedFiles: [] },
    );
    assert.equal(generic?.text, "This helper couldn't finish. It didn't change any files.");
  }
});

test("a trimmed transcript counts steps from the run and claims nothing about unchanged files", () => {
  // The oldest steps were trimmed away: only 1 is left, but the run took 6.
  const trimmed = subagentHelperProblem(
    { state: "stopped", label: "Scout", tools: 6 },
    { steps: 1, changedFiles: [] },
    { trimmed: true },
  );
  assert.equal(trimmed?.text, "You stopped this helper after 6 steps.");
  assert.equal(trimmed?.retryText, "Please retry the helper \u201cScout\u201d. It was stopped after 6 steps.");

  const trimmedWithFiles = subagentHelperProblem(
    { state: "stopped", label: "Scout", tools: 6 },
    { steps: 3, changedFiles: ["a.html", "b.css"] },
    { trimmed: true },
  );
  assert.equal(trimmedWithFiles?.text, "You stopped this helper after 6 steps. It changed a.html and b.css.");
});

test("a saved transcript is kept only when newer, and the oldest helpers drop past the cap", () => {
  let saved: SavedSubagentHelperTranscripts = new Map();
  saved = rememberSubagentHelperTranscript(saved, transcript("run-1", 2));
  const same = rememberSubagentHelperTranscript(saved, transcript("run-1", 2));
  assert.equal(same, saved, "an equal revision changes nothing");
  const older = rememberSubagentHelperTranscript(saved, transcript("run-1", 1, [{ text: "old" }]));
  assert.equal(older.get("run-1")?.revision, 2);
  const newer = rememberSubagentHelperTranscript(saved, transcript("run-1", 5, [{ text: "new" }]));
  assert.equal(newer.get("run-1")?.revision, 5);

  let many: SavedSubagentHelperTranscripts = new Map();
  for (let index = 0; index <= MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS; index += 1) {
    many = rememberSubagentHelperTranscript(many, transcript(`run-${index}`, 1));
  }
  assert.equal(many.size, MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS);
  assert.equal(many.has("run-0"), false);
  assert.equal(many.has(`run-${MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS}`), true);
});

function approval(approvalId: string, details: ApprovalPrompt["details"]): ApprovalPrompt {
  return { approvalId, toolCallId: `call-${approvalId}`, toolName: "edit", summary: "Edit", details };
}

const writeDetails = (childLabel: string): SubagentWorkspaceWriteApprovalDetails => ({
  kind: "subagent-workspace-write",
  operation: "edit",
  childLabel,
  path: "src/a.ts",
  workspaceLabel: "Aiden",
  worktreeLabel: null,
  isManagedWorktree: false,
  preDigestPrefix: "0123456789ab",
  postDigestPrefix: "abcdef012345",
  beforeBytes: 10,
  afterBytes: 12,
  diffPreview: "- a\n+ b",
  diffTruncated: false,
  commandWillRun: false,
  refuseIfChanged: true,
});

const grantDetails = (runId: string, childLabel: string): SubagentRunGrantApprovalDetails => ({
  kind: "subagent-run-grant",
  lane: "write",
  runId,
  childLabel,
  workspaceLabel: "Aiden",
  worktreeLabel: null,
  isManagedWorktree: false,
  workspaceRevisionPrefix: "0123456789ab",
  fullHostAccess: false,
  noRollback: false,
});

test("a helper chat shows only the approval that belongs to its helper", () => {
  const scout = { runId: "run-1", label: "Scout" };
  const twin = { runId: "run-2", label: "Scout" };
  const fixer = { runId: "run-3", label: "Fixer" };
  const grant = approval("grant", grantDetails("run-1", "Scout"));
  const write = approval("write", writeDetails("Scout"));
  const plain = approval("plain", undefined);

  // A run grant names its run, so it matches even when labels repeat.
  assert.equal(subagentHelperApprovalFor(scout, [plain, grant], [scout, twin])?.approvalId, "grant");
  assert.equal(subagentHelperApprovalFor(twin, [grant], [scout, twin]), null);
  // A write names only the label: it matches a unique label, never an ambiguous one.
  assert.equal(subagentHelperApprovalFor(scout, [write], [scout, fixer])?.approvalId, "write");
  assert.equal(subagentHelperApprovalFor(scout, [write], [scout, twin, fixer]), null);
  assert.equal(subagentHelperApprovalFor(fixer, [write, plain], [scout, fixer]), null);
});

test("a helper message's steps run, finish, or stop with the helper", () => {
  const open = transcript("run-1", 2, [{ text: "Working", steps: [toolStep("a")] }]).entries[1];
  const done = transcript("run-1", 2, [{ text: "Done", finishedAt: 2_000 }]).entries[1];
  assert.ok(open?.kind === "message" && done?.kind === "message");
  assert.equal(subagentHelperTimeline("run-1", 1, open, "running").status, "running");
  assert.equal(subagentHelperTimeline("run-1", 1, open, "stopped").status, "cancelled");
  assert.equal(subagentHelperTimeline("run-1", 1, open, "timed_out").status, "failed");
  assert.equal(subagentHelperTimeline("run-1", 1, done, "running").status, "completed");
  // Only tool steps reach the activity rows.
  const withThinking = transcript("run-1", 2, [
    {
      text: "",
      steps: [{ id: "t", order: 1, kind: "thinking", startedAt: 1, updatedAt: 1 }, toolStep("a")],
    },
  ]).entries[1];
  assert.ok(withThinking?.kind === "message");
  assert.deepEqual(
    subagentHelperTimeline("run-1", 1, withThinking, "running").steps.map((step) => step.id),
    ["a"],
  );
});

test("consecutive tool-only messages read as one block of steps, and a written message ends the group", () => {
  const blocks = subagentHelperBlocks(
    transcript("run-1", 5, [
      { text: "", steps: [toolStep("a")] },
      { text: "", steps: [toolStep("b"), toolStep("c")], finishedAt: 1_500 },
      { text: "Found the parser." },
      { text: "", steps: [toolStep("d")] },
    ]),
  );
  assert.deepEqual(
    blocks.map((block) =>
      block.kind === "task"
        ? ["task", block.text]
        : [block.key, block.entry.text, block.entry.steps.map((step) => step.id)],
    ),
    [
      ["task", "Find the parser."],
      ["message-1", "", ["a", "b", "c"]],
      ["message-3", "Found the parser.", []],
      ["message-4", "", ["d"]],
    ],
  );
  const grouped = blocks[1];
  assert.equal(grouped?.kind === "message" ? grouped.entry.finishedAt : null, 1_500);
});

test("the runner's reasons for a failed helper read as plain sentences, and other text passes through", () => {
  assert.equal(
    subagentFailureReason("The child reached its turn limit. These are incomplete, unverified partial findings."),
    "It ran out of turns before finishing. Its findings so far may be incomplete.",
  );
  assert.equal(
    subagentFailureReason("The child reached its tool-call limit."),
    "It used all of its allowed steps before finishing.",
  );
  // Two runner phrases that mean the same thing are said once.
  assert.equal(
    subagentFailureReason(
      "The child did not provide a final text report. The child completed without a textual assistant result.",
    ),
    "It stopped without writing a report.",
  );
  // A phrase that only restates the failure adds nothing.
  assert.equal(subagentFailureReason("The child could not complete this task."), null);
  assert.equal(subagentFailureReason("   "), null);
  assert.equal(subagentFailureReason("The provider returned 429"), "The provider returned 429.");

  const problem = subagentHelperProblem(
    { state: "failed", label: "Scout", tools: 3, error: "The child reached its turn limit." },
    { steps: 3, changedFiles: [] },
  );
  assert.equal(
    problem?.text,
    "This helper couldn't finish. It ran out of turns before finishing. It didn't change any files.",
  );
  assert.doesNotMatch(problem?.text ?? "", /child/iu);
});

test("every approval a helper is waiting on belongs to it, in queue order", () => {
  const scout = { runId: "run-1", label: "Scout" };
  const fixer = { runId: "run-3", label: "Fixer" };
  const first = approval("first", grantDetails("run-1", "Scout"));
  const other = approval("other", grantDetails("run-3", "Fixer"));
  const second = approval("second", writeDetails("Scout"));
  const owned = subagentHelperApprovalsFor(scout, [first, other, second], [scout, fixer]);
  assert.deepEqual(
    owned.map((prompt) => prompt.approvalId),
    ["first", "second"],
  );
  assert.equal(subagentHelperApprovalFor(scout, [other, second, first], [scout, fixer])?.approvalId, "second");
});

function snapshot(runId: string, extra: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId,
    groupId: "group-1",
    generationId: "generation-1",
    childId: `child-${runId}`,
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "scout",
    label: runId,
    taskPreview: "Look around",
    state: "running",
    activity: "Reading files",
    startedAt: 1_000,
    updatedAt: 2_000,
    modelId: "test-model",
    turns: 1,
    tools: 0,
    tokens: 0,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
    ...extra,
  };
}

test("a running helper with a pending approval shows as waiting on you, and nothing else changes", () => {
  const waiting = snapshot("run-1");
  const busy = snapshot("run-2");
  const done = snapshot("run-3", { state: "completed", finishedAt: 3_000 });
  const runs = [waiting, busy, done];
  const grant = approval("grant", grantDetails("run-1", "run-1"));
  const doneGrant = approval("late", grantDetails("run-3", "run-3"));

  const overlaid = withSubagentApprovalWaitSnapshots(runs, [grant, doneGrant]);
  assert.deepEqual(
    overlaid.map((run) => run.state),
    ["needs_attention", "running", "completed"],
  );
  assert.equal(runs[0]?.state, "running", "the server's snapshot is not changed in place");

  // Nothing pending, or nothing pending for a running helper: the same array comes back.
  assert.equal(withSubagentApprovalWaitSnapshots(runs, []), runs);
  assert.equal(withSubagentApprovalWaitSnapshots(runs, [doneGrant]), runs);

  const views = runs.map((run) => ({ runId: run.runId, state: run.state, snapshot: run }));
  const overlaidViews = withSubagentApprovalWaitViews(views, [grant]);
  assert.equal(overlaidViews[0]?.state, "needs_attention");
  assert.equal(overlaidViews[0]?.snapshot?.state, "needs_attention");
  assert.equal(overlaidViews[1], views[1]);
  assert.equal(withSubagentApprovalWaitViews(views, [doneGrant]), views);
});

test("Stop says it stops everything only while a helper under this one is still working", () => {
  const parent = snapshot("run-1");
  const child = snapshot("run-2", { parentRunId: "run-1", depth: 2 });
  const sibling = snapshot("run-3");
  const view = (run: SubagentRunSnapshotV2, terminal = false) => ({ terminal, snapshot: run });

  assert.equal(subagentHelperHasActiveHelpers("run-1", [view(parent), view(child)]), true);
  assert.equal(subagentHelperHasActiveHelpers("run-1", [view(parent), view(child, true)]), false);
  assert.equal(subagentHelperHasActiveHelpers("run-1", [view(parent), view(sibling)]), false);
  assert.equal(subagentHelperHasActiveHelpers("run-2", [view(parent), view(child)]), false);
});

test("a window reads a helper's saved conversation again only for a new reason", () => {
  const saved = transcript("run-1", 3, [{ text: "First look." }]);
  const complete = mergeSubagentTranscript(saved, null);
  const running = snapshot("run-1", { revision: 4 });

  // Updates stream to this window: the saved copy is not read again.
  assert.equal(subagentHelperTranscriptRefetchReason(running, complete, true), null);

  // Another window runs the chat: each move of the run is its own reason, including the end.
  const moved = subagentHelperTranscriptRefetchReason(running, complete, false);
  const movedAgain = subagentHelperTranscriptRefetchReason({ ...running, revision: 5 }, complete, false);
  const finished = subagentHelperTranscriptRefetchReason({ state: "completed", revision: 5 }, complete, false);
  assert.ok(moved && movedAgain && finished);
  assert.equal(new Set([moved, movedAgain, finished]).size, 3);
  assert.equal(subagentHelperTranscriptRefetchReason(running, complete, false), moved, "the same run reads once");

  // A gap in the streamed updates is read even while they stream here.
  const gap = mergeSubagentTranscript(saved, {
    version: 1,
    runId: "run-1",
    baseRevision: 5,
    revision: 6,
    trimmed: false,
    entryCount: 3,
    changes: [],
  });
  assert.equal(gap.complete, false);
  assert.ok(subagentHelperTranscriptRefetchReason(running, gap, true));

  // Nothing here yet: a running helper reads once; one that ended has nothing more to read.
  const empty = mergeSubagentTranscript(null, null);
  assert.ok(subagentHelperTranscriptRefetchReason(running, empty, true));
  assert.equal(subagentHelperTranscriptRefetchReason({ state: "completed", revision: 2 }, empty, false), null);
});
