import { types as utilTypes } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import {
  MAX_SUBAGENT_TREE_DEPTH,
  parseSubagentCapabilitySetV2,
  subagentCapabilitiesAreSubsetV2,
  type SubagentCapabilitySetV2,
  type SubagentContextModeV2,
  type SubagentExecutionModeV2,
} from "./authority-v2.js";
import type { SubagentDeployment } from "./concurrency-gate.js";

export interface SubagentTreeIdentityV2 {
  readonly treeRootId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly depth: number;
}

export interface SubagentTreeFixedCeilingV2 {
  readonly workspace: Readonly<{
    generationId: string;
    chatId: string;
    workspaceId: string;
    workspaceRevision: string;
    ownerDocumentId: string;
  }>;
  readonly runtime: Readonly<{
    providerFingerprint: string;
    modelFingerprint: string;
    execution: SubagentExecutionModeV2;
    thinkingLevel: ThinkingLevel;
  }>;
  readonly context: Readonly<{
    mode: SubagentContextModeV2;
    revision: string;
    maxInputTokens: number;
  }>;
}

export interface SubagentTreeNodeV2 {
  readonly identity: SubagentTreeIdentityV2;
  /** Shared by identity: descendants cannot replace any workspace/runtime/context fact. */
  readonly fixedCeiling: SubagentTreeFixedCeilingV2;
  readonly capabilities: SubagentCapabilitySetV2;
  readonly toolNames: readonly string[];
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const EXECUTION_MODES = new Set<SubagentExecutionModeV2>([
  "foreground",
  "background",
]);
const CONTEXT_MODES = new Set<SubagentContextModeV2>(["fresh", "fork"]);
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MINTED_TREE_NODES = new WeakSet<object>();

function exactPlainRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.prototype.hasOwnProperty.call(descriptors, key) ||
        !("value" in descriptors[key]!) ||
        descriptors[key]!.enumerable !== true,
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(
    (actual as string[]).map((key) => [key, descriptors[key]!.value]),
  );
}

function privateText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid subagent tree ${field}.`);
  }
  return value;
}

function treeIdentifier(value: unknown, field: string): string {
  if (!isSafeSubagentIdentifier(value))
    throw new Error(`Invalid subagent tree ${field}.`);
  return value;
}

function positiveInteger(
  value: unknown,
  maximum: number,
  field: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new Error(`Invalid subagent tree ${field}.`);
  }
  return value as number;
}

function exactToolNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > 128) {
    throw new Error("Invalid subagent tree tool ceiling.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const names: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string" ||
      !TOOL_NAME.test(descriptor.value)
    ) {
      throw new Error("Invalid subagent tree tool ceiling.");
    }
    names.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key)),
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Invalid or duplicate subagent tree tool ceiling.");
  }
  return Object.freeze(names);
}

function exactDenseArray(
  value: unknown,
  maximum: number,
  field: string,
): unknown[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    value.length > maximum
  ) {
    throw new Error(`Invalid subagent tree ${field}.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as Record<PropertyKey, PropertyDescriptor>;
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key)),
    )
  ) {
    throw new Error(`Invalid subagent tree ${field}.`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new Error(`Invalid subagent tree ${field}.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function safeCapabilitySnapshot(value: unknown): Record<string, unknown> {
  const top = exactPlainRecord(value, [
    "workspaceRead",
    "workspaceWrite",
    "shell",
    "web",
    "delegation",
    "mcp",
  ]);
  if (!top) throw new Error("Invalid subagent tree capability ceiling.");
  const mcp = exactDenseArray(top.mcp, 16, "MCP ceiling").map((scopeValue) => {
    const scope = exactPlainRecord(scopeValue, [
      "serverId",
      "connectionFingerprint",
      "tools",
    ]);
    if (!scope) throw new Error("Invalid subagent tree MCP scope.");
    const tools = exactDenseArray(scope.tools, 32, "MCP tool ceiling").map(
      (toolValue) => {
        const read = exactPlainRecord(toolValue, [
          "toolName",
          "schemaHash",
          "effect",
        ]);
        if (read) return read;
        const mutation = exactPlainRecord(toolValue, [
          "toolName",
          "schemaHash",
          "effect",
          "effectProfile",
        ]);
        const profile = exactPlainRecord(mutation?.effectProfile, [
          "classification",
          "destructive",
          "idempotency",
          "openWorld",
          "taskSupport",
          "fingerprint",
        ]);
        if (!mutation || !profile)
          throw new Error("Invalid subagent tree MCP tool ceiling.");
        return { ...mutation, effectProfile: profile };
      },
    );
    return { ...scope, tools };
  });
  return { ...top, mcp };
}

function freezeCapabilities(value: unknown): SubagentCapabilitySetV2 {
  const parsed = parseSubagentCapabilitySetV2(safeCapabilitySnapshot(value));
  for (const scope of parsed.mcp) {
    for (const tool of scope.tools) {
      if (tool.effect === "mutating") Object.freeze(tool.effectProfile);
      Object.freeze(tool);
    }
    Object.freeze(scope.tools);
    Object.freeze(scope);
  }
  Object.freeze(parsed.mcp);
  return Object.freeze(parsed);
}

function parseFixedCeiling(value: unknown): SubagentTreeFixedCeilingV2 {
  const fixed = exactPlainRecord(value, ["workspace", "runtime", "context"]);
  const workspace = exactPlainRecord(fixed?.workspace, [
    "generationId",
    "chatId",
    "workspaceId",
    "workspaceRevision",
    "ownerDocumentId",
  ]);
  const runtime = exactPlainRecord(fixed?.runtime, [
    "providerFingerprint",
    "modelFingerprint",
    "execution",
    "thinkingLevel",
  ]);
  const context = exactPlainRecord(fixed?.context, [
    "mode",
    "revision",
    "maxInputTokens",
  ]);
  if (
    !workspace ||
    !runtime ||
    !context ||
    typeof runtime.execution !== "string" ||
    !EXECUTION_MODES.has(runtime.execution as SubagentExecutionModeV2) ||
    typeof runtime.thinkingLevel !== "string" ||
    !THINKING_LEVELS.has(runtime.thinkingLevel as ThinkingLevel) ||
    typeof context.mode !== "string" ||
    !CONTEXT_MODES.has(context.mode as SubagentContextModeV2)
  ) {
    throw new Error("Invalid subagent tree fixed ceiling.");
  }
  return Object.freeze({
    workspace: Object.freeze({
      generationId: treeIdentifier(
        workspace.generationId,
        "generation identity",
      ),
      chatId: treeIdentifier(workspace.chatId, "chat identity"),
      workspaceId: treeIdentifier(workspace.workspaceId, "workspace identity"),
      workspaceRevision: privateText(
        workspace.workspaceRevision,
        "workspace revision",
      ),
      ownerDocumentId: privateText(workspace.ownerDocumentId, "renderer owner"),
    }),
    runtime: Object.freeze({
      providerFingerprint: privateText(
        runtime.providerFingerprint,
        "provider fingerprint",
      ),
      modelFingerprint: privateText(
        runtime.modelFingerprint,
        "model fingerprint",
      ),
      execution: runtime.execution as SubagentExecutionModeV2,
      thinkingLevel: runtime.thinkingLevel as ThinkingLevel,
    }),
    context: Object.freeze({
      mode: context.mode as SubagentContextModeV2,
      revision: privateText(context.revision, "context revision"),
      maxInputTokens: positiveInteger(
        context.maxInputTokens,
        10_000_000,
        "context ceiling",
      ),
    }),
  });
}

function freezeIdentity(
  identity: SubagentTreeIdentityV2,
): SubagentTreeIdentityV2 {
  return Object.freeze(identity);
}

function mintNode(node: SubagentTreeNodeV2): SubagentTreeNodeV2 {
  const minted = Object.freeze(node);
  MINTED_TREE_NODES.add(minted);
  return minted;
}

/** Exact depth-0 parent-generation record. It is control state, not a child authority. */
export function createSubagentTreeRootV2(input: unknown): SubagentTreeNodeV2 {
  const root = exactPlainRecord(input, [
    "treeRootId",
    "runId",
    "fixedCeiling",
    "capabilities",
    "toolNames",
  ]);
  if (!root) throw new Error("Invalid subagent tree root fields.");
  const treeRootId = treeIdentifier(root.treeRootId, "root identity");
  const runId = treeIdentifier(root.runId, "root run identity");
  if (treeRootId !== runId)
    throw new Error("A subagent tree root must identify itself.");
  return mintNode({
    identity: freezeIdentity({ treeRootId, runId, depth: 0 }),
    fixedCeiling: parseFixedCeiling(root.fixedCeiling),
    capabilities: freezeCapabilities(root.capabilities),
    toolNames: exactToolNames(root.toolNames),
  });
}

/** Derive, rather than accept, lineage and fixed ceilings from the exact parent. */
export function createSubagentTreeDescendantV2(
  parent: SubagentTreeNodeV2,
  input: unknown,
): SubagentTreeNodeV2 {
  if (!MINTED_TREE_NODES.has(parent))
    throw new Error("Invalid subagent tree parent authority.");
  const child = exactPlainRecord(input, ["runId", "capabilities", "toolNames"]);
  if (!child) throw new Error("Invalid subagent tree descendant fields.");
  const depth = parent.identity.depth + 1;
  if (depth > MAX_SUBAGENT_TREE_DEPTH) {
    throw new Error(
      `Subagent nesting cannot exceed depth ${MAX_SUBAGENT_TREE_DEPTH}.`,
    );
  }
  const runId = treeIdentifier(child.runId, "run identity");
  if (runId === parent.identity.runId || runId === parent.identity.treeRootId) {
    throw new Error(
      "A subagent tree descendant requires a fresh run identity.",
    );
  }
  const capabilities = freezeCapabilities(child.capabilities);
  if (!subagentCapabilitiesAreSubsetV2(capabilities, parent.capabilities)) {
    throw new Error(
      "A subagent tree descendant cannot widen its capability ceiling.",
    );
  }
  const toolNames = exactToolNames(child.toolNames);
  const parentTools = new Set(parent.toolNames);
  if (toolNames.some((name) => !parentTools.has(name))) {
    throw new Error(
      "A subagent tree descendant cannot widen its tool ceiling.",
    );
  }
  return mintNode({
    identity: freezeIdentity({
      treeRootId: parent.identity.treeRootId,
      runId,
      ...(depth === 1 ? {} : { parentRunId: parent.identity.runId }),
      depth,
    }),
    fixedCeiling: parent.fixedCeiling,
    capabilities,
    toolNames,
  });
}

export interface SubagentTreeBudgetLimitsV2 {
  readonly maxDepth: number;
  readonly maxLaunches: number;
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxTokens: number;
  readonly maxToolCalls: number;
  readonly maxTurns: number;
  readonly maxNetworkOperations: number;
  readonly maxWallTimeMs: number;
  readonly maxOutputChars: number;
}

export interface SubagentTreeBudgetUsageV2 {
  readonly tokens: number;
  readonly toolCalls: number;
  readonly outputChars: number;
  readonly turns: number;
  readonly networkOperations: number;
}

export type SubagentTreeBudgetDimension =
  | "tokens"
  | "tool calls"
  | "output characters"
  | "turns"
  | "network operations";

export class SubagentTreeBudgetExhaustedError extends Error {
  readonly code = "subagent_tree_budget_exhausted";

  constructor(
    readonly dimension: SubagentTreeBudgetDimension,
    readonly attempted: number,
    readonly limit: number,
  ) {
    super(
      `Subagent tree ${dimension} budget exhausted (${attempted.toLocaleString("en-US")} attempted; ${limit.toLocaleString("en-US")} allowed). Start a new parent turn with narrower tasks.`,
    );
    this.name = "SubagentTreeBudgetExhaustedError";
  }
}

export interface SubagentTreeBudgetSnapshotV2 extends SubagentTreeBudgetUsageV2 {
  readonly launched: number;
  readonly active: number;
  readonly queued: number;
  readonly elapsedWallTimeMs: number;
  readonly expired: boolean;
}

export interface SubagentTreeLaunchReservationV2 {
  readonly sequence: number;
  readonly treeRootId: string;
  readonly parentRunId?: string;
  readonly runIds: readonly string[];
}

type LedgerRunState = "queued" | "active" | "waiting" | "terminal";

interface LedgerRun {
  readonly identity: SubagentTreeIdentityV2;
  state: LedgerRunState;
}

function parseBudgetLimits(value: unknown): SubagentTreeBudgetLimitsV2 {
  const limits = exactPlainRecord(value, [
    "maxDepth",
    "maxLaunches",
    "maxActive",
    "maxQueued",
    "maxTokens",
    "maxToolCalls",
    "maxTurns",
    "maxNetworkOperations",
    "maxWallTimeMs",
    "maxOutputChars",
  ]);
  if (!limits) throw new Error("Invalid subagent tree budget fields.");
  return Object.freeze({
    maxDepth: positiveInteger(
      limits.maxDepth,
      MAX_SUBAGENT_TREE_DEPTH,
      "depth budget",
    ),
    maxLaunches: positiveInteger(limits.maxLaunches, 64, "launch budget"),
    maxActive: positiveInteger(limits.maxActive, 32, "active budget"),
    maxQueued: positiveInteger(limits.maxQueued, 64, "queue budget"),
    maxTokens: positiveInteger(limits.maxTokens, 10_000_000, "token budget"),
    maxToolCalls: positiveInteger(limits.maxToolCalls, 512, "tool-call budget"),
    maxTurns: positiveInteger(limits.maxTurns, 512, "turn budget"),
    maxNetworkOperations: positiveInteger(
      limits.maxNetworkOperations,
      512,
      "network-operation budget",
    ),
    maxWallTimeMs: positiveInteger(
      limits.maxWallTimeMs,
      24 * 60 * 60_000,
      "wall-time budget",
    ),
    maxOutputChars: positiveInteger(
      limits.maxOutputChars,
      1_000_000,
      "output budget",
    ),
  });
}

function parseUsage(value: unknown): SubagentTreeBudgetUsageV2 {
  const usage = exactPlainRecord(value, [
    "tokens",
    "toolCalls",
    "outputChars",
    "turns",
    "networkOperations",
  ]);
  if (!usage) throw new Error("Invalid subagent tree usage fields.");
  for (const field of [
    "tokens",
    "toolCalls",
    "outputChars",
    "turns",
    "networkOperations",
  ] as const) {
    if (!Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0) {
      throw new Error("Invalid subagent tree usage value.");
    }
  }
  return {
    tokens: usage.tokens as number,
    toolCalls: usage.toolCalls as number,
    outputChars: usage.outputChars as number,
    turns: usage.turns as number,
    networkOperations: usage.networkOperations as number,
  };
}

/** One synchronous, tree-owned ledger. Every multi-child reservation is all-or-nothing. */
export class SubagentTreeBudgetLedgerV2 {
  readonly treeRootId: string;
  readonly limits: SubagentTreeBudgetLimitsV2;
  private readonly createdAt: number;
  private readonly runs = new Map<string, LedgerRun>();
  private launched = 0;
  private active = 0;
  private queued = 0;
  private tokens = 0;
  private toolCalls = 0;
  private outputChars = 0;
  private turns = 0;
  private networkOperations = 0;
  private reservationSequence = 0;

  constructor(
    treeRootId: string,
    limits: unknown,
    private readonly clock: () => number = Date.now,
  ) {
    this.treeRootId = treeIdentifier(treeRootId, "budget root identity");
    this.limits = parseBudgetLimits(limits);
    this.createdAt = this.clock();
    if (!Number.isFinite(this.createdAt))
      throw new Error("Invalid subagent tree clock.");
  }

  private assertLive(): void {
    const now = this.clock();
    if (
      !Number.isFinite(now) ||
      now < this.createdAt ||
      now - this.createdAt > this.limits.maxWallTimeMs
    ) {
      throw new Error("Subagent tree wall-time budget exhausted.");
    }
  }

  private validateNodes(
    nodes: readonly SubagentTreeNodeV2[],
    parentRunId: string | undefined,
    expectedDepth: number,
  ): void {
    if (nodes.length < 1 || nodes.length > 32) {
      throw new Error(
        "A subagent tree reservation requires 1 to 32 descendants.",
      );
    }
    const ids = new Set<string>();
    for (const node of nodes) {
      const identity = node.identity;
      if (
        !MINTED_TREE_NODES.has(node) ||
        identity.treeRootId !== this.treeRootId ||
        identity.parentRunId !== parentRunId ||
        identity.depth !== expectedDepth ||
        identity.depth > this.limits.maxDepth ||
        ids.has(identity.runId) ||
        this.runs.has(identity.runId)
      ) {
        throw new Error(
          "Invalid, duplicate, or over-depth subagent tree reservation.",
        );
      }
      ids.add(identity.runId);
    }
  }

  private reservation(
    nodes: readonly SubagentTreeNodeV2[],
    parentRunId?: string,
  ): SubagentTreeLaunchReservationV2 {
    this.reservationSequence += 1;
    return Object.freeze({
      sequence: this.reservationSequence,
      treeRootId: this.treeRootId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      runIds: Object.freeze(nodes.map(({ identity }) => identity.runId)),
    });
  }

  reserveLaunches(
    nodes: readonly SubagentTreeNodeV2[],
  ): SubagentTreeLaunchReservationV2 {
    this.assertLive();
    this.validateNodes(nodes, undefined, 1);
    if (this.launched + nodes.length > this.limits.maxLaunches) {
      throw new Error("Subagent tree launch budget exhausted.");
    }
    if (this.queued + nodes.length > this.limits.maxQueued) {
      throw new Error("Subagent tree queue budget exhausted.");
    }
    for (const node of nodes)
      this.runs.set(node.identity.runId, {
        identity: node.identity,
        state: "queued",
      });
    this.launched += nodes.length;
    this.queued += nodes.length;
    return this.reservation(nodes);
  }

  reserveDescendantsAndSuspendParent(
    parentRunId: string,
    nodes: readonly SubagentTreeNodeV2[],
  ): SubagentTreeLaunchReservationV2 {
    this.assertLive();
    const parent = this.runs.get(parentRunId);
    if (!parent || parent.state !== "active") {
      throw new Error("Only an active subagent may reserve descendants.");
    }
    this.validateNodes(nodes, parentRunId, parent.identity.depth + 1);
    if (this.launched + nodes.length > this.limits.maxLaunches) {
      throw new Error("Subagent tree launch budget exhausted.");
    }
    // The suspended parent's resume slot and all siblings reserve together.
    if (this.queued + nodes.length + 1 > this.limits.maxQueued) {
      throw new Error("Subagent tree queue budget exhausted.");
    }
    parent.state = "waiting";
    this.active -= 1;
    this.queued += nodes.length + 1;
    this.launched += nodes.length;
    for (const node of nodes)
      this.runs.set(node.identity.runId, {
        identity: node.identity,
        state: "queued",
      });
    return this.reservation(nodes, parentRunId);
  }

  activate(runId: string): void {
    this.assertLive();
    const run = this.runs.get(runId);
    if (!run || (run.state !== "queued" && run.state !== "waiting")) {
      throw new Error("Subagent tree run is not queued for activation.");
    }
    if (this.active >= this.limits.maxActive) {
      throw new Error("Subagent tree active budget exhausted.");
    }
    run.state = "active";
    this.queued -= 1;
    this.active += 1;
  }

  finish(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.state === "terminal") return;
    if (run.state === "active") this.active -= 1;
    else this.queued -= 1;
    run.state = "terminal";
  }

  consumeUsage(value: unknown): void {
    this.assertLive();
    const usage = parseUsage(value);
    const tokens = this.tokens + usage.tokens;
    const toolCalls = this.toolCalls + usage.toolCalls;
    const outputChars = this.outputChars + usage.outputChars;
    const turns = this.turns + usage.turns;
    const networkOperations = this.networkOperations + usage.networkOperations;
    const exceeded: [SubagentTreeBudgetDimension, number, number] | undefined =
      tokens > this.limits.maxTokens
        ? ["tokens", tokens, this.limits.maxTokens]
        : toolCalls > this.limits.maxToolCalls
          ? ["tool calls", toolCalls, this.limits.maxToolCalls]
          : outputChars > this.limits.maxOutputChars
            ? ["output characters", outputChars, this.limits.maxOutputChars]
            : turns > this.limits.maxTurns
              ? ["turns", turns, this.limits.maxTurns]
              : networkOperations > this.limits.maxNetworkOperations
                ? ["network operations", networkOperations, this.limits.maxNetworkOperations]
                : undefined;
    if (exceeded) throw new SubagentTreeBudgetExhaustedError(...exceeded);
    this.tokens = tokens;
    this.toolCalls = toolCalls;
    this.outputChars = outputChars;
    this.turns = turns;
    this.networkOperations = networkOperations;
  }

  stateOf(runId: string): LedgerRunState | undefined {
    return this.runs.get(runId)?.state;
  }

  snapshot(): SubagentTreeBudgetSnapshotV2 {
    const now = this.clock();
    const elapsedWallTimeMs =
      Number.isFinite(now) && now >= this.createdAt ? now - this.createdAt : 0;
    return Object.freeze({
      launched: this.launched,
      active: this.active,
      queued: this.queued,
      tokens: this.tokens,
      toolCalls: this.toolCalls,
      outputChars: this.outputChars,
      turns: this.turns,
      networkOperations: this.networkOperations,
      elapsedWallTimeMs,
      expired:
        !Number.isFinite(now) ||
        now < this.createdAt ||
        elapsedWallTimeMs > this.limits.maxWallTimeMs,
    });
  }
}

export interface SubagentTreeSchedulerTaskV2 {
  readonly node: SubagentTreeNodeV2;
  readonly deployment: SubagentDeployment;
  readonly execute: (lease: SubagentTreeExecutionLeaseV2) => Promise<unknown>;
  /** Exact per-run value returned when this task is stopped before dispatch. */
  readonly cancelledResult?: unknown;
}

export interface SubagentTreeExecutionLeaseV2 {
  readonly node: SubagentTreeNodeV2;
  readonly signal: AbortSignal;
  runDescendants(
    tasks: readonly SubagentTreeSchedulerTaskV2[],
  ): Promise<readonly unknown[]>;
  cancelRun(runId: string, reason?: Error): boolean;
}

type SchedulerState = "queued" | "running" | "waiting" | "settled";

interface SchedulerEntry {
  readonly task: SubagentTreeSchedulerTaskV2;
  readonly sequence: number;
  readonly promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  state: SchedulerState;
  holdsCapacity: boolean;
  delegating: boolean;
}

interface DispatchItem {
  readonly entry: SchedulerEntry;
  readonly resume: boolean;
  readonly resumeResolve?: () => void;
  readonly resumeReject?: (reason: Error) => void;
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Subagent tree cancelled.");
}

/** Production-inert scheduler core. Waiting parents hold a reserved resume slot, not execution. */
export class SubagentTreeSchedulerV2 {
  private readonly limits: Readonly<Record<SubagentDeployment, number>>;
  private readonly active: Record<SubagentDeployment, number> = {
    hosted: 0,
    local: 0,
  };
  private readonly queue: DispatchItem[] = [];
  private readonly entries = new Map<string, SchedulerEntry>();
  private readonly controller = new AbortController();
  private sequence = 0;

  constructor(
    readonly ledger: SubagentTreeBudgetLedgerV2,
    limits: Readonly<Record<SubagentDeployment, number>> = {
      hosted: 2,
      local: 1,
    },
  ) {
    if (
      !Number.isSafeInteger(limits.hosted) ||
      limits.hosted < 1 ||
      limits.hosted > 32 ||
      !Number.isSafeInteger(limits.local) ||
      limits.local < 1 ||
      limits.local > 32
    ) {
      throw new Error("Invalid subagent tree scheduler limits.");
    }
    this.limits = Object.freeze({ hosted: limits.hosted, local: limits.local });
  }

  private validateTasks(tasks: readonly SubagentTreeSchedulerTaskV2[]): void {
    if (tasks.length < 1 || tasks.length > 32)
      throw new Error("Invalid subagent tree task batch.");
    for (const task of tasks) {
      if (
        (task.deployment !== "hosted" && task.deployment !== "local") ||
        typeof task.execute !== "function" ||
        this.entries.has(task.node.identity.runId)
      ) {
        throw new Error("Invalid or duplicate subagent tree scheduler task.");
      }
    }
  }

  private createEntries(
    tasks: readonly SubagentTreeSchedulerTaskV2[],
  ): SchedulerEntry[] {
    return tasks.map((task) => {
      let resolve!: (value: unknown) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<unknown>((accept, deny) => {
        resolve = accept;
        reject = deny;
      });
      this.sequence += 1;
      const entry: SchedulerEntry = {
        task,
        sequence: this.sequence,
        promise,
        resolve,
        reject,
        state: "queued",
        holdsCapacity: false,
        delegating: false,
      };
      this.entries.set(task.node.identity.runId, entry);
      return entry;
    });
  }

  private enqueue(entries: readonly SchedulerEntry[]): void {
    for (const entry of entries) this.queue.push({ entry, resume: false });
    this.dispatch();
  }

  private dispatch(): void {
    if (this.controller.signal.aborted) return;
    for (let index = 0; index < this.queue.length; ) {
      const item = this.queue[index]!;
      const deployment = item.entry.task.deployment;
      if (this.active[deployment] >= this.limits[deployment]) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      try {
        this.ledger.activate(item.entry.task.node.identity.runId);
      } catch (error) {
        const reason =
          error instanceof Error
            ? error
            : new Error("Subagent tree activation failed.");
        this.ledger.finish(item.entry.task.node.identity.runId);
        item.entry.state = "settled";
        item.resumeReject?.(reason);
        if (!item.resume) item.entry.reject(reason);
        continue;
      }
      this.active[deployment] += 1;
      item.entry.holdsCapacity = true;
      item.entry.state = "running";
      if (item.resume) {
        item.resumeResolve?.();
      } else {
        void this.execute(item.entry);
      }
    }
  }

  private async execute(entry: SchedulerEntry): Promise<void> {
    const lease: SubagentTreeExecutionLeaseV2 = Object.freeze({
      node: entry.task.node,
      signal: this.controller.signal,
      runDescendants: (tasks: readonly SubagentTreeSchedulerTaskV2[]) =>
        this.runDescendants(entry, tasks),
      cancelRun: (runId: string, reason?: Error) =>
        this.cancelRun(runId, reason),
    });
    try {
      const result = await entry.task.execute(lease);
      if (this.controller.signal.aborted)
        throw cancellationError(this.controller.signal);
      entry.resolve(result);
    } catch (error) {
      entry.reject(
        error instanceof Error
          ? error
          : new Error("Subagent tree task failed."),
      );
    } finally {
      if (entry.holdsCapacity) {
        this.active[entry.task.deployment] -= 1;
        entry.holdsCapacity = false;
      }
      this.ledger.finish(entry.task.node.identity.runId);
      entry.state = "settled";
      this.dispatch();
    }
  }

  private runDescendants(
    parent: SchedulerEntry,
    tasks: readonly SubagentTreeSchedulerTaskV2[],
  ): Promise<readonly unknown[]> {
    if (
      parent.state !== "running" ||
      !parent.holdsCapacity ||
      parent.delegating
    ) {
      throw new Error(
        "A subagent may wait on only one descendant batch at a time.",
      );
    }
    if (this.controller.signal.aborted)
      throw cancellationError(this.controller.signal);
    this.validateTasks(tasks);
    this.ledger.reserveDescendantsAndSuspendParent(
      parent.task.node.identity.runId,
      tasks.map(({ node }) => node),
    );
    const children = this.createEntries(tasks);
    parent.delegating = true;
    parent.state = "waiting";
    parent.holdsCapacity = false;
    this.active[parent.task.deployment] -= 1;
    this.enqueue(children);

    return this.settleDescendants(parent, children);
  }

  private async settleDescendants(
    parent: SchedulerEntry,
    children: readonly SchedulerEntry[],
  ): Promise<readonly unknown[]> {
    const settled = await Promise.allSettled(
      children.map(({ promise }) => promise),
    );
    if (this.controller.signal.aborted) {
      this.ledger.finish(parent.task.node.identity.runId);
      parent.delegating = false;
      throw cancellationError(this.controller.signal);
    }

    await new Promise<void>((resolve, reject) => {
      this.queue.push({
        entry: parent,
        resume: true,
        resumeResolve: resolve,
        resumeReject: reject,
      });
      this.dispatch();
    });
    parent.delegating = false;
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error("A subagent descendant failed.");
    }
    return settled.map(
      (result) => (result as PromiseFulfilledResult<unknown>).value,
    );
  }

  async run(
    tasks: readonly SubagentTreeSchedulerTaskV2[],
  ): Promise<readonly unknown[]> {
    if (this.controller.signal.aborted)
      throw cancellationError(this.controller.signal);
    this.validateTasks(tasks);
    this.ledger.reserveLaunches(tasks.map(({ node }) => node));
    const entries = this.createEntries(tasks);
    this.enqueue(entries);
    const settled = await Promise.allSettled(
      entries.map(({ promise }) => promise),
    );
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
    return settled.map(
      (result) => (result as PromiseFulfilledResult<unknown>).value,
    );
  }

  /** Remove one exact queued child without cancelling or delaying its siblings. */
  cancelRun(
    runId: string,
    reason: Error = new Error("Subagent run cancelled."),
  ): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.state !== "queued") return false;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index]!;
      if (item.entry !== entry || item.resume) continue;
      this.queue.splice(index, 1);
    }
    this.ledger.finish(runId);
    entry.state = "settled";
    if (entry.task.cancelledResult !== undefined) {
      entry.resolve(entry.task.cancelledResult);
    } else {
      entry.reject(reason);
    }
    this.dispatch();
    return true;
  }

  cancel(reason: Error = new Error("Subagent tree cancelled.")): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason);
    for (const item of this.queue
      .splice(0)
      .sort((a, b) => a.entry.sequence - b.entry.sequence)) {
      item.resumeReject?.(reason);
      const entry = item.entry;
      if (item.resume || entry.state !== "queued") continue;
      entry.reject(reason);
      this.ledger.finish(entry.task.node.identity.runId);
      entry.state = "settled";
    }
    // Running entries retain ownership until their execute() path observes the
    // abort and finishes its bounded settlement protocol. This prevents the
    // supervisor from publishing terminal state while a provider is still in
    // the cancellation grace window.
  }
}
