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

/** Marker → value. */
export type McpFieldSecretValues = Record<string, string>;

/**
 * One server's stored values, bound to where they may be sent: the transport
 * and URL (remote) or command and arguments (local). A record whose
 * destination no longer matches the configured server is never used.
 */
export interface McpFieldSecretRecord {
  destination: string;
  values: McpFieldSecretValues;
}

export class McpFieldSecretDestinationError extends Error {
  constructor(readonly serverName: string) {
    super(`The address or command of “${serverName}” changed outside Aiden, so its saved header and environment values were not sent. Enter them again in Settings → Plugins.`);
  }
}

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
  /** The record to store in config.json: every value is a marker (env stays as typed when `sealEnv` is false). */
  server: McpServer;
  /** New marker → value entries to add to the server's secret record. */
  added: McpFieldSecretValues;
  /** Markers kept from the submitted record; they must already be stored. */
  kept: { marker: string; field: string }[];
}

export interface McpFieldSecretPlanOptions {
  /**
   * The configured record and its stored values: a submitted plain-text value
   * equal to the stored value of the same name keeps that name's marker, so a
   * stale renderer copy never looks like a new credential.
   */
  reuse?: { current: McpServer | undefined; values: Readonly<McpFieldSecretValues> };
  /** False keeps env values as written (a local server not yet approved, whose env must stay reviewable). */
  sealEnv?: boolean;
}

/**
 * Replace every plain-text env/header value with a marker. Values that are
 * already markers are kept as they are (the renderer sends back the marker of
 * a value it did not replace).
 */
export function planMcpFieldSecrets(target: McpServer, random: () => string, options: McpFieldSecretPlanOptions = {}): McpFieldSecretPlan {
  const added: McpFieldSecretValues = {};
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
      if (kind === "env" && options.sealEnv === false) {
        sealed[name] = value;
        continue;
      }
      const existing = options.reuse?.current?.[kind]?.[name];
      if (existing !== undefined && isMcpFieldSecretMarker(existing) && options.reuse!.values[existing] === value) {
        kept.push({ marker: existing, field: fieldLabel(kind, name) });
        sealed[name] = existing;
        continue;
      }
      const marker = newMcpFieldSecretMarker(random);
      added[marker] = value;
      sealed[name] = marker;
    }
    server[kind] = sealed;
  }
  return { server, added, kept };
}

/**
 * The secret record after storing `plan`, bound to the plan's destination, or
 * undefined when nothing needs writing. Kept markers must already be stored
 * for this server (otherwise the value is gone, e.g. config.json was copied
 * from another device). Kept values follow a changed address or command only
 * when the person changed it in the editor (`allowNewDestination`).
 */
export function nextMcpFieldSecretRecord(
  record: McpFieldSecretRecord | undefined,
  plan: McpFieldSecretPlan,
  options: { allowNewDestination?: boolean } = {},
): McpFieldSecretRecord | undefined {
  const destination = mcpFieldSecretDestination(plan.server);
  const sameDestination = record?.destination === destination;
  const reusable = record && (sameDestination || options.allowNewDestination) ? record.values : undefined;
  if (plan.kept.length > 0) {
    if (record && !reusable) {
      throw new Error("This server’s address or command changed outside Aiden. Enter its header and environment values again.");
    }
    const missing = plan.kept.find(({ marker }) => !reusable || !Object.prototype.hasOwnProperty.call(reusable, marker));
    if (missing) throw new Error(`The saved value for ${missing.field} is missing on this device. Enter it again.`);
  }
  if (Object.keys(plan.added).length === 0 && (sameDestination || plan.kept.length === 0)) return undefined;
  return { destination, values: { ...(reusable ?? {}), ...plan.added } };
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Where a server's stored values may be sent. */
export function mcpFieldSecretDestination(server: McpServer): string {
  return sha256(JSON.stringify(server.transport === "stdio"
    ? { v: 1, id: server.id, transport: "stdio", command: server.command ?? "", args: server.args ?? [] }
    : { v: 1, id: server.id, transport: server.transport, url: server.url ?? "" }));
}

/**
 * Connection-ready copy: markers replaced by their stored values. Plain text
 * (not yet moved) is used as is. Values are never sent to a destination other
 * than the one they were saved for.
 */
export function resolveMcpFieldSecrets(server: McpServer, record: Readonly<McpFieldSecretRecord> | undefined): McpServer {
  if (mcpFieldSecretMarkers(server).length === 0) return server;
  if (record && record.destination !== mcpFieldSecretDestination(server)) {
    throw new McpFieldSecretDestinationError(server.name || server.id);
  }
  const values = record?.values ?? {};
  const resolved: McpServer = { ...server };
  for (const kind of KINDS) {
    const fields = server[kind];
    if (!fields) continue;
    resolved[kind] = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
      if (!isMcpFieldSecretMarker(value)) return [name, value];
      const stored = Object.prototype.hasOwnProperty.call(values, value) ? values[value] : undefined;
      if (typeof stored !== "string") throw new McpFieldSecretMissingError(server.name || server.id, fieldLabel(kind, name));
      return [name, stored];
    }));
  }
  return resolved;
}

/**
 * The record restricted to markers `server` still references; undefined when
 * none remain, the server is gone, or its destination changed (values never
 * follow a server to a new address or command).
 */
export function pruneMcpFieldSecretRecord(
  record: Readonly<McpFieldSecretRecord>,
  server: McpServer | undefined,
): McpFieldSecretRecord | undefined {
  if (!server || record.destination !== mcpFieldSecretDestination(server)) return undefined;
  const referenced = new Set(mcpFieldSecretMarkers(server));
  const values = Object.fromEntries(Object.entries(record.values).filter(([marker]) => referenced.has(marker)));
  return Object.keys(values).length ? { destination: record.destination, values } : undefined;
}

/** Undefined when nothing (or nothing usable) is stored. */
export function parseMcpFieldSecretRecord(value: string | null): McpFieldSecretRecord | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid MCP secret record.");
  const { v, destination, values: raw } = parsed as { v?: unknown; destination?: unknown; values?: unknown };
  if (v !== 1 || typeof destination !== "string" || !/^[a-f0-9]{64}$/u.test(destination) || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const values: McpFieldSecretValues = {};
  for (const [marker, stored] of Object.entries(raw)) {
    if (isMcpFieldSecretMarker(marker) && typeof stored === "string") values[marker] = stored;
  }
  return { destination, values };
}

export function serializeMcpFieldSecretRecord(record: McpFieldSecretRecord): string {
  return JSON.stringify({ v: 1, destination: record.destination, values: record.values });
}

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
