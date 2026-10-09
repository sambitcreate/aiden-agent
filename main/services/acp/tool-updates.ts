import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type { AcpToolCallState } from "./activity.js";

/** Diff and rawInput chunks merge in memory, but do not warrant activity work. */
export function shouldReportToolUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
  reportedStatus: ToolCallStatus | null | undefined,
  skipped: number,
): boolean {
  if (!previous || reportedStatus === "completed" || reportedStatus === "failed" ||
      previous.status !== next.status || previous.title !== next.title ||
      previous.detail !== next.detail || previous.kind !== next.kind ||
      previous.mcp !== next.mcp || previous.subagent !== next.subagent ||
      skipped + 1 >= 10) return true;

  return previous.textOutput !== next.textOutput || previous.rawOutput !== next.rawOutput;
}
