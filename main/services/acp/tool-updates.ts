import type { ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { AcpToolCallState } from "./activity.js";

function contentTexts(content: readonly ToolCallContent[] | null | undefined): string[] {
  return (content ?? []).flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  );
}

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

  const before = contentTexts(previous.content);
  const after = contentTexts(next.content);
  if (before.length !== after.length || before.some((text, index) => text !== after[index])) return true;
  return previous.rawOutput !== next.rawOutput &&
    JSON.stringify(previous.rawOutput) !== JSON.stringify(next.rawOutput);
}
