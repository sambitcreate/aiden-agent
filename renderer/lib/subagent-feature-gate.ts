import type { ChatMessage } from "./types";
import type { SubagentReferenceMessage } from "./subagent-view-state";

export function visibleSubagentReferences(
  messages: readonly ChatMessage[],
  subagentsEnabled: boolean,
): SubagentReferenceMessage[] {
  if (!subagentsEnabled) return [];
  return messages.flatMap((message) =>
    message.role === "assistant" && message.subagents
      ? [
          {
            id: message.id,
            createdAt: message.createdAt,
            subagents: message.subagents,
          },
        ]
      : [],
  );
}
