// Saving a configured MCP server: env and header values move into the
// encrypted secrets store (config.json keeps names and markers), the
// credential-cleanup journal covers real credential changes, and local
// (stdio) launch approval follows the save.

import { configStore } from "./config-store.js";
import { logger } from "../platform.js";
import { mcpManager } from "./mcp.js";
import { mutateMcpWithCredentialCleanup } from "./mcp-credential-cleanup.js";
import { pendingMcpCredentialCleanupForSave } from "./mcp-credential-cleanup-core.js";
import { withMcpConfigurationPublication } from "./mcp-config-lease.js";
import {
  hasPlaintextMcpFields,
  mcpFieldSecretCleanupBaseline,
  mcpStdioLaunchFingerprint,
  type McpFieldSecretPlan,
} from "./mcp-field-secrets-core.js";
import { mcpStdioApprovals, planMcpServerFieldSecrets, storeMcpFieldSecretPlan } from "./mcp-field-secrets.js";
import type { McpServer } from "./types.js";

export interface SaveConfiguredMcpServerOptions {
  /**
   * The user saved this exact record from the Settings editor, which shows
   * the command and arguments: approve it to run. Other saves (enable toggle,
   * model access) keep an existing approval only while the launch is unchanged.
   */
  approveLaunch?: boolean;
}

export async function saveConfiguredMcpServer(
  server: McpServer,
  isCurrent: () => boolean,
  options: SaveConfiguredMcpServerOptions = {},
): Promise<McpServer> {
  const saved = await saveWithFieldSecrets(server.id, () => server, isCurrent, options);
  return saved!;
}

/**
 * `target` derives the record to save from the configured one read inside the
 * mutation (undefined: nothing to save), so a background rewrite never
 * overwrites a newer save with a stale snapshot.
 */
async function saveWithFieldSecrets(
  serverId: string,
  target: (current: McpServer | undefined) => McpServer | undefined,
  isCurrent: () => boolean,
  options: SaveConfiguredMcpServerOptions,
): Promise<McpServer | undefined> {
  let plan: McpFieldSecretPlan | undefined;
  let baseline: McpServer | undefined;
  return mutateMcpWithCredentialCleanup(
    serverId,
    (current) => {
      const next = target(current);
      if (!next) return null;
      plan = planMcpServerFieldSecrets(next);
      baseline = mcpFieldSecretCleanupBaseline(current, plan);
      // Moving unchanged values into the secrets store is not a credential change.
      return pendingMcpCredentialCleanupForSave(baseline, plan.server);
    },
    async (current) => {
      if (!plan) return current;
      await storeMcpFieldSecretPlan(serverId, plan, isCurrent);
      // Approve before publishing, so the first connection after the save is already allowed.
      const launchUnchanged = current?.transport === "stdio" && baseline !== undefined &&
        mcpStdioLaunchFingerprint(baseline) === mcpStdioLaunchFingerprint(plan.server) &&
        (await mcpStdioApprovals.isApproved(current));
      if (options.approveLaunch || launchUnchanged) await mcpStdioApprovals.approve(plan.server);
      await mcpManager.disconnect(serverId);
      const sealed = plan.server;
      return withMcpConfigurationPublication(serverId, () => configStore.saveMcpServer(sealed, isCurrent));
    },
    isCurrent,
  );
}

/**
 * Move env and header values still written in config.json (hand edits, or
 * records saved before values moved to the keychain) into the secrets store
 * and rewrite config.json without them. Runs at startup and after config.json
 * changes on disk; a server that cannot be sealed keeps working and is retried
 * next time.
 */
export async function sealPlaintextMcpServerFields(): Promise<void> {
  const servers = await configStore.listMcpServers();
  for (const server of servers.filter(hasPlaintextMcpFields)) {
    try {
      await saveWithFieldSecrets(server.id, (current) => (current && hasPlaintextMcpFields(current) ? current : undefined), () => true, {});
    } catch (error) {
      logger.warn("mcp", `Could not move the env and header values of MCP server ${server.id} into the keychain.`, error);
    }
  }
}
