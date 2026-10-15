import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createPiCodemodeTool } from "./pi-codemode.js";
import { createPiToolDiscovery } from "./pi-tool-discovery.js";
import { isPiCodemodeCallable } from "./pi-runtime-tool.js";

/** Declared MCP tools counted in a passive estimate, at most. */
export const MAX_AMBIENT_MCP_TOOLS = 512;

let lane: AgentTool[] | undefined;
/** The codemode and tool_search declarations a workspace turn adds; never executed. */
function codemodeLaneTools(): AgentTool[] {
  return lane ??= [
    createPiCodemodeTool({ tools: () => [], executeTool: async () => { throw new Error("Estimate only."); } }),
    createPiToolDiscovery({ tools: () => [], isCallable: isPiCodemodeCallable }).toolSearch,
  ];
}

/**
 * Tool declarations a desktop turn adds beyond the static tool set, for the
 * context meter before any generation ran. Codemode turns declare `codemode`
 * and `tool_search` and defer MCP tools behind them; other turns declare the
 * MCP tools directly. `mcpTools` are tools already built in this process (the
 * estimate never connects), capped at {@link MAX_AMBIENT_MCP_TOOLS}.
 */
export function ambientRuntimeToolEstimate(input: { codemode: boolean; mcpTools: readonly AgentTool[] }): AgentTool[] {
  if (input.codemode) return [...codemodeLaneTools()];
  return input.mcpTools.slice(0, MAX_AMBIENT_MCP_TOOLS);
}
