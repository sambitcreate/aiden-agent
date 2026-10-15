import type { SubagentMcpRemoteTool } from "./subagents/subagent-mcp-read.js";

/**
 * The exact MCP tools/list entry an agent tool was built from, so callers that
 * hold narrower authority (Bot grants) can compare the executable tool's own
 * schema and effect facts instead of trusting its name.
 */
const descriptors = new WeakMap<object, SubagentMcpRemoteTool>();

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

export function tagMcpAgentTool<T extends object>(agentTool: T, remote: Parameters<typeof mcpRemoteToolDescriptor>[0]): T {
  descriptors.set(agentTool, mcpRemoteToolDescriptor(remote));
  return agentTool;
}

/** The tools/list entry this agent tool was built from, when it is an MCP tool. */
export function mcpAgentToolDescriptor(agentTool: object): SubagentMcpRemoteTool | undefined {
  return descriptors.get(agentTool);
}
