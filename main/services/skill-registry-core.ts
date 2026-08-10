import { createHash, createHmac } from "node:crypto";
import {
  SLASH_LIMITS,
  SkillInvocationError,
  normalizeSafeSkillText,
  parseSkillCatalog,
  type SkillCatalogEntry,
  type SkillSource,
} from "../../renderer/shared/slash-commands.js";

export interface SkillRegistryCandidate {
  stableId: string;
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  enabled: boolean;
  path?: string;
  blockedReason?: string;
}

export interface ResolvedSkillCandidate extends SkillRegistryCandidate {
  available: boolean;
  unavailableReason?: string;
}

export interface SkillCatalogProjectionContext {
  workspaceId: string;
  registryRevision: string;
  invocationKey: Uint8Array;
}

const SOURCE_PRECEDENCE: Record<SkillSource, number> = {
  configured: 0,
  workspace: 1,
  global: 2,
};

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalSkillIdentity(value: string): string {
  return normalizeSafeSkillText(value, "skill name", SLASH_LIMITS.safeNameCharacters)
    .normalize("NFKC")
    .toLowerCase();
}

function toolSlug(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function skillToolKey(candidate: Pick<SkillRegistryCandidate, "name" | "stableId">): string {
  const slug = toolSlug(candidate.name);
  const fallback = createHash("sha256")
    .update(candidate.stableId, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `skill_${slug || `unnamed_${fallback}`}`;
}

/** Mirrors the model-facing tool namespace and also claims the visible-name identity. */
export function skillCollisionKeys(candidate: SkillRegistryCandidate): readonly string[] {
  const name = canonicalSkillIdentity(candidate.name);
  return [`name:${name}`, `tool:${skillToolKey(candidate)}`];
}

function instructionBytes(candidate: SkillRegistryCandidate): number {
  return Buffer.byteLength(candidate.instructions, "utf8");
}

/**
 * One deterministic winner across both display-name and tool-key collisions.
 * Configured beats workspace, workspace beats global, and stable ID breaks
 * same-source ties. Duplicate stable IDs fail closed instead of aliasing.
 */
export function resolveSkillCandidates(
  candidates: readonly SkillRegistryCandidate[],
): ResolvedSkillCandidate[] {
  const ordered = [...candidates].sort(
    (left, right) =>
      SOURCE_PRECEDENCE[left.source] - SOURCE_PRECEDENCE[right.source] ||
      compareStable(left.stableId, right.stableId) ||
      compareStable(left.name, right.name) ||
      compareStable(left.description, right.description),
  );
  const stableIdCounts = new Map<string, number>();
  for (const candidate of ordered) {
    stableIdCounts.set(candidate.stableId, (stableIdCounts.get(candidate.stableId) ?? 0) + 1);
  }

  const claims = new Map<string, SkillRegistryCandidate>();
  const outcomes = new Map<SkillRegistryCandidate, ResolvedSkillCandidate>();
  for (const candidate of ordered) {
    let safeCandidate: SkillRegistryCandidate;
    try {
      safeCandidate = {
        ...candidate,
        name: normalizeSafeSkillText(candidate.name, "skill name", SLASH_LIMITS.safeNameCharacters),
        description: normalizeSafeSkillText(
          candidate.description,
          "skill description",
          SLASH_LIMITS.safeDescriptionCharacters,
          true,
        ),
      };
    } catch {
      outcomes.set(candidate, {
        ...candidate,
        name: "Invalid skill",
        description: "",
        available: false,
        unavailableReason: "Skill metadata contains unsafe characters or exceeds its limit.",
      });
      continue;
    }
    if ((stableIdCounts.get(candidate.stableId) ?? 0) > 1) {
      outcomes.set(candidate, {
        ...safeCandidate,
        available: false,
        unavailableReason: "Duplicate internal skill identity.",
      });
      continue;
    }
    if (candidate.blockedReason) {
      outcomes.set(candidate, {
        ...safeCandidate,
        available: false,
        unavailableReason: candidate.blockedReason,
      });
      continue;
    }
    if (!candidate.enabled) {
      outcomes.set(candidate, {
        ...safeCandidate,
        available: false,
        unavailableReason: "Disabled in Skills settings.",
      });
      continue;
    }
    if (instructionBytes(candidate) > SLASH_LIMITS.instructionBytes) {
      outcomes.set(candidate, {
        ...safeCandidate,
        available: false,
        unavailableReason: "Skill instructions exceed Aiden’s safety limit.",
      });
      continue;
    }
    let keys: readonly string[];
    try {
      keys = skillCollisionKeys(safeCandidate);
    } catch {
      outcomes.set(candidate, {
        ...safeCandidate,
        available: false,
        unavailableReason: "Skill metadata contains unsafe characters.",
      });
      continue;
    }
    const winner = keys.map((key) => claims.get(key)).find(Boolean);
    if (winner) {
      outcomes.set(candidate, {
        ...safeCandidate,
        available: false,
        unavailableReason: `Shadowed by ${winner.source} skill “${winner.name}”.`,
      });
      continue;
    }
    for (const key of keys) claims.set(key, safeCandidate);
    outcomes.set(candidate, { ...safeCandidate, available: true });
  }
  return ordered.map((candidate) => outcomes.get(candidate)!);
}

export function mintSkillInvocationId(
  context: SkillCatalogProjectionContext,
  candidate: Pick<SkillRegistryCandidate, "source" | "stableId" | "name">,
): string {
  if (context.invocationKey.byteLength < 32 || !context.workspaceId || !context.registryRevision) {
    throw new SkillInvocationError("invalid_reference", "Invalid skill registry identity context.");
  }
  const digest = createHmac("sha256", context.invocationKey)
    .update("aiden-skill-invocation-v1\0", "utf8")
    .update(context.workspaceId, "utf8")
    .update("\0", "utf8")
    .update(context.registryRevision, "utf8")
    .update("\0", "utf8")
    .update(candidate.source, "utf8")
    .update("\0", "utf8")
    .update(candidate.stableId, "utf8")
    .update("\0", "utf8")
    .update(canonicalSkillIdentity(candidate.name), "utf8")
    .digest("base64url");
  return `sk1_${digest}`;
}

/** Exact projector: internal instructions, paths, tool keys, and unknown fields cannot cross IPC. */
export function projectSkillCatalogEntry(
  candidate: ResolvedSkillCandidate,
  context: SkillCatalogProjectionContext,
): SkillCatalogEntry {
  const entry: SkillCatalogEntry = {
    invocationId: mintSkillInvocationId(context, candidate),
    name: normalizeSafeSkillText(candidate.name, "skill name", SLASH_LIMITS.safeNameCharacters),
    description: normalizeSafeSkillText(
      candidate.description,
      "skill description",
      SLASH_LIMITS.safeDescriptionCharacters,
      true,
    ),
    source: candidate.source,
    available: candidate.available,
    ...(candidate.available
      ? {}
      : {
          unavailableReason: normalizeSafeSkillText(
            candidate.unavailableReason ?? "Unavailable.",
            "skill unavailable reason",
            SLASH_LIMITS.unavailableReasonCharacters,
          ),
        }),
  };
  return entry;
}

export function projectSkillCatalog(
  candidates: readonly ResolvedSkillCandidate[],
  context: SkillCatalogProjectionContext,
): SkillCatalogEntry[] {
  const projected: SkillCatalogEntry[] = [];
  const invocationIds = new Set<string>();
  for (const candidate of candidates) {
    if (projected.length === SLASH_LIMITS.catalogEntries) break;
    try {
      const entry = projectSkillCatalogEntry(candidate, context);
      if (invocationIds.has(entry.invocationId)) continue;
      invocationIds.add(entry.invocationId);
      projected.push(entry);
    } catch {
      // Unsafe local metadata is omitted rather than reflected into the renderer.
    }
  }
  return parseSkillCatalog(projected);
}
