import {
  DEFAULT_CHAT_WORKSPACE_ID,
  persistedChatWorkspaceId,
} from "../../renderer/shared/chat-workspace.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import type { ChatStartParams } from "./types.js";

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

/**
 * Attended Assistant authority comes from the persisted chat, never from a
 * renderer-selected mode flag. Main-only background modes remain explicit
 * because their capability profile is created by the scheduler, not IPC.
 */
export function authoritativeChatGenerationMode(
  persistedWorkspaceId: string | undefined,
  requestedMode: ChatStartParams["mode"],
): ChatStartParams["mode"] {
  if (
    requestedMode === "assistant-unattended" ||
    requestedMode === "assistant-automation"
  ) {
    return requestedMode;
  }
  const isAssistantChat =
    persistedChatWorkspaceId(persistedWorkspaceId) === ASSISTANT_WORKSPACE_ID;
  if (isAssistantChat) return "assistant";
  if (requestedMode === "assistant") {
    throw new Error("This chat is not an Aiden Assistant chat.");
  }
  return undefined;
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
