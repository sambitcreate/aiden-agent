import { secrets } from "./secrets.js";
import { configStore } from "./config-store.js";
import type { McpServer } from "./types.js";
import { mcpRuntimeConnectionSnapshot, sameMcpRuntimeConnection } from "./mcp-credential-cleanup-core.js";
import { createMcpProviderAuthenticatedFetch, mcpProviderGrantBinding, mcpProviderGrantKey } from "./mcp-provider-auth-core.js";

export async function hasMcpProviderAuthGrant(server: McpServer): Promise<boolean> {
  if (!server.authProvider) return false;
  return await secrets.getKeyStrict(mcpProviderGrantKey(server.id)) === mcpProviderGrantBinding(server);
}

/** Called only by the explicit active-renderer consent action, inside the MCP publication lock. */
export async function setMcpProviderAuthGrant(server: McpServer, allowed: boolean, isCurrent: () => boolean): Promise<void> {
  const binding = mcpProviderGrantBinding(server);
  if (!allowed) { await secrets.deleteKey(mcpProviderGrantKey(server.id), isCurrent); return; }
  const { providerRegistry } = await import("./provider-registry.js");
  if (!providerRegistry.isBuiltinProvider(server.authProvider!)) throw new Error("Choose a built-in provider for MCP authentication.");
  await secrets.setInternalKey(mcpProviderGrantKey(server.id), binding, 1024, isCurrent);
}

export function mcpProviderAuthenticatedFetch(server: McpServer, isCurrent: () => boolean): typeof fetch {
  const expected = mcpRuntimeConnectionSnapshot(server);
  return createMcpProviderAuthenticatedFetch({
    server,
    assertCurrent() { if (!isCurrent()) throw new Error("This MCP connection is no longer current."); },
    async readGrant() {
      const current = (await configStore.listMcpServers()).find((item) => item.id === server.id);
      if (!current?.enabled || !sameMcpRuntimeConnection(expected, mcpRuntimeConnectionSnapshot(current))) throw new Error("MCP provider authentication configuration changed.");
      return secrets.getKeyStrict(mcpProviderGrantKey(server.id));
    },
    async resolveToken(providerId) {
      const { providerRegistry } = await import("./provider-registry.js");
      if (!providerRegistry.isBuiltinProvider(providerId)) return undefined;
      return (await providerRegistry.getBuiltinRequestAuth(providerId))?.auth.apiKey;
    },
  });
}
