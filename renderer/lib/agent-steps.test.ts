import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentStep,
  AgentThinkingStep,
  AgentToolStep,
  GenerationTimeline,
} from "../shared/generation-timeline.js";
import {
  activityIssueCount,
  activityLine,
  activityLineText,
  activityTrailNeedsAttention,
  formatThinkingDuration,
  isActiveStep,
  summarizeActivity,
} from "./agent-steps.js";

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
    version: 2,
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

test("splits a row into a verb and the object it acted on", () => {
  assert.deepEqual(activityLine(step("read", 0, "read_file", "completed", { target: "src/app.ts" })), {
    verb: "Read",
    object: "src/app.ts",
    tone: "normal",
  });
  assert.deepEqual(activityLine(step("glob", 1, "glob", "running", { detail: "src/**/*.ts" })), {
    verb: "Searching files",
    object: "src/**/*.ts",
    tone: "normal",
  });
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
    summarizeActivity(timeline("completed", tools({ read_file: 8, grep: 3, glob: 1, run_command: 1 }))),
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
  assert.equal(summarizeActivity(timeline("completed", tools({ run_command: 1 }))), "Ran 1 command");
});

test("uncounted tools fall back to a neutral tool-call tally", () => {
  assert.equal(
    summarizeActivity(timeline("completed", tools({ read_file: 1, schedule_task: 1, notion__search: 1 }))),
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
