import { isSubagentRole, type SubagentRole } from "./capability-profile.js";
import { sanitizeSubagentText } from "./safe-text.js";

export const MAX_SUBAGENT_TASKS_PER_CALL = 4;
export const MAX_SUBAGENT_LAUNCHES_PER_GENERATION = 8;
export const MAX_SUBAGENT_LABEL_CHARS = 120;
export const MAX_SUBAGENT_TASK_CHARS = 8_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = 8_000;
export const MAX_SUBAGENT_TOOL_RESULT_CHARS = 24_000;

export interface SubagentTaskRequest {
  role: SubagentRole;
  label: string;
  task: string;
}

export interface SubagentToolRequest {
  tasks: SubagentTaskRequest[];
}

export type SubagentTaskStatus = "completed" | "failed" | "timed_out" | "interrupted";

export interface SubagentTaskResult {
  role: SubagentRole;
  label: string;
  status: SubagentTaskStatus;
  summary: string;
  warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasDisallowedLabelCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

function boundedText(value: unknown, field: "label" | "task", maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Subagent ${field} must contain between 1 and ${maximum} characters.`);
  }
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Subagent ${field} must contain visible text without NUL characters.`);
  }
  if (field === "label" && hasDisallowedLabelCharacter(value)) {
    throw new Error("Subagent label must be a single line without control characters.");
  }
  return sanitizeSubagentText(value);
}

/** Revalidate model arguments independently of TypeBox/provider schema enforcement. */
export function parseSubagentToolRequest(input: unknown): SubagentToolRequest {
  if (!isRecord(input) || !hasExactKeys(input, ["tasks"]) || !Array.isArray(input.tasks)) {
    throw new Error("Invalid subagent request.");
  }
  if (input.tasks.length < 1 || input.tasks.length > MAX_SUBAGENT_TASKS_PER_CALL) {
    throw new Error(`A subagent request must contain 1 to ${MAX_SUBAGENT_TASKS_PER_CALL} tasks.`);
  }
  return {
    tasks: input.tasks.map((entry) => {
      if (!isRecord(entry) || !hasExactKeys(entry, ["role", "label", "task"])) {
        throw new Error("Invalid subagent task fields.");
      }
      if (typeof entry.role !== "string" || !isSubagentRole(entry.role)) {
        throw new Error("Unknown subagent role.");
      }
      return {
        role: entry.role,
        label: boundedText(entry.label, "label", MAX_SUBAGENT_LABEL_CHARS),
        task: boundedText(entry.task, "task", MAX_SUBAGENT_TASK_CHARS),
      };
    }),
  };
}
