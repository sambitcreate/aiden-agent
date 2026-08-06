import type { SubagentCapabilitySetV2, SubagentMcpScopeV2 } from "./authority-v2.js";
import { MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE } from "./authority-v2.js";
import type { SubagentRequestedCapabilities, SubagentRequestedMcpScope } from "./contracts.js";

export interface SubagentRequestableMcpInventoryV2 {
  serverId: string;
  tools: string[];
}

export const MAX_SUBAGENT_MODEL_MCP_TOOLS = 64;
export const MAX_SUBAGENT_MODEL_MCP_NAME_BYTES = 4_096;

/** Deterministic ceiling shared by exact authority availability and model projection. */
function boundSubagentMcpInventoryByEffectV2(
  scopes: readonly SubagentMcpScopeV2[],
  effect: "read" | "mutating",
): SubagentMcpScopeV2[] {
  let totalTools = 0;
  let totalNameBytes = 0;
  const bounded: SubagentMcpScopeV2[] = [];
  for (const scope of [...scopes].sort((a, b) => a.serverId.localeCompare(b.serverId))) {
    const serverBytes = Buffer.byteLength(scope.serverId, "utf8");
    const tools = [];
    for (const tool of [...scope.tools]
      .filter((candidate) => candidate.effect === effect)
      .sort((a, b) => a.toolName.localeCompare(b.toolName))) {
      if (
        tools.length >= MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE ||
        totalTools >= MAX_SUBAGENT_MODEL_MCP_TOOLS
      ) {
        break;
      }
      const nameBytes = Buffer.byteLength(tool.toolName, "utf8");
      const serverCost = tools.length === 0 ? serverBytes : 0;
      if (totalNameBytes + serverCost + nameBytes > MAX_SUBAGENT_MODEL_MCP_NAME_BYTES) {
        continue;
      }
      totalNameBytes += serverCost + nameBytes;
      totalTools += 1;
      tools.push({ ...tool });
    }
    if (tools.length > 0) {
      bounded.push({
        serverId: scope.serverId,
        connectionFingerprint: scope.connectionFingerprint,
        tools,
      });
    }
    if (totalTools >= MAX_SUBAGENT_MODEL_MCP_TOOLS) break;
  }
  return bounded;
}

/** Deterministic ceiling shared by exact read authority availability and model projection. */
export function boundSubagentMcpInventoryV2(
  scopes: readonly SubagentMcpScopeV2[],
): SubagentMcpScopeV2[] {
  return boundSubagentMcpInventoryByEffectV2(scopes, "read");
}

/** Safe model projection. Fingerprints, schema hashes, effects, and credentials stay in main. */
export function projectRequestableSubagentMcpInventoryV2(
  scopes: readonly SubagentMcpScopeV2[],
): SubagentRequestableMcpInventoryV2[] {
  return boundSubagentMcpInventoryV2(scopes)
    .map((scope) => ({
      serverId: scope.serverId,
      tools: scope.tools.map((tool) => tool.toolName).sort(),
    }))
    .filter((scope) => scope.tools.length > 0)
    .sort((left, right) => left.serverId.localeCompare(right.serverId));
}

/** Mutation projection exposes only logical names; private effect facts stay in main. */
export function projectRequestableSubagentMcpMutationInventoryV2(
  scopes: readonly SubagentMcpScopeV2[],
): SubagentRequestableMcpInventoryV2[] {
  return boundSubagentMcpInventoryByEffectV2(scopes, "mutating")
    .map((scope) => ({
      serverId: scope.serverId,
      tools: scope.tools.map((tool) => tool.toolName).sort(),
    }))
    .filter((scope) => scope.tools.length > 0)
    .sort((left, right) => left.serverId.localeCompare(right.serverId));
}

function exactRequestedMcpScopes(
  requested: readonly SubagentRequestedMcpScope[],
  inventory: readonly SubagentMcpScopeV2[],
  effect: "read" | "mutating",
): SubagentMcpScopeV2[] {
  const configured = new Map(inventory.map((scope) => [scope.serverId, scope]));
  return requested.map((request) => {
    const server = configured.get(request.serverId);
    if (!server) {
      throw new Error(
        `Requested subagent MCP server ${JSON.stringify(request.serverId)} is unavailable.`,
      );
    }
    const tools = new Map(server.tools.map((tool) => [tool.toolName, tool]));
    return {
      serverId: server.serverId,
      connectionFingerprint: server.connectionFingerprint,
      tools: request.tools.map((toolName) => {
        const tool = tools.get(toolName);
        if (!tool || tool.effect !== effect) {
          throw new Error(
            `Requested subagent MCP ${effect === "read" ? "read" : "mutation"} tool ${JSON.stringify(`${request.serverId}:${toolName}`)} is stale, unavailable, or in the wrong lane.`,
          );
        }
        return { ...tool };
      }),
    };
  });
}

/** Resolve logical model requests to exact host-owned authority scopes. */
export function resolveRequestedSubagentCapabilitiesV2(
  requested: SubagentRequestedCapabilities,
  mcpInventory: readonly SubagentMcpScopeV2[],
): SubagentCapabilitySetV2 {
  const requestedReads = new Set(
    requested.mcp.flatMap((scope) => scope.tools.map((tool) => `${scope.serverId}\0${tool}`)),
  );
  if (
    (requested.mcpMutations ?? []).some((scope) =>
      scope.tools.some((tool) => requestedReads.has(`${scope.serverId}\0${tool}`)),
    )
  ) {
    throw new Error("Subagent MCP read and mutation requests must be disjoint.");
  }
  const exactScopes = [
    ...exactRequestedMcpScopes(requested.mcp, mcpInventory, "read"),
    ...exactRequestedMcpScopes(requested.mcpMutations ?? [], mcpInventory, "mutating"),
  ];
  const mergedScopes = new Map<string, SubagentMcpScopeV2>();
  for (const scope of exactScopes) {
    const existing = mergedScopes.get(scope.serverId);
    if (!existing) {
      mergedScopes.set(scope.serverId, { ...scope, tools: [...scope.tools] });
      continue;
    }
    if (existing.connectionFingerprint !== scope.connectionFingerprint) {
      throw new Error(`Requested subagent MCP server ${JSON.stringify(scope.serverId)} changed.`);
    }
    mergedScopes.set(scope.serverId, {
      ...existing,
      tools: [...existing.tools, ...scope.tools],
    });
  }
  return {
    workspaceRead: requested.workspaceRead,
    workspaceWrite: requested.workspaceWrite,
    shell: requested.shell === true,
    web: requested.web,
    delegation: requested.delegate === true,
    mcp: [...mergedScopes.values()],
  };
}
