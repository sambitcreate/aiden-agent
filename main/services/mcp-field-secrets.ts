// Encrypted storage for custom MCP servers' env and header values (see
// mcp-field-secrets-core.ts) and the stdio launch approvals.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "../platform.js";
import { secrets } from "./secrets.js";
import {
  MCP_FIELD_SECRET_LIMITS,
  mcpEnvForApproval,
  mcpFieldSecretId,
  mcpFieldSecretFieldValues,
  mcpFieldSecretMarkers,
  stageMcpFieldSecrets,
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

/** Field → value for each of the server's fields that resolves (its destination, its own field). */
export async function storedMcpFieldSecretValues(server: McpServer): Promise<McpFieldSecretValues> {
  return mcpFieldSecretFieldValues(server, await readRecord(server.id));
}

/** A local server's env as its launch approval shows it. */
export async function storedMcpEnvForApproval(server: McpServer): Promise<ReturnType<typeof mcpEnvForApproval>> {
  return mcpEnvForApproval(server, await readRecord(server.id).catch(() => undefined));
}

async function readRecord(serverId: string): Promise<McpFieldSecretRecord | undefined> {
  return parseMcpFieldSecretRecord(await secrets.getKeyStrict(mcpFieldSecretId(serverId)));
}

async function writeRecord(serverId: string, record: McpFieldSecretRecord | undefined, isCurrent: () => boolean): Promise<void> {
  if (!record || Object.values(record.bindings).every((group) => Object.keys(group).length === 0)) {
    await secrets.deleteKey(mcpFieldSecretId(serverId), isCurrent);
    return;
  }
  await secrets.setInternalKey(mcpFieldSecretId(serverId), serializeMcpFieldSecretRecord(record), MAX_RECORD_CHARS, isCurrent);
}

/**
 * Stage a plan's values before its config is published (additive only; see
 * `stageMcpFieldSecrets`). Returns the record to publish.
 */
export async function stageStoredMcpFieldSecrets(
  serverId: string,
  plan: McpFieldSecretPlan,
  isCurrent: () => boolean,
  options: { fromEditor?: boolean; current?: McpServer } = {},
): Promise<McpServer> {
  const staged = stageMcpFieldSecrets(await readRecord(serverId), plan, { ...options, random: () => randomBytes(16).toString("hex") });
  if (staged.record) await writeRecord(serverId, staged.record, isCurrent);
  return staged.server;
}

/**
 * Drop stored values the authoritative config no longer resolves: call only
 * with a record that committed (after publication, or a disk-reloaded config in
 * recovery), never with one about to be replaced.
 */
export async function pruneStoredMcpFieldSecrets(
  serverId: string,
  current: McpServer | undefined,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const record = await readRecord(serverId);
  if (!record) return;
  const pruned = pruneMcpFieldSecretRecord(record, current);
  if (pruned && serializeMcpFieldSecretRecord(pruned) === serializeMcpFieldSecretRecord(record)) return;
  await writeRecord(serverId, pruned, isCurrent);
}

/** Connection-ready copy with stored env/header values filled in. */
export async function resolveStoredMcpFieldSecrets(server: McpServer): Promise<McpServer> {
  if (mcpFieldSecretMarkers(server).length === 0) return server;
  return resolveMcpFieldSecrets(server, await readRecord(server.id));
}
