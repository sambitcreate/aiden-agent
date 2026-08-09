import { configStore } from "../config-store.js";
import { productionSubagentMcpReadHost } from "../mcp.js";
import type { SubagentMcpScopeV2 } from "./authority-v2.js";
import { resolveProductionSubagentMcpCredentialBoundary } from "./subagent-mcp-credential-production.js";
import {
  SubagentMcpInventoryCache,
  resolveBoundedSubagentMcpInventory,
} from "./subagent-mcp-inventory-core.js";

const inventoryCache = new SubagentMcpInventoryCache();

/**
 * Build a bounded, main-owned read inventory. Unavailable servers are omitted;
 * raw connection failures and credentials never become model-facing text.
 */
export async function resolveProductionSubagentMcpInventory(
  signal: AbortSignal,
): Promise<SubagentMcpScopeV2[]> {
  return resolveBoundedSubagentMcpInventory(signal, {
    listServers: () => configStore.listMcpServers(),
    withClient: productionSubagentMcpReadHost.withClient,
    resolveCredentialRevision: async (server, currentSignal) =>
      (await resolveProductionSubagentMcpCredentialBoundary(server, currentSignal)).revision,
    cache: inventoryCache,
  });
}
