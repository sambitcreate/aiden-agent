// Custom MCP servers' env and header values live in the encrypted secrets
// store, never in the portable config.json. config.json keeps each name with
// an opaque marker (`aiden-secret:v1:<random>`); the server's secret record
// maps markers to values. A new marker is minted whenever a value is entered,
// so a changed value changes the server's credential snapshot (env/header map
// hashes) and therefore Bot grants, schedule bindings, leases and the
// credential-cleanup journal exactly as an edited plaintext value did.

import { createHash } from "node:crypto";
import type { McpServer } from "./types.js";
import {
  mcpCredentialConnectionSnapshot,
  sameMcpCredentialConnection,
  type McpCredentialConnectionSnapshot,
} from "./mcp-credential-cleanup-core.js";
import { MCP_FIELD_SECRET_PREFIX, isMcpFieldSecretMarker } from "../../renderer/shared/mcp-field-secrets.js";

export { MCP_FIELD_SECRET_PREFIX, isMcpFieldSecretMarker };

export const MCP_FIELD_SECRET_LIMITS = Object.freeze({ entries: 64, valueChars: 16_384, nameChars: 256 });

/** Marker → value (the values a record's current fields reference). */
export type McpFieldSecretValues = Record<string, string>;

/** One stored value and the field it was saved for (`env:NAME` or `headers:NAME`). */
export interface McpFieldSecretEntry {
  field: string;
  value: string;
}

/**
 * One server's stored values, grouped by where they may be sent: the
 * transport and URL (remote) or command and arguments (local). Only the
 * group matching the configured server is ever used, and each value only
 * under the field it was saved for. While an editor change of address or
 * command is being published, the old and new groups coexist, so a failed
 * publication leaves the still-configured address working; cleanup keeps
 * only the group the authoritative config points at.
 */
export interface McpFieldSecretRecord {
  bindings: Record<string, Record<string, McpFieldSecretEntry>>;
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

function fieldKey(kind: FieldKind, name: string): string {
  return `${kind}:${name}`;
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
  added: Record<string, McpFieldSecretEntry>;
  /** Markers kept from the submitted record; they must already be stored. */
  kept: { marker: string; field: string; label: string }[];
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
  const added: McpFieldSecretPlan["added"] = {};
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
        kept.push({ marker: value, field: fieldKey(kind, name), label: fieldLabel(kind, name) });
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
        kept.push({ marker: existing, field: fieldKey(kind, name), label: fieldLabel(kind, name) });
        sealed[name] = existing;
        continue;
      }
      const marker = newMcpFieldSecretMarker(random);
      added[marker] = { field: fieldKey(kind, name), value };
      sealed[name] = marker;
    }
    server[kind] = sealed;
  }
  return { server, added, kept };
}

/**
 * The secret record after storing `plan`, or undefined when nothing needs
 * writing. The plan's values go into the group for its destination; every
 * other group is left in place until cleanup (so a failed publication keeps
 * the still-configured address usable). Kept markers must already be stored
 * for this server under the same field (otherwise the value is gone, e.g.
 * config.json was copied from another device, and must be re-entered). Kept
 * values follow a changed address, command or field name only when the
 * person made that change in the editor (`fromEditor`, with `current` the
 * configured record they edited).
 */
export function nextMcpFieldSecretRecord(
  record: McpFieldSecretRecord | undefined,
  plan: McpFieldSecretPlan,
  options: { fromEditor?: boolean; current?: McpServer } = {},
): McpFieldSecretRecord | undefined {
  const destination = mcpFieldSecretDestination(plan.server);
  const target = record?.bindings[destination];
  const edited = options.fromEditor && options.current ? record?.bindings[mcpFieldSecretDestination(options.current)] : undefined;
  const group: Record<string, McpFieldSecretEntry> = { ...(target ?? {}) };
  let changed = Object.keys(plan.added).length > 0;
  for (const { marker, field, label } of plan.kept) {
    const entry = (target && own(target, marker)) ?? (edited && own(edited, marker));
    if (!entry) {
      if (record && !target && Object.keys(record.bindings).length > 0 && !options.fromEditor) {
        throw new Error("This server’s address or command changed outside Aiden. Enter its header and environment values again.");
      }
      throw new Error(`The saved value for ${label} is missing on this device. Enter it again.`);
    }
    if (entry.field !== field && !options.fromEditor) {
      throw new Error(`The saved value for ${label} was saved for another field. Enter it again.`);
    }
    if (!target || own(target, marker) !== entry || entry.field !== field) changed = true;
    group[marker] = { field, value: entry.value };
  }
  if (!changed) return undefined;
  return { bindings: { ...(record?.bindings ?? {}), [destination]: { ...group, ...plan.added } } };
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
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
      return !isMcpFieldSecretMarker(value) && marker !== undefined && plan.added[marker]?.value === value
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

/** The value group for the server's current destination, if any. */
function bindingFor(record: Readonly<McpFieldSecretRecord> | undefined, server: McpServer): Record<string, McpFieldSecretEntry> | undefined {
  return record ? own(record.bindings, mcpFieldSecretDestination(server)) : undefined;
}

/** Marker → value for every marker the server references under the field it was saved for. */
export function mcpFieldSecretValuesFor(server: McpServer, record: Readonly<McpFieldSecretRecord> | undefined): McpFieldSecretValues {
  const binding = bindingFor(record, server);
  const values: McpFieldSecretValues = {};
  if (!binding) return values;
  for (const kind of KINDS) {
    for (const [name, value] of Object.entries(server[kind] ?? {})) {
      const entry = isMcpFieldSecretMarker(value) ? own(binding, value) : undefined;
      if (entry && entry.field === fieldKey(kind, name)) values[value] = entry.value;
    }
  }
  return values;
}

/**
 * Connection-ready copy: markers replaced by their stored values. Plain text
 * (not yet moved) is used as is. Values are never sent to a destination other
 * than the one they were saved for, nor under a field other than the one they
 * were saved for (a hand edit moving a marker to another name gets nothing).
 */
export function resolveMcpFieldSecrets(server: McpServer, record: Readonly<McpFieldSecretRecord> | undefined): McpServer {
  if (mcpFieldSecretMarkers(server).length === 0) return server;
  const binding = bindingFor(record, server);
  if (!binding && record && Object.keys(record.bindings).length > 0) {
    throw new McpFieldSecretDestinationError(server.name || server.id);
  }
  const values = mcpFieldSecretValuesFor(server, record);
  const resolved: McpServer = { ...server };
  for (const kind of KINDS) {
    const fields = server[kind];
    if (!fields) continue;
    resolved[kind] = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
      if (!isMcpFieldSecretMarker(value)) return [name, value];
      const stored = own(values, value);
      if (stored === undefined) throw new McpFieldSecretMissingError(server.name || server.id, fieldLabel(kind, name));
      return [name, stored];
    }));
  }
  return resolved;
}

/** Each env variable as a launch approval shows it: its value as written, saved (masked), or unusable. */
export function mcpEnvForApproval(server: McpServer, record: Readonly<McpFieldSecretRecord> | undefined): { name: string; value?: string; unavailable?: true }[] {
  const values = mcpFieldSecretValuesFor(server, record);
  return Object.entries(server.env ?? {}).map(([name, value]) =>
    !isMcpFieldSecretMarker(value) ? { name, value } : own(values, value) !== undefined ? { name } : { name, unavailable: true as const });
}

/**
 * The record keeping only the group for the configured server's destination,
 * restricted to values it still references under their own field; undefined
 * when nothing remains or the server is gone. A group for another address or
 * command (an external edit, or an editor change whose publication never
 * committed) is dropped; the group the authoritative config points at is kept.
 */
export function pruneMcpFieldSecretRecord(
  record: Readonly<McpFieldSecretRecord>,
  server: McpServer | undefined,
): McpFieldSecretRecord | undefined {
  if (!server) return undefined;
  const destination = mcpFieldSecretDestination(server);
  const binding = own(record.bindings, destination);
  if (!binding) return undefined;
  const values = mcpFieldSecretValuesFor(server, record);
  const kept = Object.fromEntries(Object.entries(binding).filter(([marker]) => own(values, marker) !== undefined));
  return Object.keys(kept).length ? { bindings: { [destination]: kept } } : undefined;
}

/** Undefined when nothing (or nothing usable) is stored. */
export function parseMcpFieldSecretRecord(value: string | null): McpFieldSecretRecord | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid MCP secret record.");
  const { v, bindings: raw } = parsed as { v?: unknown; bindings?: unknown };
  if (v !== 2 || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const bindings: McpFieldSecretRecord["bindings"] = {};
  for (const [destination, group] of Object.entries(raw)) {
    if (!/^[a-f0-9]{64}$/u.test(destination) || !group || typeof group !== "object" || Array.isArray(group)) continue;
    const entries: Record<string, McpFieldSecretEntry> = {};
    for (const [marker, entry] of Object.entries(group)) {
      const { field, value: stored } = (entry ?? {}) as { field?: unknown; value?: unknown };
      if (isMcpFieldSecretMarker(marker) && typeof field === "string" && /^(?:env|headers):/u.test(field) && typeof stored === "string") {
        entries[marker] = { field, value: stored };
      }
    }
    bindings[destination] = entries;
  }
  return { bindings };
}

export function serializeMcpFieldSecretRecord(record: McpFieldSecretRecord): string {
  return JSON.stringify({ v: 2, bindings: record.bindings });
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

/**
 * When `plan` only moves `current`'s unchanged plain-text values into the
 * keychain, the credential snapshots before and after (they differ only in
 * marker hashes). Undefined for a real credential change or no change.
 */
export function mcpFieldSecretSealingTransition(
  current: McpServer | undefined,
  plan: McpFieldSecretPlan,
): { from: McpCredentialConnectionSnapshot; to: McpCredentialConnectionSnapshot } | undefined {
  const baseline = mcpFieldSecretCleanupBaseline(current, plan);
  if (!current || !baseline) return undefined;
  const from = mcpCredentialConnectionSnapshot(current);
  const to = mcpCredentialConnectionSnapshot(plan.server);
  if (sameMcpCredentialConnection(from, to) || !sameMcpCredentialConnection(mcpCredentialConnectionSnapshot(baseline), to)) return undefined;
  return { from, to };
}
