// Wires the main-process sources (settings, MCP, web search, skill registry)
// into the pure tool assembly in `agent-tool-assembly.ts`.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { configStore } from "./config-store.js";
import { collectMcpAgentTools } from "./mcp.js";
import { skillRegistry } from "./skill-registry-main.js";
import { selectedMcpServers } from "./mcp-selection.js";
import { withoutWorkspaceDisabledMcpServers } from "./workspace-capabilities.js";
import { assertScheduledMcpServerBindings } from "./schedule-mcp-binding.js";
import { webSearchService } from "./web-search-main.js";
import { assembleAgentTools, type AgentToolSources, type ToolContext } from "./agent-tool-assembly.js";

export { skillToolKey } from "./skill-registry-core.js";
export { buildSchedulingTools, type ToolContext } from "./agent-tool-assembly.js";

async function configuredMcpTools(ctx: ToolContext): Promise<AgentTool[]> {
  const servers =
    ctx.mcpServerIds === undefined
      ? withoutWorkspaceDisabledMcpServers(
          selectedMcpServers(await configStore.listMcpServers(), undefined),
          ctx.disabledMcpServerIds,
        )
      : selectedMcpServers(await configStore.listMcpServers(), ctx.mcpServerIds);
  if (ctx.mcpServerBindings) assertScheduledMcpServerBindings(servers, ctx.mcpServerBindings);
  return collectMcpAgentTools(servers, {
    strict: ctx.mcpServerIds !== undefined,
    allowProviderAuth: ctx.allowMcpProviderAuth === true,
    providerScope: ctx.mcpProviderScope,
    deferral: ctx.mcpDeferral,
  });
}

const mainAgentToolSources: AgentToolSources = {
  configuredMcpTools,
  webSearchToolForGeneration: () => webSearchService.toolForGeneration(),
  skillsEnabled: async () => (await configStore.getSettings()).skillsEnabled !== false,
  skillSnapshot: (workspaceId) => skillRegistry.snapshot(workspaceId),
};

export async function buildAgentTools(ctx: ToolContext): Promise<AgentTool[]> {
  return assembleAgentTools(ctx, mainAgentToolSources);
}
