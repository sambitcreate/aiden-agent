import type { AgentContext } from "@earendil-works/pi-agent-core";

export const MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS = 2;
export const NO_ENABLED_MCP_RECOVERY_REPLY =
  "No automation was created. I couldn't verify an enabled MCP server for this request. Connect or enable the intended server in Settings → MCP Servers, then try again.";
export const UNVERIFIED_TARGET_RECOVERY_REPLY =
  "No automation was created because the project or MCP server in the proposal could not be verified. Select the exact available target and try again.";

export function attendedToolRecoveryMessage(hasEnabledMcpServers: boolean): string {
  const reply = hasEnabledMcpServers
    ? UNVERIFIED_TARGET_RECOVERY_REPLY
    : NO_ENABLED_MCP_RECOVERY_REPLY;
  return [
    "[Aiden host guard] Two consecutive tool attempts failed. Do not call or imitate any tool",
    `again in this response. Reply with exactly this text and nothing else: "${reply}"`,
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
  hasEnabledMcpServers: boolean,
  timestamp: number = Date.now(),
): AgentContext {
  return {
    ...context,
    messages: [
      ...context.messages,
      {
        role: "user",
        content: attendedToolRecoveryMessage(hasEnabledMcpServers),
        timestamp,
      },
    ],
    tools: [],
  };
}
