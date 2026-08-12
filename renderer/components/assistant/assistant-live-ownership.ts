import type { AssistantChat } from "./use-assistant-chat";
import type { AssistantLiveController } from "./use-assistant-live";

/** One shared gate for every conversation-changing Assistant action. */
export function assistantThreadChangeBlockedReason(
  chat: AssistantChat,
  live: AssistantLiveController,
): string | null {
  if (live.busy) return "Wait for the current Live start or stop to finish.";
  if (live.setupOpen) return "Cancel Live setup before changing conversations.";
  if (live.computerUseBusy) return "Wait for the Computer Use setting change to finish.";
  if (chat.approvals.some((approval) => approval.toolName === "computer_use")) {
    return "Decide or stop the pending Live Computer Use action before changing conversations.";
  }
  if (live.active) return "Stop Live before changing conversations.";
  return null;
}
