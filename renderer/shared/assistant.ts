// Shared between main and every renderer: the reserved workspace id that keeps
// assistant threads out of the main window's sidebar. The sidebar always lists
// chats filtered by the active workspace, and workspace ids are main-generated,
// so a reserved literal is sufficient isolation.
export const ASSISTANT_WORKSPACE_ID = "assistant";
export const ASSISTANT_AUTOMATION_TOOL_NAME = "schedule_task";
export const ASSISTANT_AUTOMATION_EDIT_TOOL_NAME = "edit_automation";
export const ASSISTANT_AUTOMATION_NAME_LIMIT = 120;
export const ASSISTANT_AUTOMATION_PROMPT_LIMIT = 32 * 1024;
export const ASSISTANT_AUTOMATION_CRON_LIMIT = 256;
export const ASSISTANT_AUTOMATION_TIMEZONE_LIMIT = 128;
export const ASSISTANT_AUTOMATION_TASK_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT = 120;
export const ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT = 16;
export const ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT = 160;
export const ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT = 120;

/** The exact automation proposal shown before an attended Assistant tool call resumes. */
export interface AssistantAutomationApprovalDetails {
  kind: "assistant-automation";
  action: "create" | "edit";
  /** Present only when changing an existing saved automation. */
  taskId?: string;
  /** Present on edits so a paused task is not described as having an active next run. */
  enabled?: boolean;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  nextRunAt: number;
  notify: boolean;
  mode: "llm";
  permission: "read-only" | "full";
  workspaceId: string | null;
  workspaceName: string | null;
  mcpServerIds: string[];
  mcpServerNames: string[];
  schedulerEnabled: boolean;
}

export type ToolApprovalDetails = AssistantAutomationApprovalDetails;

function safeApprovalText(value: unknown, limit: number, multiline = false): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedWhitespace =
      multiline && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d);
    const unsafeControl =
      (!allowedWhitespace && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (unsafeControl) return false;
  }
  return true;
}

/** Fail-closed renderer boundary for the only approval Aiden may present. */
export function isAssistantAutomationApprovalDetails(
  value: unknown,
): value is AssistantAutomationApprovalDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  const actionIsValid =
    details.action === "create"
      ? details.taskId === undefined && details.enabled === undefined
      : details.action === "edit" &&
        safeApprovalText(details.taskId, ASSISTANT_AUTOMATION_TASK_ID_LIMIT) &&
        typeof details.enabled === "boolean";
  const projectIsValid =
    (details.workspaceId === null && details.workspaceName === null) ||
    (safeApprovalText(details.workspaceId, ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT) &&
      safeApprovalText(details.workspaceName, ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT));
  const mcpServerIds = Array.isArray(details.mcpServerIds) ? details.mcpServerIds : [];
  const mcpServerNames = Array.isArray(details.mcpServerNames) ? details.mcpServerNames : [];
  const mcpServersAreValid =
    Array.isArray(details.mcpServerIds) &&
    Array.isArray(details.mcpServerNames) &&
    mcpServerIds.length <= ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT &&
    mcpServerIds.length === mcpServerNames.length &&
    new Set(mcpServerIds).size === mcpServerIds.length &&
    mcpServerIds.every((id) => safeApprovalText(id, ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT)) &&
    mcpServerNames.every((name) =>
      safeApprovalText(name, ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT),
    );
  return (
    details.kind === "assistant-automation" &&
    actionIsValid &&
    safeApprovalText(details.name, ASSISTANT_AUTOMATION_NAME_LIMIT) &&
    safeApprovalText(details.prompt, ASSISTANT_AUTOMATION_PROMPT_LIMIT, true) &&
    safeApprovalText(details.cron, ASSISTANT_AUTOMATION_CRON_LIMIT) &&
    safeApprovalText(details.timezone, ASSISTANT_AUTOMATION_TIMEZONE_LIMIT) &&
    typeof details.nextRunAt === "number" &&
    Number.isFinite(details.nextRunAt) &&
    details.nextRunAt >= 0 &&
    typeof details.notify === "boolean" &&
    details.mode === "llm" &&
    (details.permission === "read-only" || details.permission === "full") &&
    projectIsValid &&
    mcpServersAreValid &&
    (mcpServerIds.length === 0 || details.permission === "full") &&
    (details.permission !== "full" || details.workspaceId !== null || mcpServerIds.length > 0) &&
    typeof details.schedulerEnabled === "boolean"
  );
}

/**
 * Prompts offered in Aiden's empty state.
 *
 * Deliberately limited to questions Aiden can answer from what it knows about
 * the app. The live-state questions this feature is ultimately for — "Any
 * uncommitted changes?", "Summarize my settings" — need the get_settings and
 * list_projects tools, and offering them before those tools exist just invites
 * a confident wrong answer. Restore them with the tools.
 */
export const ASSISTANT_SUGGESTED_PROMPTS = [
  "What can you help me with?",
  "How do scheduled tasks work?",
  "Where do I add a provider?",
] as const;
