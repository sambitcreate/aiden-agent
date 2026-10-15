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
import {
  mcpStdioApprovals,
  planMcpServerFieldSecrets,
  pruneStoredMcpFieldSecrets,
  stageStoredMcpFieldSecrets,
  storedMcpFieldSecretValues,
} from "./mcp-field-secrets.js";
import { publishWithLaunchApproval } from "./mcp-stdio-approvals.js";
import type { McpServer } from "./types.js";

export interface SaveConfiguredMcpServerOptions {
  /**
   * The person saved this exact record from the Settings editor, which shows
   * the command, arguments and environment: approve it to run, and let kept
   * header/env values follow an address or command they changed there. Other
   * saves (enable toggle, model access) keep an existing approval only while
   * the launch is unchanged and never move stored values to a new destination.
   */
  approveLaunch?: boolean;
  /**
   * The save comes from the Settings editor (including its sign-in and
   * provider-consent steps), where the person sees the address or command, so
   * kept values may follow an address or command change. Implied by
   * `approveLaunch`.
   */
  fromEditor?: boolean;
}

export async function saveConfiguredMcpServer(
  server: McpServer,
  isCurrent: () => boolean,
  options: SaveConfiguredMcpServerOptions = {},
): Promise<McpServer> {
  const saved = await saveWithFieldSecrets(server.id, () => server, isCurrent, options);
  return saved!;
}

/** A local server's env stays readable in config.json until it was approved to run. */
async function launchApproved(server: McpServer | undefined): Promise<boolean> {
  return !server || server.transport !== "stdio" || mcpStdioApprovals.isApproved(server);
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
  // Planning runs synchronously inside the mutation, so the stored values it
  // compares against are read first. They only choose which markers to reuse;
  // staging validates every kept marker again.
  const before = (await configStore.listMcpServers()).find(({ id }) => id === serverId);
  const storedValues = before ? await storedMcpFieldSecretValues(before) : {};
  const sealEnv = options.approveLaunch === true || (await launchApproved(before));
  let plan: McpFieldSecretPlan | undefined;
  return mutateMcpWithCredentialCleanup(
    serverId,
    (current) => {
      const next = target(current);
      if (!next) return null;
      plan = planMcpServerFieldSecrets(next, { reuse: { current, values: storedValues }, sealEnv });
      // Stored credentials are bound to the connection, not to how env/header
      // values are stored, so moving them into the keychain cleans nothing up.
      return pendingMcpCredentialCleanupForSave(current, plan.server);
    },
    async (current) => {
      if (!plan) return current;
      // Additive only: nothing the configured record resolves changes until
      // the new record is published.
      const staged = await stageStoredMcpFieldSecrets(serverId, plan, isCurrent, { fromEditor: options.approveLaunch === true || options.fromEditor === true, current });
      // Approve before publishing, so the first connection after the save is
      // already allowed. Like the field secrets, the approval is additive until
      // the record is published, so a failed save keeps the configured launch
      // runnable; afterwards only the published launch stays approved.
      const baseline = mcpFieldSecretCleanupBaseline(current, plan);
      const launchUnchanged = current?.transport === "stdio" && baseline !== undefined &&
        mcpStdioLaunchFingerprint(baseline) === mcpStdioLaunchFingerprint(staged) &&
        (await mcpStdioApprovals.isApproved(current));
      const saved = await publishWithLaunchApproval(
        mcpStdioApprovals,
        staged,
        options.approveLaunch === true || launchUnchanged,
        async () => {
          await mcpManager.disconnect(serverId);
          return withMcpConfigurationPublication(serverId, () => configStore.saveMcpServer(staged, isCurrent));
        },
        async () => (await configStore.listMcpServers()).find(({ id }) => id === serverId),
      );
      // Committed: values the published record no longer resolves can go.
      await pruneStoredMcpFieldSecrets(serverId, saved).catch(() => undefined);
      return saved;
    },
    isCurrent,
  );
}

/**
 * Move env and header values still written in config.json (hand edits, or
 * records saved before values moved to the keychain) into the secrets store
 * and rewrite config.json without them. Runs at startup and after config.json
 * changes on disk; a server that cannot be sealed keeps working and is retried
 * next time. A local server not yet approved keeps its env in config.json, so
 * Settings can show exactly what approving it would run.
 */
export async function sealPlaintextMcpServerFields(serverIds?: readonly string[]): Promise<void> {
  const servers = (await configStore.listMcpServers())
    .filter((server) => !serverIds || serverIds.includes(server.id));
  for (const server of servers.filter(hasPlaintextMcpFields)) {
    if (!(await launchApproved(server))) continue;
    try {
      await saveWithFieldSecrets(server.id, (current) => (current && hasPlaintextMcpFields(current) ? current : undefined), () => true, {});
    } catch (error) {
      logger.warn("mcp", `Could not move the env and header values of MCP server ${server.id} into the keychain.`, error);
    }
  }
}
