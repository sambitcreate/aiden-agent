import { createHash, randomBytes } from "node:crypto";
import {
  SLASH_LIMITS,
  SkillInvocationError,
  type SkillCatalogEntry,
} from "../../renderer/shared/slash-commands.js";
import {
  canonicalSkillIdentity,
  mintSkillInvocationId,
  projectSkillCatalogEntry,
  resolveSkillCandidates,
  SKILL_TOOL_NAME,
  skillToolKey,
  type ResolvedSkillCandidate,
  type SkillRegistryCandidate,
} from "./skill-registry-core.js";
import type { DiscoveredSkill, Skill, Workspace } from "./types.js";

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_CACHE_LIMIT = 50;

export interface RegisteredSkill extends ResolvedSkillCandidate {
  invocationId: string;
  toolKey: string;
}

export interface SkillRegistrySnapshot {
  workspaceId: string;
  workspaceRoot?: string;
  workspacePermission: Workspace["permission"];
  revision: string;
  /** Main-only content identity used to preserve leases across unchanged rescans. */
  fingerprint: string;
  catalog: readonly SkillCatalogEntry[];
  skills: readonly RegisteredSkill[];
  available: readonly RegisteredSkill[];
}

export interface SkillRegistryDependencies {
  listBuiltin(): Promise<SkillRegistryCandidate[]>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  isEnabled(): Promise<boolean>;
  listConfigured(): Promise<Skill[]>;
  discover(workspaceRoot?: string): Promise<DiscoveredSkill[]>;
  now(): number;
  invocationKey: Uint8Array;
  cacheTtlMs: number;
  cacheLimit: number;
  onInvalidate(): void;
}

export type SkillRegistryOptions = Pick<
  SkillRegistryDependencies,
  "getWorkspace" | "listConfigured" | "discover"
> &
  Partial<Omit<SkillRegistryDependencies, "getWorkspace" | "listConfigured" | "discover">>;

interface CacheEntry {
  expiresAt: number;
  workspaceRoot?: string;
  workspacePermission: Workspace["permission"];
  snapshot: Promise<SkillRegistrySnapshot>;
}

function configuredCandidate(skill: Skill): SkillRegistryCandidate {
  return {
    stableId: `configured:${skill.id}`,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    source: "configured",
    enabled: skill.enabled,
  };
}

function discoveredCandidate(
  skill: DiscoveredSkill,
  permission: Workspace["permission"],
): SkillRegistryCandidate {
  return {
    stableId: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    modelInvocable: skill.modelInvocable ?? true,
    userInvocable: skill.userInvocable ?? true,
    source: skill.source,
    enabled: true,
    path: skill.path,
    ...(skill.source === "workspace" && permission === "none"
      ? { blockedReason: "Workspace skills require workspace access." }
      : {}),
  };
}

function skillRegistryFingerprint(
  workspace: Pick<Workspace, "id" | "folderPath" | "permission">,
  candidates: readonly ResolvedSkillCandidate[],
): string {
  const hash = createHash("sha256");
  const field = (value: string | boolean | undefined) => {
    const bytes = Buffer.from(value === undefined ? "<undefined>" : String(value), "utf8");
    hash.update(String(bytes.byteLength), "ascii").update(":", "ascii").update(bytes);
  };
  field(workspace.id);
  field(workspace.folderPath);
  field(workspace.permission);
  for (const candidate of candidates) {
    field(candidate.stableId);
    field(candidate.name);
    field(candidate.description);
    field(candidate.instructions);
    field(candidate.modelInvocable ?? true);
    field(candidate.userInvocable ?? true);
    field(candidate.source);
    field(candidate.enabled);
    field(candidate.path);
    field(candidate.blockedReason);
    field(candidate.available);
    field(candidate.unavailableReason);
  }
  return hash.digest("base64url");
}

export class SkillRegistry {
  readonly #dependencies: SkillRegistryDependencies;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(dependencies: SkillRegistryOptions) {
    this.#dependencies = {
      isEnabled: async () => true,
      now: () => Date.now(),
      invocationKey: randomBytes(32),
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      cacheLimit: DEFAULT_CACHE_LIMIT,
      onInvalidate: () => {},
      listBuiltin: async () => [],
      ...dependencies,
    };
    if (this.#dependencies.invocationKey.byteLength < 32) {
      throw new Error("Skill registry invocation key must contain at least 32 bytes.");
    }
    if (this.#dependencies.cacheTtlMs <= 0 || this.#dependencies.cacheLimit <= 0) {
      throw new Error("Skill registry cache bounds must be positive.");
    }
  }

  async snapshot(workspaceId: string): Promise<SkillRegistrySnapshot> {
    if (!workspaceId || workspaceId.length > 256) {
      throw new SkillInvocationError("workspace_changed", "Invalid skill workspace.");
    }
    const workspace = await this.#dependencies.getWorkspace(workspaceId);
    if (!workspace || workspace.id !== workspaceId) {
      throw new SkillInvocationError("workspace_changed", "Skill workspace is unavailable.");
    }
    return this.snapshotResolved(workspace);
  }

  async snapshotResolved(
    workspace: Pick<Workspace, "id" | "folderPath" | "permission">,
  ): Promise<SkillRegistrySnapshot> {
    if (!workspace.id || workspace.id.length > 256) {
      throw new SkillInvocationError("workspace_changed", "Invalid skill workspace.");
    }
    // The global gate precedes cache reuse and all discovery/file reads.
    if (!(await this.#dependencies.isEnabled())) {
      this.invalidate(workspace.id);
      return this.#project(workspace, []);
    }
    const now = this.#dependencies.now();
    const cached = this.#cache.get(workspace.id);
    if (
      cached &&
      cached.expiresAt > now &&
      cached.workspaceRoot === workspace.folderPath &&
      cached.workspacePermission === workspace.permission
    ) {
      return cached.snapshot;
    }
    if (!cached && this.#cache.size >= this.#dependencies.cacheLimit) {
      const oldestWorkspaceId = this.#cache.keys().next().value as string | undefined;
      if (oldestWorkspaceId) this.#cache.delete(oldestWorkspaceId);
    }

    const snapshot = this.#load(workspace).catch((error) => {
      if (this.#cache.get(workspace.id)?.snapshot === snapshot) {
        this.#cache.delete(workspace.id);
      }
      throw error;
    });
    this.#cache.set(workspace.id, {
      expiresAt: now + this.#dependencies.cacheTtlMs,
      workspaceRoot: workspace.folderPath,
      workspacePermission: workspace.permission,
      snapshot,
    });
    return snapshot;
  }

  async catalog(workspaceId: string): Promise<readonly SkillCatalogEntry[]> {
    return (await this.snapshot(workspaceId)).catalog;
  }

  async resolve(workspaceId: string, invocationId: string): Promise<RegisteredSkill> {
    const snapshot = await this.snapshot(workspaceId);
    return this.#resolveFromSnapshot(snapshot, invocationId);
  }

  /** Bypass registry and discovery caches at the authoritative send boundary. */
  async resolveFresh(workspaceId: string, invocationId: string): Promise<RegisteredSkill> {
    if (!workspaceId || workspaceId.length > 256) {
      throw new SkillInvocationError("workspace_changed", "Invalid skill workspace.");
    }
    const workspace = await this.#dependencies.getWorkspace(workspaceId);
    if (!workspace || workspace.id !== workspaceId) {
      throw new SkillInvocationError("workspace_changed", "Skill workspace is unavailable.");
    }
    return this.#resolveFromSnapshot(await this.#load(workspace), invocationId);
  }

  #resolveFromSnapshot(snapshot: SkillRegistrySnapshot, invocationId: string): RegisteredSkill {
    const skill = snapshot.skills.find((candidate) => candidate.invocationId === invocationId);
    if (!skill) {
      throw new SkillInvocationError("invalid_reference", "Skill selection expired or changed.");
    }
    if (skill.userInvocable === false) {
      throw new SkillInvocationError("skill_unavailable", "This skill does not allow user invocation.");
    }
    if (!skill.available) {
      throw new SkillInvocationError(
        "skill_unavailable",
        skill.unavailableReason ?? "This skill is unavailable.",
      );
    }
    return skill;
  }

  invalidate(workspaceId?: string): void {
    const entries = workspaceId
      ? [this.#cache.get(workspaceId)].filter((entry): entry is CacheEntry => Boolean(entry))
      : [...this.#cache.values()];
    for (const entry of entries) entry.expiresAt = Number.NEGATIVE_INFINITY;
    this.#dependencies.onInvalidate();
  }

  async #load(
    workspace: Pick<Workspace, "id" | "folderPath" | "permission">,
  ): Promise<SkillRegistrySnapshot> {
    if (!(await this.#dependencies.isEnabled())) return this.#project(workspace, []);
    const [configured, discovered, builtin] = await Promise.all([
      this.#dependencies.listConfigured(),
      // No Access is also a discovery boundary: do not read workspace skill
      // files merely to mark them unavailable in a renderer catalog.
      this.#dependencies.discover(
        workspace.permission === "none" ? undefined : workspace.folderPath,
      ),
      this.#dependencies.listBuiltin(),
    ]);
    // A disable may race an in-flight disk scan. Never publish that snapshot.
    if (!(await this.#dependencies.isEnabled())) return this.#project(workspace, []);
    const resolved = resolveSkillCandidates([
      ...builtin,
      ...configured.map(configuredCandidate),
      ...discovered.map((skill) => discoveredCandidate(skill, workspace.permission)),
    ]);
    return this.#project(workspace, resolved);
  }

  #project(
    workspace: Pick<Workspace, "id" | "folderPath" | "permission">,
    resolved: readonly ResolvedSkillCandidate[],
  ): SkillRegistrySnapshot {
    const fingerprint = skillRegistryFingerprint(workspace, resolved);
    const revision = `rf_${fingerprint}`;
    const projectionContext = {
      workspaceId: workspace.id,
      registryRevision: revision,
      invocationKey: this.#dependencies.invocationKey,
    };
    const skills: RegisteredSkill[] = [];
    const projected: Array<{ entry: SkillCatalogEntry; available: boolean }> = [];
    const invocationIds = new Set<string>();
    for (const candidate of resolved) {
      try {
        const entry = projectSkillCatalogEntry(candidate, projectionContext);
        const invocationId = mintSkillInvocationId(projectionContext, candidate);
        if (invocationIds.has(invocationId)) continue;
        invocationIds.add(invocationId);
        skills.push({ ...candidate, invocationId, toolKey: skillToolKey(candidate) });
        if (candidate.userInvocable !== false) {
          projected.push({ entry, available: candidate.available });
        }
      } catch {
        // Unsafe local metadata is excluded from every registry consumer.
      }
    }
    const available = skills.filter((skill) => skill.available);
    const catalog = projected
      .sort((left, right) => Number(right.available) - Number(left.available))
      .slice(0, SLASH_LIMITS.catalogEntries)
      .map(({ entry }) => entry);
    return Object.freeze({
      workspaceId: workspace.id,
      workspaceRoot: workspace.folderPath,
      workspacePermission: workspace.permission,
      revision,
      fingerprint,
      catalog: Object.freeze(catalog),
      skills: Object.freeze(skills),
      available: Object.freeze(available),
    });
  }
}

function escapeSkillXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Drops built-in skills a surface cannot use (for example a desktop-only
 * tool's skill on a phone), keeping the prompt list, skill tools and
 * catalog in step.
 */
export function withoutSkills(
  snapshot: SkillRegistrySnapshot,
  stableIds: ReadonlySet<string>,
): SkillRegistrySnapshot {
  if (!snapshot.skills.some((skill) => stableIds.has(skill.stableId))) return snapshot;
  const skills = snapshot.skills.filter((skill) => !stableIds.has(skill.stableId));
  const invocationIds = new Set(skills.map(({ invocationId }) => invocationId));
  return Object.freeze({
    ...snapshot,
    catalog: Object.freeze(snapshot.catalog.filter(({ invocationId }) => invocationIds.has(invocationId))),
    skills: Object.freeze(skills),
    available: Object.freeze(snapshot.available.filter(({ invocationId }) => invocationIds.has(invocationId))),
  });
}

/** The skills the model may load: the prompt listing and the `skill` tool share this set. */
export function modelInvocableSkills(
  snapshot: SkillRegistrySnapshot,
  allowWorkspaceSkills = true,
): RegisteredSkill[] {
  return snapshot.available.filter(
    (skill) => skill.modelInvocable !== false && (allowWorkspaceSkills || skill.source !== "workspace"),
  );
}

/**
 * The skill the `skill` tool's `name` argument means: its listed name (any
 * case or Unicode form) or its internal tool key. Undefined when none matches.
 */
export function findSkillByName<T extends Pick<RegisteredSkill, "name" | "toolKey">>(
  skills: readonly T[],
  requested: string,
): T | undefined {
  const value = requested.trim();
  let canonical: string | undefined;
  try {
    canonical = canonicalSkillIdentity(value);
  } catch {
    canonical = undefined;
  }
  return skills.find((skill) => {
    if (skill.toolKey === value) return true;
    try {
      return canonical !== undefined && canonicalSkillIdentity(skill.name) === canonical;
    } catch {
      return false;
    }
  });
}

/** The internal key of the model-invocable skill `requested` names, if any. */
export function skillToolKeyForName(snapshot: SkillRegistrySnapshot, requested: string): string | undefined {
  return findSkillByName(modelInvocableSkills(snapshot), requested)?.toolKey;
}

export function formatAvailableSkills(
  snapshot: SkillRegistrySnapshot,
  allowedToolNames?: ReadonlySet<string>,
  allowWorkspaceSkills = true,
): string | undefined {
  if (allowedToolNames && !allowedToolNames.has(SKILL_TOOL_NAME)) return undefined;
  const available = modelInvocableSkills(snapshot, allowWorkspaceSkills);
  if (available.length === 0) return undefined;
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    `When a request matches a skill's description, call the ${SKILL_TOOL_NAME} tool with its name to load the instructions.`,
    "<available_skills>",
    ...available.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeSkillXml(skill.name)}</name>`,
      ...(skill.description
        ? [`    <description>${escapeSkillXml(skill.description)}</description>`]
        : []),
      `    <source>${skill.source}</source>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}
