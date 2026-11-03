// Saving a configured MCP server: env and header values move into the
// encrypted secrets store (config.json keeps names and markers), the
// credential-cleanup journal covers real credential changes, and local
// (stdio) launch approval follows the save.

import { confirmMcpLaunch } from "./mcp-launch-review.js";
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
  resolveStoredMcpFieldSecrets,
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

/** A save's staged record, and whether it keeps a launch that is already approved. */
async function stageForSave(
  serverId: string,
  current: McpServer | undefined,
  plan: McpFieldSecretPlan,
  isCurrent: () => boolean,
  options: SaveConfiguredMcpServerOptions,
): Promise<{ staged: McpServer; launchUnchanged: boolean }> {
  // Additive only: nothing the configured record resolves changes until
  // the new record is published.
  const staged = await stageStoredMcpFieldSecrets(serverId, plan, isCurrent, { fromEditor: options.approveLaunch === true || options.fromEditor === true, current });
  const baseline = mcpFieldSecretCleanupBaseline(current, plan);
  const launchUnchanged = current?.transport === "stdio" && baseline !== undefined &&
    mcpStdioLaunchFingerprint(baseline) === mcpStdioLaunchFingerprint(staged) &&
    (await mcpStdioApprovals.isApproved(current));
  return { staged, launchUnchanged };
}

/** The stored values a save plans against, read before its mutation (planning is synchronous). */
async function storedValuesFor(serverId: string) {
  const before = (await configStore.listMcpServers()).find(({ id }) => id === serverId);
  return before ? storedMcpFieldSecretValues(before) : {};
}

/**
 * Shows the editor's launch review with no MCP lock held, so chats, Bots and
 * other saves keep using connectors while the box is open. A first, publishing-
 * free pass stages the record to learn the exact launch; the save then
 * publishes only if it stages that same launch again. Returns the fingerprint
 * of the approved effective launch, or undefined when no review is needed.
 */
async function reviewEditorLaunch(
  serverId: string,
  target: (current: McpServer | undefined) => McpServer | undefined,
  isCurrent: () => boolean,
  options: SaveConfiguredMcpServerOptions,
): Promise<string | undefined> {
  const storedValues = await storedValuesFor(serverId);
  const effective = await mutateMcpWithCredentialCleanup<McpServer | undefined>(
    serverId,
    () => null,
    async (current) => {
      const next = target(current);
      if (!next) return undefined;
      const plan = planMcpServerFieldSecrets(next, { reuse: { current, values: storedValues } });
      const { staged, launchUnchanged } = await stageForSave(serverId, current, plan, isCurrent, options);
      return staged.transport === "stdio" && !launchUnchanged ? resolveStoredMcpFieldSecrets(staged) : undefined;
    },
    isCurrent,
  );
  if (!effective) return undefined;
  if (!(await confirmMcpLaunch(effective))) {
    // Drop the values staged for the launch that was not approved.
    await mutateMcpWithCredentialCleanup(serverId, () => null, (current) => pruneStoredMcpFieldSecrets(serverId, current), isCurrent)
      .catch(() => undefined);
    throw new Error("Launch review cancelled.");
  }
  if (!isCurrent()) throw new Error("The renderer document is no longer active.");
  return mcpStdioLaunchFingerprint(effective);
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
  const reviewed = options.approveLaunch ? await reviewEditorLaunch(serverId, target, isCurrent, options) : undefined;
  // Planning runs synchronously inside the mutation, so the stored values it
  // compares against are read first. They only choose which markers to reuse;
  // staging validates every kept marker again.
  const storedValues = await storedValuesFor(serverId);
  let plan: McpFieldSecretPlan | undefined;
  return mutateMcpWithCredentialCleanup(
    serverId,
    (current) => {
      const next = target(current);
      if (!next) return null;
      plan = planMcpServerFieldSecrets(next, { reuse: { current, values: storedValues } });
      // Stored credentials are bound to the connection, not to how env/header
      // values are stored, so moving them into the keychain cleans nothing up.
      return pendingMcpCredentialCleanupForSave(current, plan.server);
    },
    async (current) => {
      if (!plan) return current;
      // Approve before publishing, so the first connection after the save is
      // already allowed. Like the field secrets, the approval is additive until
      // the record is published, so a failed save keeps the configured launch
      // runnable; afterwards only the published launch stays approved.
      const { staged, launchUnchanged } = await stageForSave(serverId, current, plan, isCurrent, options);
      if (options.approveLaunch && staged.transport === "stdio" && !launchUnchanged) {
        const effective = await resolveStoredMcpFieldSecrets(staged);
        if (reviewed === undefined || mcpStdioLaunchFingerprint(effective) !== reviewed) {
          throw new Error("This connector’s launch changed during review. Review it again.");
        }
      }
      const saved = await publishWithLaunchApproval(
        mcpStdioApprovals,
        staged,
        options.approveLaunch === true || launchUnchanged,
        async () => {
          await mcpManager.disconnect(serverId);
          return withMcpConfigurationPublication(serverId, () => configStore.saveMcpServer(staged, isCurrent));
        },
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
 * changes on disk; a server that cannot be sealed remains blocked and is retried
 * next time. Local launch consent is independent: sealing never approves a
 * pending command. Its exact values are reviewed only in a foreground action.
 */
export async function sealPlaintextMcpServerFields(serverIds?: readonly string[], options: { throwOnError?: boolean } = {}): Promise<void> {
  const servers = (await configStore.listMcpServers())
    .filter((server) => !serverIds || serverIds.includes(server.id));
  for (const server of servers.filter(hasPlaintextMcpFields)) {
    try {
      await saveWithFieldSecrets(server.id, (current) => (current && hasPlaintextMcpFields(current) ? current : undefined), () => true, {});
    } catch (error) {
      if (options.throwOnError) throw error;
      logger.warn("mcp", `Could not move the env and header values of MCP server ${server.id} into the keychain.`, error);
    }
  }
}
