import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { WorkspacePermission } from "../types.js";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import { parseSubagentToolRequest, type SubagentTaskRequest } from "./contracts.js";

export const SUBAGENT_AUTHORITY_VERSION = 2 as const;
export const MAX_SUBAGENT_MCP_SCOPES = 16;
export const MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE = 32;
export const MAX_SUBAGENT_TREE_DEPTH = 2;

export type SubagentExecutionModeV2 = "foreground" | "background";
export type SubagentContextModeV2 = "fresh" | "fork";

export type SubagentMcpEffectV2 = "read" | "mutating";

export type SubagentMcpMutationClassificationV2 = "declared_mutating" | "unproven_mutating";
export type SubagentMcpDestructiveProfileV2 = "destructive" | "additive" | "unknown";
export type SubagentMcpIdempotencyProfileV2 = "idempotent" | "not_declared";
export type SubagentMcpOpenWorldProfileV2 = "open" | "closed" | "unknown";
export type SubagentMcpTaskSupportV2 = "forbidden" | "optional";

export interface SubagentMcpMutationEffectProfileV2 {
  classification: SubagentMcpMutationClassificationV2;
  destructive: SubagentMcpDestructiveProfileV2;
  idempotency: SubagentMcpIdempotencyProfileV2;
  openWorld: SubagentMcpOpenWorldProfileV2;
  taskSupport: SubagentMcpTaskSupportV2;
  fingerprint: string;
}

interface SubagentMcpToolScopeBaseV2 {
  toolName: string;
  schemaHash: string;
}

export type SubagentMcpToolScopeV2 =
  | (SubagentMcpToolScopeBaseV2 & { effect: "read" })
  | (SubagentMcpToolScopeBaseV2 & {
      effect: "mutating";
      effectProfile: SubagentMcpMutationEffectProfileV2;
    });

export interface SubagentMcpScopeV2 {
  serverId: string;
  connectionFingerprint: string;
  tools: readonly SubagentMcpToolScopeV2[];
}

export interface SubagentCapabilitySetV2 {
  workspaceRead: boolean;
  workspaceWrite: boolean;
  shell: boolean;
  web: boolean;
  delegation: boolean;
  mcp: readonly SubagentMcpScopeV2[];
}

export interface SubagentBudgetV2 {
  deadlineMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxOutputChars: number;
  maxTokens: number;
  maxLaunches: number;
  maxDepth: number;
  maxActive: number;
  maxQueued: number;
  maxNetworkOperations: number;
}

export interface SubagentLaunchRequestV2 {
  version: typeof SUBAGENT_AUTHORITY_VERSION;
  execution: SubagentExecutionModeV2;
  context: SubagentContextModeV2;
  capabilities: SubagentCapabilitySetV2;
  limits: SubagentBudgetV2;
  tasks: SubagentTaskRequest[];
}

export interface SubagentRolloutPolicyV2 {
  background: boolean;
  fork: boolean;
  workspaceWrite: boolean;
  shell: boolean;
  web: boolean;
  mcp: boolean;
  delegation: boolean;
}

export interface SubagentAuthorityV2 {
  readonly version: typeof SUBAGENT_AUTHORITY_VERSION;
  readonly grantId: string;
  readonly treeRootId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
  readonly authorityRevision: number;
  readonly generationId: string;
  readonly chatId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: string;
  readonly ownerDocumentId: string;
  readonly providerFingerprint: string;
  readonly modelFingerprint: string;
  readonly contextRevision: string;
  readonly execution: SubagentExecutionModeV2;
  readonly context: SubagentContextModeV2;
  readonly thinkingLevel: ThinkingLevel;
  readonly capabilities: SubagentCapabilitySetV2;
  readonly budgets: SubagentBudgetV2;
  readonly expiresAt: number;
}

export function subagentAuthorityDigestV2(authority: SubagentAuthorityV2): string {
  return createHash("sha256")
    .update("aiden-subagent-authority-v2\0", "utf8")
    .update(JSON.stringify(authority), "utf8")
    .digest("hex");
}

export interface ResolveSubagentCapabilitiesV2Input {
  requested: SubagentCapabilitySetV2;
  root: SubagentCapabilitySetV2;
  parent: SubagentCapabilitySetV2;
  role: SubagentCapabilitySetV2;
  rollout: SubagentRolloutPolicyV2;
  userGrant: SubagentCapabilitySetV2;
  workspacePermission: WorkspacePermission;
  /** Combined consent mode. `per_call` requires the main-owned exact approval broker. */
  workspaceEgressApproval: "unavailable" | "per_call";
}

export interface CreateSubagentAuthorityV2Input {
  grantId: string;
  treeRootId: string;
  runId: string;
  parentRunId?: string;
  depth: number;
  authorityRevision: number;
  generationId: string;
  chatId: string;
  workspaceId: string;
  workspaceRevision: string;
  ownerDocumentId: string;
  providerFingerprint: string;
  modelFingerprint: string;
  contextRevision: string;
  execution: SubagentExecutionModeV2;
  context: SubagentContextModeV2;
  thinkingLevel: ThinkingLevel;
  capabilities: SubagentCapabilitySetV2;
  budgets: SubagentBudgetV2;
  expiresAt: number;
}

const EXECUTION_MODES = new Set<SubagentExecutionModeV2>(["foreground", "background"]);
const CONTEXT_MODES = new Set<SubagentContextModeV2>(["fresh", "fork"]);
const MCP_EFFECTS = new Set<SubagentMcpEffectV2>(["read", "mutating"]);
const EXACT_FINGERPRINT = /^[a-f0-9]{64}$/u;
const MUTATION_CLASSIFICATIONS = new Set<SubagentMcpMutationClassificationV2>([
  "declared_mutating",
  "unproven_mutating",
]);
const DESTRUCTIVE_PROFILES = new Set<SubagentMcpDestructiveProfileV2>([
  "destructive",
  "additive",
  "unknown",
]);
const IDEMPOTENCY_PROFILES = new Set<SubagentMcpIdempotencyProfileV2>([
  "idempotent",
  "not_declared",
]);
const OPEN_WORLD_PROFILES = new Set<SubagentMcpOpenWorldProfileV2>(["open", "closed", "unknown"]);
const TASK_SUPPORT_PROFILES = new Set<SubagentMcpTaskSupportV2>(["forbidden", "optional"]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const CAPABILITY_KEYS = [
  "workspaceRead",
  "workspaceWrite",
  "shell",
  "web",
  "delegation",
  "mcp",
] as const;
const BUDGET_KEYS = [
  "deadlineMs",
  "maxTurns",
  "maxToolCalls",
  "maxOutputChars",
  "maxTokens",
  "maxLaunches",
  "maxDepth",
  "maxActive",
  "maxQueued",
  "maxNetworkOperations",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function subagentMcpEffectProfileFingerprintV2(
  profile: Omit<SubagentMcpMutationEffectProfileV2, "fingerprint">,
): string {
  return createHash("sha256")
    .update("aiden-subagent-mcp-effect-profile-v2\0", "utf8")
    .update(
      JSON.stringify({
        classification: profile.classification,
        destructive: profile.destructive,
        idempotency: profile.idempotency,
        openWorld: profile.openWorld,
        taskSupport: profile.taskSupport,
      }),
      "utf8",
    )
    .digest("hex");
}

export function parseSubagentMcpMutationEffectProfileV2(
  value: unknown,
): SubagentMcpMutationEffectProfileV2 {
  if (
    !isRecord(value) ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Invalid subagent MCP mutation effect profile.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = [
    "classification",
    "destructive",
    "idempotency",
    "openWorld",
    "taskSupport",
    "fingerprint",
  ] as const;
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key as (typeof keys)[number]) ||
        !("value" in descriptors[key]!) ||
        descriptors[key]!.enumerable !== true,
    )
  ) {
    throw new Error("Invalid subagent MCP mutation effect profile fields.");
  }
  const field = (key: (typeof keys)[number]) => descriptors[key]!.value;
  const profile = {
    classification: field("classification") as SubagentMcpMutationClassificationV2,
    destructive: field("destructive") as SubagentMcpDestructiveProfileV2,
    idempotency: field("idempotency") as SubagentMcpIdempotencyProfileV2,
    openWorld: field("openWorld") as SubagentMcpOpenWorldProfileV2,
    taskSupport: field("taskSupport") as SubagentMcpTaskSupportV2,
  };
  if (
    !MUTATION_CLASSIFICATIONS.has(profile.classification) ||
    !DESTRUCTIVE_PROFILES.has(profile.destructive) ||
    !IDEMPOTENCY_PROFILES.has(profile.idempotency) ||
    !OPEN_WORLD_PROFILES.has(profile.openWorld) ||
    !TASK_SUPPORT_PROFILES.has(profile.taskSupport) ||
    field("fingerprint") !== subagentMcpEffectProfileFingerprintV2(profile)
  ) {
    throw new Error("Invalid or stale subagent MCP mutation effect profile.");
  }
  return { ...profile, fingerprint: field("fingerprint") as string };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedPositiveInteger(value: unknown, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`Invalid subagent ${field}.`);
  }
  return value as number;
}

function scopedIdentity(value: unknown, field: string): string {
  if (!isSafeSubagentIdentifier(value)) throw new Error(`Invalid subagent ${field}.`);
  return value;
}

function parseMcpScopes(value: unknown): SubagentMcpScopeV2[] {
  if (!Array.isArray(value) || value.length > MAX_SUBAGENT_MCP_SCOPES) {
    throw new Error("Invalid subagent MCP scope.");
  }
  const servers = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["serverId", "connectionFingerprint", "tools"])) {
      throw new Error("Invalid subagent MCP scope fields.");
    }
    const serverId = scopedIdentity(entry.serverId, "MCP server identity");
    if (servers.has(serverId)) throw new Error("Duplicate subagent MCP server scope.");
    servers.add(serverId);
    if (
      typeof entry.connectionFingerprint !== "string" ||
      !EXACT_FINGERPRINT.test(entry.connectionFingerprint) ||
      !Array.isArray(entry.tools) ||
      entry.tools.length < 1 ||
      entry.tools.length > MAX_SUBAGENT_MCP_TOOLS_PER_SCOPE
    ) {
      throw new Error("Invalid subagent MCP tool scope.");
    }
    const tools = entry.tools.map((tool) => {
      if (
        !isRecord(tool) ||
        typeof tool.schemaHash !== "string" ||
        !EXACT_FINGERPRINT.test(tool.schemaHash) ||
        typeof tool.effect !== "string" ||
        !MCP_EFFECTS.has(tool.effect as SubagentMcpEffectV2)
      ) {
        throw new Error("Invalid subagent MCP tool binding.");
      }
      const effect = tool.effect as SubagentMcpEffectV2;
      const expectedKeys =
        effect === "mutating"
          ? ["toolName", "schemaHash", "effect", "effectProfile"]
          : ["toolName", "schemaHash", "effect"];
      if (!hasExactKeys(tool, expectedKeys)) {
        throw new Error("Invalid subagent MCP tool binding fields.");
      }
      const base = {
        toolName: scopedIdentity(tool.toolName, "MCP tool identity"),
        schemaHash: tool.schemaHash,
      };
      return effect === "read"
        ? { ...base, effect }
        : {
            ...base,
            effect,
            effectProfile: parseSubagentMcpMutationEffectProfileV2(tool.effectProfile),
          };
    });
    if (new Set(tools.map(({ toolName }) => toolName)).size !== tools.length) {
      throw new Error("Duplicate subagent MCP tool scope.");
    }
    return {
      serverId,
      connectionFingerprint: entry.connectionFingerprint,
      tools,
    };
  });
}

export function parseSubagentCapabilitySetV2(value: unknown): SubagentCapabilitySetV2 {
  if (!isRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS)) {
    throw new Error("Invalid subagent V2 capability fields.");
  }
  for (const key of CAPABILITY_KEYS.slice(0, -1)) {
    if (typeof value[key] !== "boolean") {
      throw new Error("Invalid subagent V2 capability value.");
    }
  }
  return {
    workspaceRead: value.workspaceRead as boolean,
    workspaceWrite: value.workspaceWrite as boolean,
    shell: value.shell as boolean,
    web: value.web as boolean,
    delegation: value.delegation as boolean,
    mcp: parseMcpScopes(value.mcp),
  };
}

export function parseSubagentBudgetV2(value: unknown): SubagentBudgetV2 {
  if (!isRecord(value) || !hasExactKeys(value, BUDGET_KEYS)) {
    throw new Error("Invalid subagent V2 budget fields.");
  }
  return {
    deadlineMs: boundedPositiveInteger(value.deadlineMs, 24 * 60 * 60_000, "deadline budget"),
    maxTurns: boundedPositiveInteger(value.maxTurns, 128, "turn budget"),
    maxToolCalls: boundedPositiveInteger(value.maxToolCalls, 512, "tool-call budget"),
    maxOutputChars: boundedPositiveInteger(value.maxOutputChars, 1_000_000, "output budget"),
    maxTokens: boundedPositiveInteger(value.maxTokens, 10_000_000, "token budget"),
    maxLaunches: boundedPositiveInteger(value.maxLaunches, 64, "launch budget"),
    maxDepth: boundedPositiveInteger(value.maxDepth, MAX_SUBAGENT_TREE_DEPTH, "depth budget"),
    maxActive: boundedPositiveInteger(value.maxActive, 32, "active-child budget"),
    maxQueued: boundedPositiveInteger(value.maxQueued, 32, "queued-child budget"),
    maxNetworkOperations: boundedPositiveInteger(
      value.maxNetworkOperations,
      512,
      "network-operation budget",
    ),
  };
}

export function parseSubagentLaunchRequestV2(value: unknown): SubagentLaunchRequestV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "execution", "context", "capabilities", "limits", "tasks"]) ||
    value.version !== SUBAGENT_AUTHORITY_VERSION ||
    typeof value.execution !== "string" ||
    !EXECUTION_MODES.has(value.execution as SubagentExecutionModeV2) ||
    typeof value.context !== "string" ||
    !CONTEXT_MODES.has(value.context as SubagentContextModeV2)
  ) {
    throw new Error("Invalid subagent V2 launch request.");
  }
  return {
    version: SUBAGENT_AUTHORITY_VERSION,
    execution: value.execution as SubagentExecutionModeV2,
    context: value.context as SubagentContextModeV2,
    capabilities: parseSubagentCapabilitySetV2(value.capabilities),
    limits: parseSubagentBudgetV2(value.limits),
    tasks: parseSubagentToolRequest({ tasks: value.tasks }).tasks,
  };
}

function mcpPairs(scopes: readonly SubagentMcpScopeV2[]): Set<string> {
  return new Set(
    scopes.flatMap(({ serverId, connectionFingerprint, tools }) =>
      tools.map(
        (tool) =>
          `${serverId}\0${connectionFingerprint}\0${tool.toolName}\0${tool.schemaHash}\0${tool.effect}\0${tool.effect === "mutating" ? tool.effectProfile.fingerprint : "read"}`,
      ),
    ),
  );
}

function intersectMcp(scopes: readonly (readonly SubagentMcpScopeV2[])[]): SubagentMcpScopeV2[] {
  if (scopes.length === 0) return [];
  const remaining = mcpPairs(scopes[0]!);
  for (const scope of scopes.slice(1)) {
    const allowed = mcpPairs(scope);
    for (const pair of remaining) if (!allowed.has(pair)) remaining.delete(pair);
  }
  const grouped = new Map<string, SubagentMcpToolScopeV2[]>();
  for (const pair of [...remaining].sort()) {
    const [serverId, connectionFingerprint, toolName, schemaHash, effect, profileFingerprint] =
      pair.split("\0");
    if (!serverId || !connectionFingerprint || !toolName || !schemaHash || !effect) {
      continue;
    }
    const groupKey = `${serverId}\0${connectionFingerprint}`;
    const tools = grouped.get(groupKey) ?? [];
    const sourceTool = scopes[0]!
      .find(
        (scope) =>
          scope.serverId === serverId && scope.connectionFingerprint === connectionFingerprint,
      )
      ?.tools.find(
        (tool) =>
          tool.toolName === toolName &&
          tool.schemaHash === schemaHash &&
          tool.effect === effect &&
          (tool.effect === "read" || tool.effectProfile.fingerprint === profileFingerprint),
      );
    if (sourceTool) tools.push(structuredClone(sourceTool));
    grouped.set(groupKey, tools);
  }
  return [...grouped].map(([key, tools]) => {
    const [serverId, connectionFingerprint] = key.split("\0");
    return { serverId: serverId!, connectionFingerprint: connectionFingerprint!, tools };
  });
}

export function resolveSubagentCapabilitiesV2(
  input: ResolveSubagentCapabilitiesV2Input,
): SubagentCapabilitySetV2 {
  const sources = [input.requested, input.root, input.parent, input.role, input.userGrant];
  const workspaceAllowed = input.workspacePermission !== "none";
  const capabilities: SubagentCapabilitySetV2 = {
    workspaceRead: workspaceAllowed && sources.every(({ workspaceRead }) => workspaceRead),
    workspaceWrite:
      workspaceAllowed &&
      input.workspaceEgressApproval === "per_call" &&
      input.rollout.workspaceWrite &&
      sources.every(({ workspaceWrite }) => workspaceWrite),
    shell: workspaceAllowed && input.rollout.shell && sources.every(({ shell }) => shell),
    web: input.rollout.web && sources.every(({ web }) => web),
    delegation: input.rollout.delegation && sources.every(({ delegation }) => delegation),
    mcp: input.rollout.mcp ? intersectMcp(sources.map(({ mcp }) => mcp)) : [],
  };
  if (
    capabilities.workspaceRead &&
    (capabilities.web || capabilities.mcp.length > 0) &&
    input.workspaceEgressApproval !== "per_call"
  ) {
    throw new Error("Workspace read plus network egress requires an explicit combined grant.");
  }
  return capabilities;
}

export function intersectSubagentBudgetsV2(
  ...budgets: readonly SubagentBudgetV2[]
): SubagentBudgetV2 {
  if (budgets.length === 0) throw new Error("Subagent budget intersection requires a ceiling.");
  return {
    deadlineMs: Math.min(...budgets.map(({ deadlineMs }) => deadlineMs)),
    maxTurns: Math.min(...budgets.map(({ maxTurns }) => maxTurns)),
    maxToolCalls: Math.min(...budgets.map(({ maxToolCalls }) => maxToolCalls)),
    maxOutputChars: Math.min(...budgets.map(({ maxOutputChars }) => maxOutputChars)),
    maxTokens: Math.min(...budgets.map(({ maxTokens }) => maxTokens)),
    maxLaunches: Math.min(...budgets.map(({ maxLaunches }) => maxLaunches)),
    maxDepth: Math.min(...budgets.map(({ maxDepth }) => maxDepth)),
    maxActive: Math.min(...budgets.map(({ maxActive }) => maxActive)),
    maxQueued: Math.min(...budgets.map(({ maxQueued }) => maxQueued)),
    maxNetworkOperations: Math.min(
      ...budgets.map(({ maxNetworkOperations }) => maxNetworkOperations),
    ),
  };
}

function deepFreezeCapabilitySet(value: SubagentCapabilitySetV2): SubagentCapabilitySetV2 {
  for (const scope of value.mcp) {
    for (const tool of scope.tools) {
      if (tool.effect === "mutating") Object.freeze(tool.effectProfile);
      Object.freeze(tool);
    }
    Object.freeze(scope.tools);
    Object.freeze(scope);
  }
  Object.freeze(value.mcp);
  return Object.freeze(value);
}

function boundedPrivateIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("\0");
}

export function createSubagentAuthorityV2(
  input: CreateSubagentAuthorityV2Input,
): SubagentAuthorityV2 {
  const identifiers = [
    input.grantId,
    input.treeRootId,
    input.runId,
    input.parentRunId,
    input.generationId,
    input.chatId,
    input.workspaceId,
  ].filter((value): value is string => value !== undefined);
  if (identifiers.some((value) => !isSafeSubagentIdentifier(value))) {
    throw new Error("Invalid subagent V2 authority identity.");
  }
  if (
    !Number.isSafeInteger(input.depth) ||
    input.depth < 1 ||
    input.depth > MAX_SUBAGENT_TREE_DEPTH ||
    !Number.isSafeInteger(input.authorityRevision) ||
    input.authorityRevision < 1 ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= 0 ||
    !EXECUTION_MODES.has(input.execution) ||
    !CONTEXT_MODES.has(input.context) ||
    typeof input.thinkingLevel !== "string" ||
    !THINKING_LEVELS.has(input.thinkingLevel) ||
    !boundedPrivateIdentity(input.ownerDocumentId) ||
    !boundedPrivateIdentity(input.workspaceRevision) ||
    !boundedPrivateIdentity(input.providerFingerprint) ||
    !boundedPrivateIdentity(input.modelFingerprint) ||
    !boundedPrivateIdentity(input.contextRevision)
  ) {
    throw new Error("Invalid subagent V2 authority fields.");
  }
  if (input.depth === 1 && input.parentRunId !== undefined) {
    throw new Error("A direct subagent cannot name a parent run.");
  }
  if (input.depth > 1 && input.parentRunId === undefined) {
    throw new Error("A nested subagent requires a parent run.");
  }
  if (input.parentRunId === input.runId) {
    throw new Error("A subagent run cannot be its own parent.");
  }
  const capabilities = parseSubagentCapabilitySetV2(input.capabilities);
  const budgets = parseSubagentBudgetV2(input.budgets);
  if (input.depth > budgets.maxDepth) {
    throw new Error("Subagent depth exceeds its authority budget.");
  }
  const authority: SubagentAuthorityV2 = {
    version: SUBAGENT_AUTHORITY_VERSION,
    grantId: input.grantId,
    treeRootId: input.treeRootId,
    runId: input.runId,
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    depth: input.depth,
    authorityRevision: input.authorityRevision,
    generationId: input.generationId,
    chatId: input.chatId,
    workspaceId: input.workspaceId,
    workspaceRevision: input.workspaceRevision,
    ownerDocumentId: input.ownerDocumentId,
    providerFingerprint: input.providerFingerprint,
    modelFingerprint: input.modelFingerprint,
    contextRevision: input.contextRevision,
    execution: input.execution,
    context: input.context,
    thinkingLevel: input.thinkingLevel,
    capabilities: deepFreezeCapabilitySet(capabilities),
    budgets: Object.freeze(budgets),
    expiresAt: input.expiresAt,
  };
  return Object.freeze(authority);
}

export function assertSubagentLaunchRolloutV2(
  request: Pick<SubagentLaunchRequestV2, "execution" | "context">,
  rollout: Pick<SubagentRolloutPolicyV2, "background" | "fork">,
): void {
  if (request.execution === "background" && !rollout.background) {
    throw new Error("Background subagents are not enabled.");
  }
  if (request.context === "fork" && !rollout.fork) {
    throw new Error("Forked subagent context is not enabled.");
  }
}

export function subagentCapabilitiesAreSubsetV2(
  child: SubagentCapabilitySetV2,
  parent: SubagentCapabilitySetV2,
): boolean {
  const scalarKeys = ["workspaceRead", "workspaceWrite", "shell", "web", "delegation"] as const;
  if (scalarKeys.some((key) => child[key] && !parent[key])) return false;
  const parentMcp = mcpPairs(parent.mcp);
  return [...mcpPairs(child.mcp)].every((pair) => parentMcp.has(pair));
}
