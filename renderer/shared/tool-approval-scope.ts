/**
 * Tool approval scopes shared by the Electron main process, the desktop
 * approval card, and the Aiden Remote wire contract.
 *
 * - `once`: the default; authorizes only the exact tool call on the card.
 * - `chat`: also auto-approves the same tool with the same normalized target
 *   (exact command or exact workspace-relative path) for the rest of this chat
 *   while the app stays open.
 * - `always`: persists that same narrow rule for the workspace until the user
 *   revokes it from Settings → Bots & Approvals → Approvals.
 * - `workspace`: a Mac card's "Allow in this workspace" under an approval
 *   mode: that part of the Mac (commands, file changes) in this workspace,
 *   removable in Workspace settings. Desktop only; the Remote projection
 *   never offers it to phones.
 */
export const TOOL_APPROVAL_SCOPES = ["once", "chat", "always", "workspace"] as const;

export type ToolApprovalScope = (typeof TOOL_APPROVAL_SCOPES)[number];

export function parseToolApprovalScope(value: unknown): ToolApprovalScope | undefined {
  return value === "once" || value === "chat" || value === "always" || value === "workspace" ? value : undefined;
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
  return (["chat", "always", "workspace"] as const).filter((scope) => offered.has(scope));
}

export function toolApprovalScopeLabel(scope: ToolApprovalScope): string {
  switch (scope) {
    case "once":
      return "Allow once";
    case "chat":
      return "Allow in this chat";
    case "always":
      return "Allow in this workspace";
    case "workspace":
      return "Allow in this workspace";
  }
}

export type BotApprovalSiteAction = "click" | "type" | "press";
export type BotApprovalRuleTarget =
  | { kind: "connection"; serverId: string; tool: string }
  | { kind: "site"; host: string; action: BotApprovalSiteAction };

export interface BotApprovalRuleView {
  id: string;
  botId: string;
  target: BotApprovalRuleTarget;
  label: string;
  createdAt: string;
  uses: number;
  lastUsedAt?: string;
}

export const BOT_APPROVAL_RULES_PER_BOT_MAX = 50;

export function botApprovalRuleKey(target: BotApprovalRuleTarget): string {
  return target.kind === "connection"
    ? JSON.stringify(["connection", target.serverId, target.tool])
    : JSON.stringify(["site", target.host, target.action]);
}

export function describeBotApprovalRule(rule: Pick<BotApprovalRuleView, "target" | "label">): string {
  if (rule.target.kind === "connection") return rule.label;
  const verb = { click: "Click", type: "Type", press: "Press keys" }[rule.target.action];
  return `${verb} on ${rule.target.host}`;
}

export function botAlwaysAllowLabel(botName: string): string {
  return `Always allow for ${botName}`;
}

export type BotAllowedEntry =
  | { kind: "rule"; id: string; botId: string; what: string; createdAt: string; uses: number; lastUsedAt?: string }
  | { kind: "folder"; id: string; botId: string; what: string; createdAt: string };
