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
