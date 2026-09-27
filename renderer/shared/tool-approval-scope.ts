/**
 * Tool approval scopes shared by the Electron main process, the desktop
 * approval card, and the Aiden Remote wire contract.
 *
 * - `once`: the default; authorizes only the exact tool call on the card.
 * - `chat`: also auto-approves the same tool with the same normalized target
 *   (exact command or exact workspace-relative path) for the rest of this chat
 *   while the app stays open.
 * - `always`: persists that same narrow rule for the workspace until the user
 *   revokes it from Settings → Tool approvals.
 */
export const TOOL_APPROVAL_SCOPES = ["once", "chat", "always"] as const;

export type ToolApprovalScope = (typeof TOOL_APPROVAL_SCOPES)[number];

export function parseToolApprovalScope(value: unknown): ToolApprovalScope | undefined {
  return value === "once" || value === "chat" || value === "always" ? value : undefined;
}

/** Tools whose calls can be remembered by an approval rule. */
export type ScopedApprovalToolName = "run_command" | "write_file" | "edit_file";

export function isScopedApprovalToolName(value: unknown): value is ScopedApprovalToolName {
  return value === "run_command" || value === "write_file" || value === "edit_file";
}

/** A persisted "always allow" rule, as listed in Settings. */
export interface ToolApprovalRuleView {
  id: string;
  toolName: ScopedApprovalToolName;
  /** Exact trimmed command for run_command; normalized relative path otherwise. */
  pattern: string;
  workspaceId: string;
  /** Workspace display name captured when the rule was created. */
  workspaceLabel?: string;
  createdAt: string;
}

/** Short user-facing description of what a remembered rule covers. */
export function describeToolApprovalRule(
  rule: Pick<ToolApprovalRuleView, "toolName" | "pattern">,
): string {
  switch (rule.toolName) {
    case "run_command":
      return `Run exactly: ${rule.pattern}`;
    case "write_file":
      return `Create or replace ${rule.pattern}`;
    case "edit_file":
      return `Edit ${rule.pattern}`;
  }
}

/**
 * The broader-than-once scopes an approval card may offer, in canonical order.
 * Unknown names are ignored, and nothing is offered unless the approval can be
 * allowed at all.
 */
export function rememberableApprovalScopes(
  scopes: readonly unknown[] | undefined,
  canAllow: boolean,
): Exclude<ToolApprovalScope, "once">[] {
  if (!canAllow || !scopes) return [];
  const offered = new Set(scopes.map(parseToolApprovalScope));
  return (["chat", "always"] as const).filter((scope) => offered.has(scope));
}

export function toolApprovalScopeLabel(scope: ToolApprovalScope): string {
  switch (scope) {
    case "once":
      return "Allow once";
    case "chat":
      return "Allow for this chat";
    case "always":
      return "Always allow";
  }
}
