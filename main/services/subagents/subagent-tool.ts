import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  MAX_SUBAGENT_LABEL_CHARS,
  MAX_SUBAGENT_TASK_CHARS,
  MAX_SUBAGENT_TASKS_PER_CALL,
} from "./contracts.js";
import type { SubagentSupervisor } from "./subagent-supervisor.js";
import { SUBAGENT_PARENT_SECURITY_GUIDANCE } from "./role-catalog.js";

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

export function createSubagentTool(supervisor: SubagentSupervisor): AgentTool {
  return {
    name: "subagent",
    label: "Delegate to Subagents",
    description: `Delegate 1–4 independent, bounded read-only investigations to fresh scout, planner, or reviewer agents. Use for parallel evidence gathering, comparison, planning, or fresh review—not trivial work. You must reconcile their ordered results and write the final synthesis. ${SUBAGENT_PARENT_SECURITY_GUIDANCE}`,
    parameters: Type.Object(
      {
        tasks: Type.Array(
          Type.Object(
            {
              role: Type.Union([
                Type.Literal("scout"),
                Type.Literal("planner"),
                Type.Literal("reviewer"),
              ]),
              label: Type.String({
                minLength: 1,
                maxLength: MAX_SUBAGENT_LABEL_CHARS,
                description: "Short user-facing label for this delegated task.",
              }),
              task: Type.String({
                minLength: 1,
                maxLength: MAX_SUBAGENT_TASK_CHARS,
                description: "One self-contained investigation for the child.",
              }),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            maxItems: MAX_SUBAGENT_TASKS_PER_CALL,
          },
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) =>
      textResult(await supervisor.execute(params, signal)),
  };
}
