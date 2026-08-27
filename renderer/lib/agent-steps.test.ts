import assert from "node:assert/strict";
import test from "node:test";
import {
  isToolStep,
  hasActiveThinkingStep,
  hasActiveToolStep,
  type AgentStep,
  type AgentThinkingStep,
  type AgentToolStep,
  type GenerationTimeline,
} from "../shared/generation-timeline.js";
import {
  activityIssueCount,
  activityLine,
  activityLineText,
  activityTrailNeedsAttention,
  formatThinkingDuration,
  isActiveStep,
  reasoningActivityLabel,
  summarizeActivity,
} from "./agent-steps.js";
import {
  activityTimelineFragment,
  assistantPresentationRows,
} from "./assistant-message-presentation.js";

function step(
  id: string,
  order: number,
  toolName: string,
  status: AgentToolStep["status"] = "completed",
  extra: Partial<AgentToolStep> = {},
): AgentToolStep {
  return {
    id,
    order,
    kind: "tool",
    toolCallId: `call-${order + 1}`,
    toolName,
    label: toolName,
    status,
    startedAt: order,
    updatedAt: order,
    ...extra,
  };
}

function thinking(id: string, order: number, durationMs?: number): AgentThinkingStep {
  return {
    id,
    order,
    kind: "thinking",
    startedAt: order,
    updatedAt: order,
    ...(durationMs === undefined ? {} : { durationMs, finishedAt: order + 1 }),
  };
}

function timeline(status: GenerationTimeline["status"], steps: AgentStep[]): GenerationTimeline {
  return {
    version: 3,
    generationId: "generation-1",
    status,
    startedAt: 1,
    ...(status === "running" ? {} : { finishedAt: 2 }),
    steps,
  };
}

function tools(counts: Record<string, number>): AgentToolStep[] {
  const steps: AgentToolStep[] = [];
  for (const [toolName, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      steps.push(step(`${toolName}-${index}`, steps.length, toolName));
    }
  }
  return steps;
}

function positionedTool(
  order: number,
  contentOffset: number,
  toolName = "read_file",
): AgentToolStep {
  return step(`tool-${order + 1}`, order, toolName, "completed", { contentOffset });
}

test("splits a row into a verb and the object it acted on", () => {
  assert.deepEqual(
    activityLine(step("read", 0, "read_file", "completed", { target: "src/app.ts" })),
    {
      verb: "Read",
      object: "src/app.ts",
      tone: "normal",
    },
  );
  assert.deepEqual(activityLine(step("glob", 1, "glob", "running", { detail: "src/**/*.ts" })), {
    verb: "Searching files",
    object: "src/**/*.ts",
    tone: "normal",
  });
  assert.equal(
    activityLineText(step("automation", 2, "edit_automation", "completed")),
    "Edited automation",
  );
});

test("alternates prose and grouped activity at exact assistant-text boundaries", () => {
  const content = "Before.Between.After.";
  const rows = assistantPresentationRows(
    content,
    timeline("completed", [
      positionedTool(0, 7),
      positionedTool(1, 15, "grep"),
      positionedTool(2, 15, "subagent"),
    ]),
  );

  assert.deepEqual(
    rows?.map((row) =>
      row.kind === "text"
        ? [row.kind, row.content]
        : [row.kind, row.steps.map((entry) => entry.id)],
    ),
    [
      ["text", "Before."],
      ["activity", ["tool-1"]],
      ["text", "Between."],
      ["activity", ["tool-2", "tool-3"]],
      ["text", "After."],
    ],
  );
});

test("reasoning milestones stay in the dedicated disclosure instead of activity rows", () => {
  const thought = { ...thinking("think-1", 0, 1_000), contentOffset: 7 };
  const rows = assistantPresentationRows("Before.After.", timeline("completed", [thought]));
  assert.deepEqual(
    rows?.map((row) => (row.kind === "text" ? [row.kind, row.content] : [row.kind])),
    [["text", "Before.After."]],
  );
  assert.equal(
    reasoningActivityLabel(timeline("running", [thinking("think-2", 0)]), true),
    "Thinking",
  );
  assert.equal(reasoningActivityLabel(timeline("completed", [thought]), false), "Thought briefly");
});

test("assistant presentation fails closed for legacy or invalid offsets", () => {
  const current = timeline("completed", [positionedTool(0, 2), positionedTool(1, 3)]);
  assert.equal(
    assistantPresentationRows("text", {
      ...current,
      steps: current.steps.map(({ contentOffset: _offset, ...entry }) => entry),
    }),
    null,
  );
  assert.equal(
    assistantPresentationRows("text", {
      ...current,
      steps: [positionedTool(0, 3), positionedTool(1, 2)],
    }),
    null,
  );
  assert.equal(
    assistantPresentationRows("text", {
      ...current,
      steps: [positionedTool(0, 5)],
    }),
    null,
  );
});

test("the active prose segment keeps a stable key while streaming grows", () => {
  const positioned = timeline("running", [positionedTool(0, 7)]);
  const first = assistantPresentationRows("Before.A", positioned);
  const second = assistantPresentationRows("Before.A longer tail", positioned);
  assert.ok(first && second);
  assert.equal(first[first.length - 1]?.key, second[second.length - 1]?.key);
});

test("activity fragments keep only local claim checks and settle inactive live groups", () => {
  const first = positionedTool(0, 0);
  const second = {
    ...positionedTool(1, 0, "edit_file"),
    status: "failed" as const,
  };
  const source: GenerationTimeline = {
    ...timeline("running", [first, second]),
    claimCheck: { kind: "unverified_success", stepIds: [second.id] },
  };
  const firstFragment = activityTimelineFragment(source, [first]);
  const secondFragment = activityTimelineFragment(source, [second]);
  assert.equal(firstFragment.status, "completed");
  assert.equal(firstFragment.claimCheck, undefined);
  assert.deepEqual(secondFragment.claimCheck?.stepIds, [second.id]);
});

test("grep reads as a pattern scoped to a directory", () => {
  assert.equal(
    activityLineText(
      step("grep", 0, "grep", "completed", {
        detail: "export (function|const|class)",
        target: "services",
      }),
    ),
    "Grepped export (function|const|class) in services",
  );
});

test("a command shows the model's description, never the command", () => {
  assert.equal(
    activityLineText(
      step("run", 0, "run_command", "completed", { detail: "Count tests in the workspace" }),
    ),
    "Ran Count tests in the workspace",
  );
  assert.equal(activityLineText(step("bare", 1, "run_command", "completed")), "Ran");
});

test("terminal outcomes name the action and carry a tone", () => {
  assert.deepEqual(activityLine(step("cancel", 0, "run_command", "cancelled")), {
    verb: "run_command cancelled",
    object: undefined,
    tone: "warning",
  });
  assert.equal(activityLine(step("fail", 1, "edit_file", "failed")).tone, "error");
  assert.equal(activityLine(step("deny", 2, "write_file", "blocked")).tone, "warning");
  assert.equal(activityLine(step("ask", 3, "write_file", "awaiting_approval")).tone, "warning");
});

test("reasoning rows report measured time and stay active until they settle", () => {
  assert.equal(formatThinkingDuration(undefined), "briefly");
  assert.equal(formatThinkingDuration(900), "briefly");
  assert.equal(formatThinkingDuration(4_200), "for 4s");
  assert.equal(formatThinkingDuration(65_000), "for 1m 5s");
  assert.equal(formatThinkingDuration(120_000), "for 2m");

  assert.equal(activityLineText(thinking("think-1", 0, 4_200)), "Thought for 4s");
  assert.equal(activityLineText(thinking("think-1", 0)), "Thinking");
  assert.equal(isActiveStep(thinking("think-1", 0)), true);
  assert.equal(isActiveStep(thinking("think-1", 0, 100)), false);
});

test("summarizes a finished turn as one deterministic sentence", () => {
  assert.equal(
    summarizeActivity(
      timeline("completed", tools({ read_file: 8, grep: 3, glob: 1, run_command: 1 })),
    ),
    "Explored 8 files, 4 searches, ran 1 command",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ read_file: 1, list_dir: 2, edit_file: 3 }))),
    "Explored 1 file, 2 directories, edited 3 files",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ web_search: 2, computer_use: 1 }))),
    "2 web searches, 1 Mac action",
  );
});

test("summary leads with the work when nothing was explored", () => {
  assert.equal(summarizeActivity(timeline("completed", tools({ edit_file: 2 }))), "Edited 2 files");
  assert.equal(
    summarizeActivity(timeline("completed", tools({ run_command: 1 }))),
    "Ran 1 command",
  );
  assert.equal(
    activityLineText(step("compact", 0, "compact_context", "running")),
    "Compacting context",
  );
  assert.equal(
    summarizeActivity(timeline("completed", tools({ compact_context: 1 }))),
    "Compacted context",
  );
});

test("uncounted tools fall back to a neutral tool-call tally", () => {
  assert.equal(
    summarizeActivity(
      timeline("completed", tools({ read_file: 1, schedule_task: 1, notion__search: 1 })),
    ),
    "Explored 1 file, 2 tool calls",
  );
});

test("a live turn reads in the present tense", () => {
  assert.equal(
    summarizeActivity(timeline("running", tools({ read_file: 2, run_command: 1 }))),
    "Exploring 2 files, running 1 command",
  );
  assert.equal(summarizeActivity(timeline("running", [thinking("think-1", 0)])), "Thinking");
  assert.equal(
    summarizeActivity(timeline("completed", [thinking("think-1", 0, 3_000)])),
    "Thought for 3s",
  );
});

test("reasoning never inflates the tool tally", () => {
  const steps: AgentStep[] = [
    thinking("think-1", 0, 3_000),
    step("read", 1, "read_file"),
    thinking("think-2", 2, 1_000),
  ];
  assert.equal(summarizeActivity(timeline("completed", steps)), "Explored 1 file");
});

test("issues surface for review without reopening a healthy trail", () => {
  const clean = timeline("completed", tools({ read_file: 1 }));
  assert.equal(activityIssueCount(clean), 0);
  assert.equal(activityTrailNeedsAttention(clean), false);

  const failed = timeline("completed", [
    step("edit", 0, "edit_file", "failed"),
    step("run", 1, "run_command", "cancelled"),
  ]);
  assert.equal(activityIssueCount(failed), 2);
  assert.equal(activityTrailNeedsAttention(failed), true);
});

test("active thinking and named tool helpers match live timeline steps", () => {
  const liveThink = timeline("running", [thinking("think-1", 0)]);
  const doneThink = timeline("completed", [thinking("think-1", 0, 3_000)]);
  const rendering = timeline("running", [
    step("render", 0, "render_artifact", "running"),
  ]);
  assert.equal(hasActiveThinkingStep(liveThink), true);
  assert.equal(hasActiveThinkingStep(doneThink), false);
  assert.equal(hasActiveThinkingStep(null), false);
  assert.equal(hasActiveToolStep(rendering, "render_artifact"), true);
  assert.equal(hasActiveToolStep(rendering, "read_file"), false);
  assert.equal(isToolStep(rendering.steps[0]!), true);
});
