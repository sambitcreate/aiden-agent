// Encrypted storage for custom MCP servers' env and header values (see
// mcp-field-secrets-core.ts) and the stdio launch approvals.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "../platform.js";
import { secrets } from "./secrets.js";
import {
  MCP_FIELD_SECRET_LIMITS,
  mcpFieldSecretId,
  mcpFieldSecretMarkers,
  parseMcpFieldSecretRecord,
  planMcpFieldSecrets,
  pruneMcpFieldSecretRecord,
  resolveMcpFieldSecrets,
  type McpFieldSecretPlan,
  type McpFieldSecretRecord,
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

export function planMcpServerFieldSecrets(server: McpServer): McpFieldSecretPlan {
  return planMcpFieldSecrets(server, () => randomBytes(16).toString("hex"));
}

async function readRecord(serverId: string): Promise<McpFieldSecretRecord> {
  return parseMcpFieldSecretRecord(await secrets.getKeyStrict(mcpFieldSecretId(serverId)));
}

async function writeRecord(serverId: string, record: McpFieldSecretRecord | undefined, isCurrent: () => boolean): Promise<void> {
  if (!record || Object.keys(record).length === 0) {
    await secrets.deleteKey(mcpFieldSecretId(serverId), isCurrent);
    return;
  }
  await secrets.setInternalKey(mcpFieldSecretId(serverId), JSON.stringify(record), MAX_RECORD_CHARS, isCurrent);
}

/**
 * Store a plan's new values next to the server's existing ones. Kept markers
 * must already be stored for this server; otherwise the value is gone (for
 * example config.json was copied from another device) and must be re-entered.
 */
export async function storeMcpFieldSecretPlan(
  serverId: string,
  plan: McpFieldSecretPlan,
  isCurrent: () => boolean,
): Promise<void> {
  if (plan.kept.length === 0 && Object.keys(plan.added).length === 0) return;
  const record = await readRecord(serverId);
  const missing = plan.kept.find(({ marker }) => !Object.prototype.hasOwnProperty.call(record, marker));
  if (missing) throw new Error(`The saved value for ${missing.field} is missing on this device. Enter it again.`);
  if (Object.keys(plan.added).length === 0) return;
  await writeRecord(serverId, { ...record, ...plan.added }, isCurrent);
}

/** Drop stored values `current` no longer references (all of them once it is removed). */
export async function pruneStoredMcpFieldSecrets(
  serverId: string,
  current: McpServer | undefined,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const record = await readRecord(serverId);
  if (Object.keys(record).length === 0) return;
  const pruned = pruneMcpFieldSecretRecord(record, current);
  if (pruned && Object.keys(pruned).length === Object.keys(record).length) return;
  await writeRecord(serverId, pruned, isCurrent);
}

/** Connection-ready copy with stored env/header values filled in. */
export async function resolveStoredMcpFieldSecrets(server: McpServer): Promise<McpServer> {
  if (mcpFieldSecretMarkers(server).length === 0) return server;
  return resolveMcpFieldSecrets(server, await readRecord(server.id));
}
