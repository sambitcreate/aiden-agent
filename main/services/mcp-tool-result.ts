import type { AgentToolResult } from "@earendil-works/pi-agent-core";

function toText(result: unknown): string {
  const candidate = result as {
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(candidate?.content)) {
    const text = candidate.content
      .map((content) => (content.type === "text" ? content.text : undefined))
      .filter((value): value is string => Boolean(value))
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(result) || "MCP tool returned no result.";
}

/**
 * Preserve MCP's resolved `isError` outcome as a thrown tool failure so Pi,
 * Activity, and claim checking all observe the same terminal state.
 */
export function mcpAgentToolResult(result: unknown): AgentToolResult<null> {
  const text = toText(result);
  if ((result as { isError?: unknown } | null)?.isError === true) {
    throw new Error(text);
  }
  return { content: [{ type: "text", text }], details: null };
}

export async function executeMcpAgentTool(
  callTool: () => Promise<unknown>,
): Promise<AgentToolResult<null>> {
  return mcpAgentToolResult(await callTool());
}
