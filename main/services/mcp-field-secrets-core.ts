// Custom MCP servers' env and header values live in the encrypted secrets
// store, never in the portable config.json. config.json keeps each name with
// an opaque marker (`aiden-secret:v1:<random>`); the server's secret record
// maps markers to values. A new marker is minted whenever a value is entered,
// so a changed value changes the server's credential snapshot (env/header map
// hashes) and therefore Bot grants, schedule bindings, leases and the
// credential-cleanup journal exactly as an edited plaintext value did.

import { createHash } from "node:crypto";
import type { McpServer } from "./types.js";
import { MCP_FIELD_SECRET_PREFIX, isMcpFieldSecretMarker } from "../../renderer/shared/mcp-field-secrets.js";

export { MCP_FIELD_SECRET_PREFIX, isMcpFieldSecretMarker };

export const MCP_FIELD_SECRET_LIMITS = Object.freeze({ entries: 64, valueChars: 16_384, nameChars: 256 });

/** Marker → value for one server. */
export type McpFieldSecretRecord = Record<string, string>;

type FieldKind = "env" | "headers";
const KINDS: readonly FieldKind[] = ["env", "headers"];


/** Secrets-store id holding one server's env/header values. */
export function mcpFieldSecretId(serverId: string): string {
  return `mcp-fields:${serverId}`;
}

export class McpFieldSecretMissingError extends Error {
  constructor(readonly serverName: string, readonly field: string) {
    super(`The saved value for ${field} of “${serverName}” is missing on this device. Enter it again in Settings → Plugins.`);
  }
}

function fieldLabel(kind: FieldKind, name: string): string {
  return kind === "env" ? `environment variable “${name}”` : `header “${name}”`;
}

/** True when config still holds an env or header value in plain text. */
export function hasPlaintextMcpFields(server: McpServer): boolean {
  return KINDS.some((kind) => Object.values(server[kind] ?? {}).some((value) => !isMcpFieldSecretMarker(value)));
}

/** Every marker the server references. */
export function mcpFieldSecretMarkers(server: McpServer | undefined): string[] {
  if (!server) return [];
  return KINDS.flatMap((kind) => Object.values(server[kind] ?? {}).filter(isMcpFieldSecretMarker));
}

export function newMcpFieldSecretMarker(random: () => string): string {
  const marker = `${MCP_FIELD_SECRET_PREFIX}${random()}`;
  if (!isMcpFieldSecretMarker(marker)) throw new Error("Invalid MCP secret marker.");
  return marker;
}

export interface McpFieldSecretPlan {
  /** The record to store in config.json: every value is a marker. */
  server: McpServer;
  /** New marker → value entries to add to the server's secret record. */
  added: McpFieldSecretRecord;
  /** Markers kept from the submitted record; they must already be stored. */
  kept: { marker: string; field: string }[];
}

/**
 * Replace every plain-text env/header value with a fresh marker. Values that
 * are already markers are kept as they are (the renderer sends back the
 * marker of a value it did not replace).
 */
export function planMcpFieldSecrets(target: McpServer, random: () => string): McpFieldSecretPlan {
  const added: McpFieldSecretRecord = {};
  const kept: McpFieldSecretPlan["kept"] = [];
  const server: McpServer = { ...target };
  for (const kind of KINDS) {
    const fields = target[kind];
    if (!fields) continue;
    const entries = Object.entries(fields);
    if (entries.length > MCP_FIELD_SECRET_LIMITS.entries) {
      throw new Error(`An MCP server can have at most ${MCP_FIELD_SECRET_LIMITS.entries} ${kind === "env" ? "environment variables" : "headers"}.`);
    }
    const sealed: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (!name || name.length > MCP_FIELD_SECRET_LIMITS.nameChars) throw new Error(`MCP ${kind === "env" ? "environment variable" : "header"} names must have 1–${MCP_FIELD_SECRET_LIMITS.nameChars} characters.`);
      if (isMcpFieldSecretMarker(value)) {
        kept.push({ marker: value, field: fieldLabel(kind, name) });
        sealed[name] = value;
        continue;
      }
      if (value.length > MCP_FIELD_SECRET_LIMITS.valueChars) throw new Error(`The value of ${fieldLabel(kind, name)} is too long.`);
      const marker = newMcpFieldSecretMarker(random);
      added[marker] = value;
      sealed[name] = marker;
    }
    server[kind] = sealed;
  }
  return { server, added, kept };
}

/**
 * The current record as it would look had its plain-text values already been
 * sealed with this plan's markers. Comparing it with the plan's record tells a
 * pure move into the secrets store (same values, nothing to clean up) from a
 * real credential change.
 */
export function mcpFieldSecretCleanupBaseline(current: McpServer | undefined, plan: McpFieldSecretPlan): McpServer | undefined {
  if (!current) return current;
  const baseline: McpServer = { ...current };
  for (const kind of KINDS) {
    const fields = current[kind];
    const sealed = plan.server[kind];
    if (!fields || !sealed) continue;
    baseline[kind] = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
      const marker = sealed[name];
      return !isMcpFieldSecretMarker(value) && marker !== undefined && plan.added[marker] === value
        ? [name, marker]
        : [name, value];
    }));
  }
  return baseline;
}

/** Connection-ready copy: markers replaced by their stored values. Plain text (not yet moved) is used as is. */
export function resolveMcpFieldSecrets(server: McpServer, record: Readonly<McpFieldSecretRecord>): McpServer {
  const resolved: McpServer = { ...server };
  for (const kind of KINDS) {
    const fields = server[kind];
    if (!fields) continue;
    resolved[kind] = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
      if (!isMcpFieldSecretMarker(value)) return [name, value];
      const stored = Object.prototype.hasOwnProperty.call(record, value) ? record[value] : undefined;
      if (typeof stored !== "string") throw new McpFieldSecretMissingError(server.name || server.id, fieldLabel(kind, name));
      return [name, stored];
    }));
  }
  return resolved;
}

/** The record restricted to markers `server` still references; undefined when none remain. */
export function pruneMcpFieldSecretRecord(
  record: Readonly<McpFieldSecretRecord>,
  server: McpServer | undefined,
): McpFieldSecretRecord | undefined {
  const referenced = new Set(mcpFieldSecretMarkers(server));
  const kept = Object.fromEntries(Object.entries(record).filter(([marker]) => referenced.has(marker)));
  return Object.keys(kept).length ? kept : undefined;
}

export function parseMcpFieldSecretRecord(value: string | null): McpFieldSecretRecord {
  if (value === null) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid MCP secret record.");
  const record: McpFieldSecretRecord = {};
  for (const [marker, stored] of Object.entries(parsed)) {
    if (isMcpFieldSecretMarker(marker) && typeof stored === "string") record[marker] = stored;
  }
  return record;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * What a local (stdio) server will execute: command, arguments and each
 * environment variable's name with a hash of its configured value (a marker,
 * which changes with the value). Approval is bound to exactly this.
 */
export function mcpStdioLaunchFingerprint(server: McpServer): string {
  const env = Object.entries(server.env ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => [name, sha256(value)]);
  return sha256(JSON.stringify({ v: 1, id: server.id, command: server.command ?? "", args: server.args ?? [], env }));
}
