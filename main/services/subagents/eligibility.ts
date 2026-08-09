export interface SubagentEligibilityInput {
  assistantMode: boolean;
  allowSubagents?: boolean;
  usageSource?: string;
  excludedToolNames?: ReadonlySet<string>;
  workspaceId?: string;
  folderPath?: string;
  permission: string;
}

/** Delegation is a foreground capability bound to one persisted workspace. */
export function subagentsAllowedForGeneration(input: SubagentEligibilityInput): boolean {
  return (
    !input.assistantMode &&
    input.allowSubagents === true &&
    input.usageSource === "chat" &&
    !input.excludedToolNames?.has("subagent") &&
    Boolean(input.workspaceId && input.folderPath) &&
    input.permission !== "none"
  );
}

export interface SubagentWorkspaceWriteEligibilityInput {
  subagentsAllowed: boolean;
  childWriteRollout: boolean;
  v2StoreSelected: boolean;
  workspacePermission?: WorkspacePermission;
  generationPermission: WorkspacePermission | "read-only";
}

/** A parent generation ceiling can narrow, but never widen, stored workspace authority. */
export function subagentWorkspaceWriteAllowedForGeneration(
  input: SubagentWorkspaceWriteEligibilityInput,
): boolean {
  return (
    input.subagentsAllowed &&
    input.childWriteRollout &&
    input.v2StoreSelected &&
    (input.workspacePermission === "ask" || input.workspacePermission === "full") &&
    (input.generationPermission === "ask" || input.generationPermission === "full")
  );
}
import type { WorkspacePermission } from "../types.js";
