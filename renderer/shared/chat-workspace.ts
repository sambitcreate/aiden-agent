export const DEFAULT_CHAT_WORKSPACE_ID = "default";

/** Normalize chat records written before explicit workspace ownership existed. */
export function persistedChatWorkspaceId(workspaceId: string | undefined): string {
  return workspaceId ?? DEFAULT_CHAT_WORKSPACE_ID;
}
