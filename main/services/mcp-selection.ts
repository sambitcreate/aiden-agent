import type { McpServer } from "./types.js";

/** Resolve an exact persisted MCP scope against the current configured identities. */
export function selectedMcpServers(
  configured: readonly McpServer[],
  serverIds: readonly string[] | undefined,
): McpServer[] {
  if (serverIds === undefined) return configured.filter((server) => server.enabled);
  const byId = new Map(configured.map((server) => [server.id, server]));
  return serverIds.map((id) => {
    const server = byId.get(id);
    if (!server) throw new Error(`The approved MCP server "${id}" no longer exists.`);
    if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`);
    return server;
  });
}
