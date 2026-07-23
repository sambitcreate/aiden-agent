import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolStep } from "../shared/generation-timeline.js";
import { agentStepLabel, contextGroupLabel, groupAgentSteps } from "./agent-steps.js";

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
