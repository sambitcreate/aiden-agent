import type { McpServer } from "./types.js";
import { mcpServerOffersTools } from "../../renderer/shared/mcp-exposure.js";

/** Resolve an exact persisted MCP scope against the current configured identities. */
export function selectedMcpServers(
  configured: readonly McpServer[],
  serverIds: readonly string[] | undefined,
): McpServer[] {
  if (serverIds === undefined) return configured.filter((server) => server.enabled);
  // An approved scope that names a server switched off for the model fails
  // closed: the run reports it instead of silently running without its tools.
  const byId = new Map(configured.map((server) => [server.id, server]));
  return serverIds.map((id) => {
    const server = byId.get(id);
    if (!server) throw new Error(`The approved MCP server "${id}" no longer exists.`);
    if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled.`);
    if (!mcpServerOffersTools(server)) throw new Error(`MCP server "${server.name}" is off for the model. Turn it on in Settings → Plugins or edit this task.`);
    return server;
  });
}
