import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalPrompt } from "./ipc";
import type {
  SubagentRunGrantApprovalDetails,
  SubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant";
import type { AgentStep } from "../shared/generation-timeline";
import type { SubagentTranscriptV1 } from "../shared/subagent-transcript";
import {
  MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS,
  rememberSubagentHelperTranscript,
  subagentHelperApprovalFor,
  subagentHelperProblem,
  subagentHelperTimeline,
  subagentHelperWorkSummary,
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
  assert.equal(subagentHelperProblem({ state: "running", label: "Scout" }, work), null);
  assert.equal(subagentHelperProblem({ state: "completed", label: "Scout" }, work), null);
  assert.equal(subagentHelperProblem({ state: "needs_attention", label: "Scout" }, work), null);

  const stopped = subagentHelperProblem({ state: "stopped", label: "Scout" }, work);
  assert.equal(stopped?.tone, "stopped");
  assert.equal(
    stopped?.text,
    "You stopped this helper after 4 steps. It changed src/a.ts, src/b.ts and 1 more.",
  );
  assert.equal(
    stopped?.retryText,
    "Please retry the helper 'Scout'. It stopped after 4 steps and changed src/a.ts, src/b.ts and 1 more.",
  );

  const timedOut = subagentHelperProblem(
    { state: "timed_out", label: "Scout" },
    { steps: 1, changedFiles: [] },
  );
  assert.equal(timedOut?.tone, "failed");
  assert.equal(timedOut?.title, "Ran out of time");
  assert.equal(timedOut?.text, "This helper ran out of time after 1 step. It changed nothing.");

  // A failure keeps its own reason as one sentence.
  const failed = subagentHelperProblem(
    { state: "failed", label: "Scout", error: "The provider refused the request " },
    { steps: 0, changedFiles: ["README.md"] },
  );
  assert.equal(failed?.text, "The provider refused the request. It changed README.md.");
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
