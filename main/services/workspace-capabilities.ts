// Per-workspace off-lists for skills and connectors (MCP servers).
//
// A workspace inherits everything that is on in Settings and may switch
// individual skills and connectors off for its own chats. Bots keep their own
// grants and never read these lists. An omitted list means nothing is off.

import { canonicalSkillIdentity } from "./skill-registry-core.js";
import type { McpServer, Workspace } from "./types.js";

/** Upper bound on each stored off-list; far above any real configuration. */
export const WORKSPACE_OFF_LIST_LIMIT = 500;
const MAX_ENTRY_LENGTH = 256;

export type WorkspaceCapabilityFields = Pick<Workspace, "disabledSkills" | "disabledMcpServerIds">;

/**
 * Cleans a stored or renderer-supplied off-list: strings only, trimmed,
 * de-duplicated, bounded and sorted so equal lists compare equal. Anything
 * else becomes "nothing is off" rather than invalidating the workspace.
 */
export function normalizeWorkspaceOffList(
  value: unknown,
  canonicalize: (entry: string) => string = (entry) => entry,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_ENTRY_LENGTH) continue;
    let entry: string;
    try {
      entry = canonicalize(trimmed);
    } catch {
      continue;
    }
    if (entry) entries.add(entry);
    if (entries.size >= WORKSPACE_OFF_LIST_LIMIT) break;
  }
  return entries.size > 0 ? [...entries].sort() : undefined;
}

export function normalizeDisabledSkills(value: unknown): string[] | undefined {
  return normalizeWorkspaceOffList(value, canonicalSkillIdentity);
}

export function normalizeDisabledMcpServerIds(value: unknown): string[] | undefined {
  return normalizeWorkspaceOffList(value);
}

/** Copies only the off-lists that hold entries, for spreading into a record. */
export function workspaceCapabilityFields(
  value: { disabledSkills?: unknown; disabledMcpServerIds?: unknown },
): WorkspaceCapabilityFields {
  const disabledSkills = normalizeDisabledSkills(value.disabledSkills);
  const disabledMcpServerIds = normalizeDisabledMcpServerIds(value.disabledMcpServerIds);
  return {
    ...(disabledSkills ? { disabledSkills } : {}),
    ...(disabledMcpServerIds ? { disabledMcpServerIds } : {}),
  };
}

export function sameWorkspaceOffList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** True when the workspace switched this skill (by name) off for its chats. */
export function workspaceSkillOff(
  workspace: Pick<Workspace, "disabledSkills"> | undefined,
  skillName: string,
): boolean {
  if (!workspace?.disabledSkills?.length) return false;
  let identity: string;
  try {
    identity = canonicalSkillIdentity(skillName);
  } catch {
    return false;
  }
  return workspace.disabledSkills.includes(identity);
}

/** Drops connectors this workspace switched off; order is preserved. */
export function withoutWorkspaceDisabledMcpServers<T extends Pick<McpServer, "id">>(
  servers: readonly T[],
  disabledMcpServerIds: readonly string[] | undefined,
): T[] {
  if (!disabledMcpServerIds?.length) return [...servers];
  const off = new Set(disabledMcpServerIds);
  return servers.filter((server) => !off.has(server.id));
}
