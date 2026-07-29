import type { WorkspacePermission } from "../types.js";

export const SUBAGENT_ROLES = ["scout", "planner", "reviewer"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const SUBAGENT_READ_TOOL_NAMES = ["read_file", "list_dir", "glob", "grep"] as const;
export type SubagentReadToolName = (typeof SUBAGENT_READ_TOOL_NAMES)[number];

const ROLE_TOOL_POLICY: Readonly<Record<SubagentRole, readonly SubagentReadToolName[]>> = {
  scout: SUBAGENT_READ_TOOL_NAMES,
  planner: SUBAGENT_READ_TOOL_NAMES,
  reviewer: SUBAGENT_READ_TOOL_NAMES,
};

export interface SubagentCapabilityRequest {
  kind: "subagent";
  /** Kept as a string at the boundary so stale or hostile role values fail closed at runtime. */
  role: string;
  /** Optional narrower feature rollout policy. Unknown names never gain authority. */
  featurePolicy?: readonly string[];
  /** Authority inherited from the parent/supervisor; omission means the V1 read-only ceiling. */
  inheritedCeiling?: readonly string[];
}

export interface ResolvedCapabilityProfile {
  kind: "subagent";
  role: SubagentRole;
  tools: readonly SubagentReadToolName[];
}

export function isSubagentRole(role: string): role is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(role);
}

/** Preserve any per-generation tool exclusions as a positive child ceiling. */
export function inheritedSubagentReadToolCeiling(
  excludedToolNames: ReadonlySet<string> | undefined,
): readonly SubagentReadToolName[] {
  return SUBAGENT_READ_TOOL_NAMES.filter((name) => !excludedToolNames?.has(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringArray(
  value: unknown,
  field: "featurePolicy" | "inheritedCeiling",
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Invalid subagent capability ${field}.`);
  }
  return value;
}

export function parseSubagentCapabilityRequest(input: unknown): SubagentCapabilityRequest {
  if (!isRecord(input) || input.kind !== "subagent" || typeof input.role !== "string") {
    throw new Error("Invalid subagent capability profile.");
  }
  const allowedKeys = new Set(["kind", "role", "featurePolicy", "inheritedCeiling"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid subagent capability profile fields.");
  }
  return {
    kind: "subagent",
    role: input.role,
    featurePolicy: optionalStringArray(input.featurePolicy, "featurePolicy"),
    inheritedCeiling: optionalStringArray(input.inheritedCeiling, "inheritedCeiling"),
  };
}

function knownToolSet(values: readonly string[]): ReadonlySet<SubagentReadToolName> {
  const known = new Set<SubagentReadToolName>();
  for (const name of values) {
    if ((SUBAGENT_READ_TOOL_NAMES as readonly string[]).includes(name)) {
      known.add(name as SubagentReadToolName);
    }
  }
  return known;
}

/** Resolve the positive intersection before constructing any AgentTool object. */
export function resolveCapabilityProfile(
  request: SubagentCapabilityRequest,
  parentPermission: WorkspacePermission,
): ResolvedCapabilityProfile {
  if (!["full", "ask", "none"].includes(parentPermission)) {
    throw new Error("Invalid parent workspace permission for subagent capabilities.");
  }
  if (request.kind !== "subagent") {
    throw new Error("Invalid subagent capability profile kind.");
  }
  if (!isSubagentRole(request.role)) {
    throw new Error("Unknown subagent role.");
  }
  if (parentPermission === "none") {
    return { kind: "subagent", role: request.role, tools: [] };
  }

  const roleTools = new Set(ROLE_TOOL_POLICY[request.role]);
  const featureTools = knownToolSet(request.featurePolicy ?? SUBAGENT_READ_TOOL_NAMES);
  const inheritedTools = knownToolSet(request.inheritedCeiling ?? SUBAGENT_READ_TOOL_NAMES);
  return {
    kind: "subagent",
    role: request.role,
    tools: SUBAGENT_READ_TOOL_NAMES.filter(
      (name) => roleTools.has(name) && featureTools.has(name) && inheritedTools.has(name),
    ),
  };
}
