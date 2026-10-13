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

/** Field (`env:NAME` / `headers:NAME`) → the stored value its marker resolves to. */
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
      if (existing !== undefined && isMcpFieldSecretMarker(existing) && own(options.reuse!.values, fieldKey(kind, name)) === value) {
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

export interface McpFieldSecretStage {
  /** The record to publish: the plan's, with a fresh marker for each value an editor rename moved. */
  server: McpServer;
  /** The secret record to write before publishing, or undefined when nothing needs writing. */
  record?: McpFieldSecretRecord;
}

/**
 * Stage a plan's values before its config is published. Writes are purely
 * additive: new markers, and new destination groups, appear next to the
 * existing ones; no entry the currently configured record can resolve is
 * changed or removed. So a failed or cancelled publication leaves the old
 * config fully usable, and cleanup after the commit (against the then
 * authoritative config) drops whatever is no longer referenced.
 *
 * Every kept marker must resolve for its own field. A value moves to another
 * address, command or field name only when the person did that in the
 * editor (`fromEditor`, with `current` the configured record they edited):
 * the value is copied (a renamed field gets a new marker), never rebound.
 * A marker the configured record already uses under a different name than
 * the one it was saved for (an outside edit) is never carried over.
 */
export function stageMcpFieldSecrets(
  record: McpFieldSecretRecord | undefined,
  plan: McpFieldSecretPlan,
  options: { fromEditor?: boolean; current?: McpServer; random: () => string },
): McpFieldSecretStage {
  const destination = mcpFieldSecretDestination(plan.server);
  const target = record ? own(record.bindings, destination) : undefined;
  const edited = options.fromEditor && options.current && record ? bindingFor(record, options.current) : undefined;
  const additions: Record<string, McpFieldSecretEntry> = {};
  const server: McpServer = { ...plan.server };
  for (const kind of KINDS) {
    const fields = plan.server[kind];
    if (!fields) continue;
    const staged: Record<string, string> = {};
    for (const [name, marker] of Object.entries(fields)) {
      staged[name] = marker;
      if (!isMcpFieldSecretMarker(marker) || own(plan.added, marker)) continue;
      const field = fieldKey(kind, name);
      const stored = (target && own(target, marker)) ?? (edited && own(edited, marker));
      if (!stored) {
        if (record && !target && Object.keys(record.bindings).length > 0 && !options.fromEditor) {
          throw new Error("This server’s address or command changed outside Aiden. Enter its header and environment values again.");
        }
        throw new Error(`The saved value for ${fieldLabel(kind, name)} is missing on this device. Enter it again.`);
      }
      if (stored.field === field) {
        // Same field: present in this destination already, or copied to the new one.
        if (!target || !own(target, marker)) additions[marker] = stored;
        continue;
      }
      // A field rename in the editor: the configured record must still hold the
      // marker under its own field, and the new record must not keep it there too.
      if (!options.fromEditor || !referencesUnder(options.current, marker, stored.field) || referencesUnder(plan.server, marker, stored.field)) {
        throw new Error(`The saved value for ${fieldLabel(kind, name)} was saved for another field. Enter it again.`);
      }
      const copy = newMcpFieldSecretMarker(options.random);
      additions[copy] = { field, value: stored.value };
      staged[name] = copy;
    }
    server[kind] = staged;
  }
  Object.assign(additions, plan.added);
  if (Object.keys(additions).length === 0) return { server };
  return { server, record: { bindings: { ...(record?.bindings ?? {}), [destination]: { ...(target ?? {}), ...additions } } } };
}

/** Whether `server` uses `marker` under `field` (`env:NAME` / `headers:NAME`). */
function referencesUnder(server: McpServer | undefined, marker: string, field: string): boolean {
  const separator = field.indexOf(":");
  const kind = field.slice(0, separator) as FieldKind;
  return server?.[kind]?.[field.slice(separator + 1)] === marker;
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

/** The stored value of one occurrence, only when its marker was saved for exactly this field. */
function occurrenceValue(binding: Readonly<Record<string, McpFieldSecretEntry>> | undefined, kind: FieldKind, name: string, marker: string): string | undefined {
  const entry = binding ? own(binding, marker) : undefined;
  return entry && entry.field === fieldKey(kind, name) ? entry.value : undefined;
}

/**
 * Field → stored value for each of the server's fields whose marker resolves
 * for that field. Every occurrence is checked on its own: a marker copied
 * under a second name resolves only where it was saved.
 */
export function mcpFieldSecretFieldValues(server: McpServer, record: Readonly<McpFieldSecretRecord> | undefined): McpFieldSecretValues {
  const binding = bindingFor(record, server);
  const values: McpFieldSecretValues = {};
  for (const kind of KINDS) {
    for (const [name, marker] of Object.entries(server[kind] ?? {})) {
      const value = isMcpFieldSecretMarker(marker) ? occurrenceValue(binding, kind, name, marker) : undefined;
      if (value !== undefined) values[fieldKey(kind, name)] = value;
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
  const values = mcpFieldSecretFieldValues(server, record);
  const resolved: McpServer = { ...server };
  for (const kind of KINDS) {
    const fields = server[kind];
    if (!fields) continue;
    resolved[kind] = Object.fromEntries(Object.entries(fields).map(([name, value]) => {
      if (!isMcpFieldSecretMarker(value)) return [name, value];
      const stored = own(values, fieldKey(kind, name));
      if (stored === undefined) throw new McpFieldSecretMissingError(server.name || server.id, fieldLabel(kind, name));
      return [name, stored];
    }));
  }
  return resolved;
}

/** Each env variable as a launch approval shows it: its value as written, saved (masked), or unusable. */
export function mcpEnvForApproval(server: McpServer, record: Readonly<McpFieldSecretRecord> | undefined): { name: string; value?: string; unavailable?: true }[] {
  const values = mcpFieldSecretFieldValues(server, record);
  return Object.entries(server.env ?? {}).map(([name, value]) =>
    !isMcpFieldSecretMarker(value) ? { name, value } : own(values, fieldKey("env", name)) !== undefined ? { name } : { name, unavailable: true as const });
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
  // Keep each entry some occurrence still resolves for its own field.
  const used = new Set<string>();
  for (const kind of KINDS) {
    for (const [name, marker] of Object.entries(server[kind] ?? {})) {
      if (isMcpFieldSecretMarker(marker) && occurrenceValue(binding, kind, name, marker) !== undefined) used.add(marker);
    }
  }
  const kept = Object.fromEntries(Object.entries(binding).filter(([marker]) => used.has(marker)));
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
 * Whether an observed config transition changed which env/header markers a
 * server references (or removed it), so its stored values must be pruned
 * against the new config even though no sign-in credential changed.
 */
export function mcpFieldSecretReferencesChanged(before: McpServer, after: McpServer | undefined): boolean {
  if (!after) return true;
  return KINDS.some((kind) => JSON.stringify(before[kind] ?? {}) !== JSON.stringify(after[kind] ?? {})) ||
    mcpFieldSecretDestination(before) !== mcpFieldSecretDestination(after);
}
