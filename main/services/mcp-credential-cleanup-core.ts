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
  authServerMetadataUrl?: string;
  oauthClientName?: string;
  authProvider?: string;
  presetId?: string;
}

/** Every field that can affect runtime admission or the resulting tool surface. */
export interface McpRuntimeConnectionSnapshot extends McpCredentialConnectionSnapshot {
  name: string;
  description?: string;
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
    "authServerMetadataUrl",
    "oauthClientName",
    "authProvider",
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
    (record.authServerMetadataUrl !== undefined && typeof record.authServerMetadataUrl !== "string") ||
    (record.oauthClientName !== undefined && typeof record.oauthClientName !== "string") ||
    (record.authProvider !== undefined && typeof record.authProvider !== "string") ||
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
    ...(server.authServerMetadataUrl !== undefined ? { authServerMetadataUrl: server.authServerMetadataUrl } : {}),
    ...(server.oauthClientName !== undefined ? { oauthClientName: server.oauthClientName } : {}),
    ...(server.authProvider !== undefined ? { authProvider: server.authProvider } : {}),
    ...(server.presetId !== undefined ? { presetId: server.presetId } : {}),
  };
}

export function sameMcpCredentialConnection(
  left: McpCredentialConnectionSnapshot | null,
  right: McpCredentialConnectionSnapshot | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Connection identity for approvals that outlive a session (Bot grants and
 * schedule bindings). Unlike the runtime snapshot it leaves out the display
 * name, description, and enabled flag, so renaming or re-describing a server
 * keeps its approvals. Every caller checks enablement separately.
 */
export function mcpAuthorityConnectionSnapshot(server: McpServer): McpCredentialConnectionSnapshot {
  return mcpCredentialConnectionSnapshot(server);
}

export function mcpRuntimeConnectionSnapshot(server: McpServer): McpRuntimeConnectionSnapshot {
  return {
    ...mcpCredentialConnectionSnapshot(server),
    name: server.name,
    ...(server.description !== undefined ? { description: server.description } : {}),
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

/**
 * Credential transitions Aiden made itself that change no credential: moving
 * a server's plain-text env/header values into the keychain swaps each value
 * for a marker, which changes the snapshot hashes while every value (and so
 * OAuth tokens, provider grants and preset keys) stays valid. The save path
 * registers the exact before/after snapshots; the portable-config snapshot
 * listener, which sees only the before and after records, then treats that
 * exact transition as no credential change.
 */
export class McpCredentialEquivalences {
  private readonly entries = new Map<string, { from: string; to: string }>();

  register(serverId: string, from: McpCredentialConnectionSnapshot, to: McpCredentialConnectionSnapshot): void {
    this.entries.set(serverId, { from: JSON.stringify(from), to: JSON.stringify(to) });
  }

  equivalent(serverId: string, from: McpCredentialConnectionSnapshot | null, to: McpCredentialConnectionSnapshot | null): boolean {
    const entry = this.entries.get(serverId);
    return Boolean(entry && from && to && entry.from === JSON.stringify(from) && entry.to === JSON.stringify(to));
  }
}

export const mcpCredentialEquivalences = new McpCredentialEquivalences();

/**
 * The cleanup an observed config transition needs (as the portable-config
 * listener sees it), or null when no credential changed, including an
 * equivalence the save path registered.
 */
export function externalMcpCredentialCleanupKind(
  before: McpServer,
  after: McpServer | undefined,
  equivalences: McpCredentialEquivalences = mcpCredentialEquivalences,
): PendingMcpCredentialCleanupV1["kind"] | null {
  const previous = mcpCredentialConnectionSnapshot(before);
  const target = after ? mcpCredentialConnectionSnapshot(after) : null;
  if (sameMcpCredentialConnection(previous, target) || equivalences.equivalent(before.id, previous, target)) return null;
  return !after ? "remove" : before.oauth && !after.oauth ? "disable-oauth" : "replace";
}
