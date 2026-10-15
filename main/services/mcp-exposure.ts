// Applies a server's model exposure (renderer/shared/mcp-exposure.ts) to the
// agent tools built from its inventory. Hidden servers and tools are never
// built; "Always visible" servers stay declared in codemode turns.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mcpServerExposure, mcpToolsOfferedToModel, type McpExposure } from "../../renderer/shared/mcp-exposure.js";

export interface McpServerExposurePlan<T> {
  /** The inventory entries to build agent tools for. */
  readonly tools: readonly T[];
  /** Declare the server's tools even when codemode would defer them. */
  readonly alwaysDeclared: boolean;
}

/**
 * What of `inventory` the model may be offered, or `undefined` when the server
 * offers nothing at all: switched off for the model, or every listed tool is
 * hidden (its resource tool is then withheld too). A server that lists no
 * tools still offers its resources.
 */
export function planMcpServerExposure<T extends { readonly name: string }>(
  server: { exposure?: McpExposure; hiddenTools?: readonly string[] },
  inventory: readonly T[],
): McpServerExposurePlan<T> | undefined {
  const exposure = mcpServerExposure(server);
  if (exposure === "hidden") return undefined;
  const tools = mcpToolsOfferedToModel(server, inventory);
  if (inventory.length > 0 && tools.length === 0) return undefined;
  return { tools, alwaysDeclared: exposure === "direct" };
}

/**
 * Mark a built MCP tool as codemode-callable and discoverable under its
 * server's namespace record, and as always declared for a direct server.
 */
export function markMcpToolExposure<T extends AgentTool>(
  tool: T,
  discovery: object,
  plan: Pick<McpServerExposurePlan<unknown>, "alwaysDeclared">,
): T {
  return Object.assign(tool, { codemode: true, discovery, ...(plan.alwaysDeclared ? { alwaysDeclared: true } : {}) });
}
