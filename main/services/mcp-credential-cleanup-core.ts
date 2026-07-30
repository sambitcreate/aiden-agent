import type { McpServer } from "./types.js";
import { createHash } from "node:crypto";

export interface McpCredentialConnectionSnapshot {
  id: string;
  transport: McpServer["transport"];
  url?: string;
  command?: string;
  args?: string[];
  envHash?: string;
  headersHash?: string;
  oauth?: boolean;
  presetId?: string;
}

/** Every field that can affect runtime admission or the resulting tool surface. */
export interface McpRuntimeConnectionSnapshot extends McpCredentialConnectionSnapshot {
  name: string;
  enabled: boolean;
}

export interface PendingMcpCredentialCleanupV1 {
  version: 1;
  kind: "remove" | "disable-oauth" | "replace";
  serverId: string;
  previous: McpCredentialConnectionSnapshot | null;
  target: McpCredentialConnectionSnapshot | null;
}

function secretMapHash(value: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function parseSnapshot(value: unknown): McpCredentialConnectionSnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pending MCP credential cleanup.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "transport",
    "url",
    "command",
    "args",
    "envHash",
    "headersHash",
    "oauth",
    "presetId",
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    typeof record.id !== "string" ||
    !["stdio", "http", "sse"].includes(String(record.transport)) ||
    (record.url !== undefined && typeof record.url !== "string") ||
    (record.command !== undefined && typeof record.command !== "string") ||
    (record.args !== undefined &&
      (!Array.isArray(record.args) || !record.args.every((entry) => typeof entry === "string"))) ||
    (record.envHash !== undefined &&
      (typeof record.envHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.envHash))) ||
    (record.headersHash !== undefined &&
      (typeof record.headersHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.headersHash))) ||
    (record.oauth !== undefined && typeof record.oauth !== "boolean") ||
    (record.presetId !== undefined && typeof record.presetId !== "string")
  ) {
    throw new Error("Invalid pending MCP credential cleanup.");
  }
  return structuredClone(record) as unknown as McpCredentialConnectionSnapshot;
}

export function mcpCredentialConnectionSnapshot(
  server: McpServer,
): McpCredentialConnectionSnapshot {
  return {
    id: server.id,
    transport: server.transport,
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: structuredClone(server.args) } : {}),
    ...(server.env !== undefined ? { envHash: secretMapHash(server.env) } : {}),
    ...(server.headers !== undefined ? { headersHash: secretMapHash(server.headers) } : {}),
    ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
    ...(server.presetId !== undefined ? { presetId: server.presetId } : {}),
  };
}

export function sameMcpCredentialConnection(
  left: McpCredentialConnectionSnapshot | null,
  right: McpCredentialConnectionSnapshot | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mcpRuntimeConnectionSnapshot(server: McpServer): McpRuntimeConnectionSnapshot {
  return {
    ...mcpCredentialConnectionSnapshot(server),
    name: server.name,
    enabled: server.enabled,
  };
}

export function sameMcpRuntimeConnection(
  left: McpRuntimeConnectionSnapshot | null,
  right: McpRuntimeConnectionSnapshot | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function replaceMcpCredentialAfterDisconnect<R>(
  disconnect: () => Promise<void>,
  replace: () => Promise<R>,
): Promise<R> {
  await disconnect();
  return replace();
}

export function pendingMcpCredentialCleanupForSave(
  current: McpServer | undefined,
  targetServer: McpServer,
): PendingMcpCredentialCleanupV1 | null {
  if (!current) return null;
  const previous = mcpCredentialConnectionSnapshot(current);
  const target = mcpCredentialConnectionSnapshot(targetServer);
  if (sameMcpCredentialConnection(previous, target)) return null;
  return {
    version: 1,
    kind: current.oauth && !targetServer.oauth ? "disable-oauth" : "replace",
    serverId: targetServer.id,
    previous,
    target,
  };
}

export function pendingMcpCredentialCleanupForRemove(
  current: McpServer | undefined,
  serverId: string,
): PendingMcpCredentialCleanupV1 | null {
  if (!current) return null;
  return {
    version: 1,
    kind: "remove",
    serverId,
    previous: mcpCredentialConnectionSnapshot(current),
    target: null,
  };
}

export function parsePendingMcpCredentialCleanup(value: unknown): PendingMcpCredentialCleanupV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pending MCP credential cleanup.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.kind !== "remove" && record.kind !== "disable-oauth" && record.kind !== "replace") ||
    typeof record.serverId !== "string" ||
    record.serverId.length === 0 ||
    record.serverId.length > 256
  ) {
    throw new Error("Invalid pending MCP credential cleanup.");
  }
  const previous = parseSnapshot(record.previous);
  const target = parseSnapshot(record.target);
  if (previous?.id !== record.serverId || (target !== null && target.id !== record.serverId)) {
    throw new Error("Invalid pending MCP credential cleanup.");
  }
  return {
    version: 1,
    kind: record.kind,
    serverId: record.serverId,
    previous,
    target,
  };
}

export type McpCredentialCleanupResolution =
  | { resolved: false; clearOAuth: false; clearPresetKey: false }
  | { resolved: true; clearOAuth: boolean; clearPresetKey: boolean };

export function mcpCredentialCleanupAfterConfig(
  pending: PendingMcpCredentialCleanupV1,
  current: McpServer | undefined,
): McpCredentialCleanupResolution {
  const snapshot = current ? mcpCredentialConnectionSnapshot(current) : null;
  if (sameMcpCredentialConnection(snapshot, pending.previous)) {
    return { resolved: true, clearOAuth: false, clearPresetKey: false };
  }
  const reachedIntendedTarget = sameMcpCredentialConnection(snapshot, pending.target);
  return {
    resolved: true,
    clearOAuth: true,
    // Disabling OAuth alone preserves an API-key preset only at the exact
    // intended target. If the file advanced again while the journal was
    // pending, fail closed and clear every credential from the old identity.
    clearPresetKey: pending.kind !== "disable-oauth" || !reachedIntendedTarget,
  };
}
