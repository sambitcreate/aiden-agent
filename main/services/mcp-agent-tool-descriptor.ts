import type { SubagentMcpRemoteTool } from "./subagents/subagent-mcp-read.js";

/**
 * The exact MCP tools/list entry an agent tool was built from, so callers that
 * hold narrower authority (Bot grants) can compare the executable tool's own
 * schema and effect facts instead of trusting its name.
 */
const MCP_TOOL_DESCRIPTOR = Symbol.for("aiden.mcpAgentToolDescriptor");

/** The authority-relevant projection of one tools/list entry. */
export function mcpRemoteToolDescriptor(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
}): SubagentMcpRemoteTool {
  const { name, description, inputSchema, outputSchema, annotations, execution } = tool;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(execution === undefined ? {} : { execution }),
  };
}

/** Attach the tools/list entry to a built MCP agent tool (survives object spread, like its identity). */
export function tagMcpAgentTool<T extends object>(agentTool: T, remote: Parameters<typeof mcpRemoteToolDescriptor>[0]): T {
  return Object.assign(agentTool, { [MCP_TOOL_DESCRIPTOR]: Object.freeze(mcpRemoteToolDescriptor(remote)) });
}

/** The tools/list entry this agent tool was built from, when it is an MCP tool. */
export function mcpAgentToolDescriptor(agentTool: object): SubagentMcpRemoteTool | undefined {
  return (agentTool as { [MCP_TOOL_DESCRIPTOR]?: SubagentMcpRemoteTool })[MCP_TOOL_DESCRIPTOR];
}
