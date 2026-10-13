// Encrypted storage for custom MCP servers' env and header values (see
// mcp-field-secrets-core.ts) and the stdio launch approvals.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "../platform.js";
import { secrets } from "./secrets.js";
import {
  MCP_FIELD_SECRET_LIMITS,
  mcpFieldSecretDestination,
  mcpFieldSecretId,
  mcpFieldSecretMarkers,
  nextMcpFieldSecretRecord,
  parseMcpFieldSecretRecord,
  planMcpFieldSecrets,
  pruneMcpFieldSecretRecord,
  resolveMcpFieldSecrets,
  serializeMcpFieldSecretRecord,
  type McpFieldSecretPlan,
  type McpFieldSecretPlanOptions,
  type McpFieldSecretRecord,
  type McpFieldSecretValues,
} from "./mcp-field-secrets-core.js";
import { createMcpStdioApprovalStore } from "./mcp-stdio-approvals.js";
import type { McpServer } from "./types.js";

/** Whole-record bound: every value at its limit, plus JSON overhead. */
const MAX_RECORD_CHARS = MCP_FIELD_SECRET_LIMITS.entries * 2 * (MCP_FIELD_SECRET_LIMITS.valueChars + 64);

export const mcpStdioApprovals = createMcpStdioApprovalStore(async () => {
  const root = app.getPath("userData");
  await fs.mkdir(root, { recursive: true });
  return path.join(root, "mcp-stdio-approvals.json");
});

export function planMcpServerFieldSecrets(server: McpServer, options: McpFieldSecretPlanOptions = {}): McpFieldSecretPlan {
  return planMcpFieldSecrets(server, () => randomBytes(16).toString("hex"), options);
}

/** The server's stored values (empty when none, or when bound to another destination). */
export async function storedMcpFieldSecretValues(server: McpServer): Promise<McpFieldSecretValues> {
  const record = await readRecord(server.id);
  return record?.destination === mcpFieldSecretDestination(server) ? record.values : {};
}

async function readRecord(serverId: string): Promise<McpFieldSecretRecord | undefined> {
  return parseMcpFieldSecretRecord(await secrets.getKeyStrict(mcpFieldSecretId(serverId)));
}

async function writeRecord(serverId: string, record: McpFieldSecretRecord | undefined, isCurrent: () => boolean): Promise<void> {
  if (!record || Object.keys(record.values).length === 0) {
    await secrets.deleteKey(mcpFieldSecretId(serverId), isCurrent);
    return;
  }
  await secrets.setInternalKey(mcpFieldSecretId(serverId), serializeMcpFieldSecretRecord(record), MAX_RECORD_CHARS, isCurrent);
}

/**
 * Store a plan's new values next to the server's existing ones, bound to the
 * plan's destination. Kept markers must already be stored for this server;
 * otherwise the value is gone (for example config.json was copied from another
 * device) and must be re-entered. Kept values follow a changed address or
 * command only when the person changed it in the editor
 * (`allowNewDestination`); otherwise they must be entered again.
 */
export async function storeMcpFieldSecretPlan(
  serverId: string,
  plan: McpFieldSecretPlan,
  isCurrent: () => boolean,
  options: { allowNewDestination?: boolean } = {},
): Promise<void> {
  const next = nextMcpFieldSecretRecord(await readRecord(serverId), plan, options);
  if (next) await writeRecord(serverId, next, isCurrent);
}

/**
 * Drop stored values `current` no longer references, and every value once the
 * server is gone or its address or command changed.
 */
export async function pruneStoredMcpFieldSecrets(
  serverId: string,
  current: McpServer | undefined,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const record = await readRecord(serverId);
  if (!record) return;
  const pruned = pruneMcpFieldSecretRecord(record, current);
  if (pruned && Object.keys(pruned.values).length === Object.keys(record.values).length) return;
  await writeRecord(serverId, pruned, isCurrent);
}

/** Connection-ready copy with stored env/header values filled in. */
export async function resolveStoredMcpFieldSecrets(server: McpServer): Promise<McpServer> {
  if (mcpFieldSecretMarkers(server).length === 0) return server;
  return resolveMcpFieldSecrets(server, await readRecord(server.id));
}
