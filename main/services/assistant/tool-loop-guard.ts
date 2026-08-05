import type { AgentContext } from "@earendil-works/pi-agent-core";

export const MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS = 2;
export const ATTENDED_TOOL_FAILURE_RECOVERY_REPLY =
  "I couldn't complete that action after two tool attempts. Review the requested details and try again.";

export function attendedToolRecoveryMessage(): string {
  return [
    "[Aiden host guard] Two consecutive tool attempts failed. Do not call or imitate any tool",
    `again in this response. Reply with exactly this text and nothing else: "${ATTENDED_TOOL_FAILURE_RECOVERY_REPLY}"`,
  ].join(" ");
}

export interface AttendedToolErrorState {
  consecutiveErrorTurns: number;
  shouldStop: boolean;
}

/**
 * Bounds an attended Assistant generation when a model keeps retrying malformed
 * or rejected tool calls. One correction turn is allowed; a second consecutive
 * error ends the loop before it can spam the dock or consume tokens forever.
 */
export function advanceAttendedToolErrorState(
  current: number,
  toolResults: readonly { isError?: boolean }[],
): AttendedToolErrorState {
  if (!toolResults.some((result) => result.isError === true)) {
    return { consecutiveErrorTurns: 0, shouldStop: false };
  }
  const consecutiveErrorTurns = current + 1;
  return {
    consecutiveErrorTurns,
    shouldStop: consecutiveErrorTurns >= MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
  };
}

/**
 * Converts a repeated tool failure into one final text-only turn. Removing
 * every tool matters: some OpenAI-compatible local providers ignore a tool
 * error and emit the same invalid call again even when the system prompt
 * explicitly forbids it.
 */
export function recoverAttendedToolErrorContext(
  context: AgentContext,
  timestamp: number = Date.now(),
): AgentContext {
  return {
    ...context,
    messages: [
      ...context.messages,
      {
        role: "user",
        content: attendedToolRecoveryMessage(),
        timestamp,
      },
    ],
    tools: [],
  };
}
