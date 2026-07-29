import {
  DEFAULT_CHAT_WORKSPACE_ID,
  persistedChatWorkspaceId,
} from "../../renderer/shared/chat-workspace.js";

export { persistedChatWorkspaceId };

/**
 * Bind a generation to the workspace persisted on its chat. Renderer input is
 * only a stale-request guard and can never select a different capability root.
 */
export function authoritativeChatWorkspaceId(
  persistedWorkspaceId: string | undefined,
  requestedWorkspaceId: string | undefined,
): string {
  const authoritative = persistedChatWorkspaceId(persistedWorkspaceId);
  if ((requestedWorkspaceId ?? DEFAULT_CHAT_WORKSPACE_ID) !== authoritative) {
    throw new Error("This chat belongs to a different workspace.");
  }
  return authoritative;
}

interface PersistedSubagentMessage {
  role: string;
  subagents?: {
    generationId: string;
    runIds: readonly string[];
    version: number;
  };
}

/** Historical child state is visible only through its exact persisted assistant-message reference. */
export function persistedChatReferencesSubagentRun(
  messages: readonly PersistedSubagentMessage[],
  runId: string,
  generationId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.subagents?.version === 1 &&
      message.subagents.generationId === generationId &&
      message.subagents.runIds.includes(runId),
  );
}
