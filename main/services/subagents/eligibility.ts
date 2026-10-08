export interface SubagentEligibilityInput {
  assistantMode: boolean;
  /** The parent's provider; children inherit it. */
  providerId?: string;
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
    // Agent harnesses have their own subagents and cannot run unattended children.
    !(input.providerId && isAcpHarnessProvider(input.providerId)) &&
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
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";
