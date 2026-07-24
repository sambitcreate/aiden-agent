import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline.js";
import {
  activityTrailNeedsAttention,
  activityTrailSummary,
  agentStepLabel,
  contextGroupLabel,
  groupAgentSteps,
} from "./agent-steps.js";

function step(
  id: string,
  order: number,
  toolName: string,
  status: AgentToolStep["status"] = "completed",
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
  };
}

function timeline(
  status: GenerationTimeline["status"],
  steps: AgentToolStep[],
): GenerationTimeline {
  return {
    version: 1,
    generationId: "generation-1",
    status,
    startedAt: 1,
    ...(status === "running" ? {} : { finishedAt: 2 }),
    steps,
  };
}

test("groups only adjacent discovery work and preserves source order", () => {
  const groups = groupAgentSteps([
    step("read", 0, "read_file"),
    step("search", 1, "grep"),
    step("edit", 2, "edit_file"),
    step("list", 3, "list_dir"),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.kind, group.steps.map((item) => item.id)]),
    [
      ["context", ["read", "search"]],
      ["tool", ["edit"]],
      ["context", ["list"]],
    ],
  );
});

test("uses compact active and terminal language", () => {
  assert.equal(
    agentStepLabel({ ...step("read", 0, "read_file", "running"), target: "src/app.ts" }),
    "Reading file · src/app.ts",
  );
  assert.equal(
    agentStepLabel({ ...step("edit", 1, "edit_file", "completed"), target: "src/app.ts" }),
    "Edited file · src/app.ts",
  );
  assert.equal(agentStepLabel(step("command", 2, "run_command", "failed")), "run_command failed");
});

test("summarizes grouped discovery counts without verbose logs", () => {
  assert.equal(
    contextGroupLabel([
      step("read-a", 0, "read_file"),
      step("read-b", 1, "read_file"),
      step("search", 2, "grep", "running"),
    ]),
    "Gathering context · 2 files, 1 search",
  );
});

test("summarizes activity and opens only for live or attention states", () => {
  const completed = timeline("completed", [step("edit", 0, "edit_file")]);
  assert.equal(activityTrailSummary(completed), "1 step");
  assert.equal(activityTrailNeedsAttention(completed), false);

  const running = timeline("running", [step("edit", 0, "edit_file", "running")]);
  assert.equal(activityTrailSummary(running), "Working");
  assert.equal(activityTrailNeedsAttention(running), true);

  const failed = timeline("completed", [step("edit", 0, "edit_file", "failed")]);
  assert.equal(activityTrailSummary(failed), "1 issue");
  assert.equal(activityTrailNeedsAttention(failed), true);
});

test("activity uses a native keyboard disclosure and an alert-only claim warning", () => {
  const source = readFileSync(new URL("../components/agent-steps.tsx", import.meta.url), "utf8");
  assert.match(source, /<details/u);
  assert.match(source, /<summary/u);
  assert.match(source, /focus-visible:ring-focus-ring/u);
  assert.match(source, /Success not verified/u);
  assert.match(source, /role=\{animate \? "alert" : "note"\}/u);
  assert.match(source, /role="list">[\s\S]*?<\/div>\s*\{visible\.claimCheck/u);
});
