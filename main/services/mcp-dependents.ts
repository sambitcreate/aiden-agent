// Read-only lookup of what stops working when an MCP server is renamed away,
// disabled or removed: scheduled tasks approved to call it, and Bots whose
// Custom access grants one of its connections. Settings shows these in its
// confirmations; nothing here changes either store.

import type { McpDependent } from "../../renderer/shared/mcp-status.js";

export type { McpDependent, McpServerDependents } from "../../renderer/shared/mcp-status.js";

interface ScheduledTaskScope {
  id: string;
  name: string;
  mcpServerIds?: readonly string[];
  mcpServerBindings?: ReadonlyArray<{ id: string }>;
}

/** Tasks whose approved MCP scope names this server (exact ids or main-owned bindings). */
export function scheduledTasksUsingMcpServer(
  serverId: string,
  tasks: readonly ScheduledTaskScope[],
): McpDependent[] {
  return tasks
    .filter(
      (task) =>
        task.mcpServerIds?.includes(serverId) === true ||
        task.mcpServerBindings?.some((binding) => binding.id === serverId) === true,
    )
    .map((task) => ({ id: task.id, name: task.name }));
}

/**
 * Bots with Custom access to one of this server's connections. A Bot's bound
 * Custom selection keeps the configured server id beside each opaque
 * connection id; Full access (no binding) never depends on one server.
 */
export async function botsGrantingMcpServer(
  serverId: string,
  bots: readonly McpDependent[],
  customBinding: (botId: string) => Promise<{ connections: ReadonlyArray<{ sourceId: string }> } | undefined>,
): Promise<McpDependent[]> {
  const dependents: McpDependent[] = [];
  for (const bot of bots) {
    const binding = await customBinding(bot.id);
    if (binding?.connections.some((connection) => connection.sourceId === serverId)) {
      dependents.push({ id: bot.id, name: bot.name });
    }
  }
  return dependents;
}
