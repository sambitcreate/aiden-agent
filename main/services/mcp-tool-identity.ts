import { createHash } from "node:crypto";
import type { McpServer } from "./types.js";

const MCP_AGENT_TOOL_NAME_LIMIT = 64;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
}

/** Bind dispatch identity to the stable server ID and the raw remote tool name. */
export function mcpAgentToolName(server: Pick<McpServer, "id" | "name">, toolName: string): string {
  const digest = createHash("sha256")
    .update(server.id)
    .update("\0")
    .update(toolName)
    .digest("hex")
    .slice(0, 12);
  const suffix = `_${digest}`;
  const readable = `${sanitize(server.name || server.id)}__${sanitize(toolName)}`;
  return `${readable.slice(0, MCP_AGENT_TOOL_NAME_LIMIT - suffix.length)}${suffix}`;
}

export function assertUniqueMcpAgentToolNames(tools: readonly { name: string }[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`MCP tool identity collision for "${tool.name}".`);
    }
    seen.add(tool.name);
  }
}
