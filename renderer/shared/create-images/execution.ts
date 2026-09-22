import {
  topologicalWorkflowOrder,
  validateWorkflowGraph,
  type WorkflowGraphIssue,
} from "./ports.js";
import { parseWorkflowDocument, type WorkflowDocumentV1, type WorkflowNodeV1 } from "./schema.js";

export type WorkflowRunScope =
  | { kind: "all" }
  | { kind: "from-node"; nodeId: string; downstreamPath?: readonly string[] };

export interface WorkflowExecutionPlan {
  workflowId: string;
  workflowRevision: number;
  scope: WorkflowRunScope;
  snapshot: WorkflowDocumentV1;
  orderedNodeIds: string[];
  dependencies: Readonly<Record<string, readonly string[]>>;
}

export const CREATE_IMAGES_MAX_DOWNSTREAM_PATH_CHOICES = 24;
export const CREATE_IMAGES_MAX_DOWNSTREAM_PATH_SEARCH_STEPS = 25_000;

export interface WorkflowDownstreamPathChoice {
  id: string;
  downstreamPath: readonly string[];
  terminalNodeId: string;
}

export interface WorkflowDownstreamPathChoices {
  choices: readonly WorkflowDownstreamPathChoice[];
  truncated: boolean;
  overflowReason?: "choice-limit" | "search-budget";
  searchSteps: number;
}

export class WorkflowPlanError extends Error {
  constructor(readonly issues: readonly WorkflowGraphIssue[]) {
    super(issues[0]?.message ?? "The workflow cannot run.");
    this.name = "WorkflowPlanError";
  }
}

function adjacency(document: WorkflowDocumentV1): {
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
} {
  const incoming = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of document.edges) {
    incoming.get(edge.target)?.push(edge.source);
    outgoing.get(edge.source)?.push(edge.target);
  }
  return { incoming, outgoing };
}

/**
 * Enumerate complete, connected paths from one node to downstream sinks.
 *
 * The traversal is iterative and has both a result cap and a hard search-step
 * budget. Outgoing nodes use workflow node order, then opaque node ID, so an
 * identical immutable revision always presents choices in the same order.
 * Parallel edges are intentionally deduplicated because they produce the same
 * executable node path.
 */
export function enumerateWorkflowDownstreamPaths(
  document: WorkflowDocumentV1,
  startNodeId: string,
): WorkflowDownstreamPathChoices {
  if (!document.nodes.some((node) => node.id === startNodeId)) {
    throw new WorkflowPlanError([
      {
        code: "unknown_node",
        nodeId: startNodeId,
        message: "The selected run node is not in this workflow revision.",
      },
    ]);
  }
  const nodeOrder = new Map(document.nodes.map((node, index) => [node.id, index]));
  const outgoingSets = new Map(document.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of document.edges) {
    if (nodeOrder.has(edge.source) && nodeOrder.has(edge.target)) {
      outgoingSets.get(edge.source)?.add(edge.target);
    }
  }
  const outgoing = new Map<string, string[]>();
  for (const [nodeId, targets] of outgoingSets) {
    outgoing.set(
      nodeId,
      [...targets].sort(
        (left, right) =>
          (nodeOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (nodeOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
      ),
    );
  }

  const collected: WorkflowDownstreamPathChoice[] = [];
  const path = [startNodeId];
  const inPath = new Set(path);
  const stack: Array<{ nodeId: string; nextTargetIndex: number }> = [
    { nodeId: startNodeId, nextTargetIndex: 0 },
  ];
  let searchSteps = 0;
  let overflowReason: WorkflowDownstreamPathChoices["overflowReason"];

  while (stack.length > 0) {
    if (searchSteps >= CREATE_IMAGES_MAX_DOWNSTREAM_PATH_SEARCH_STEPS) {
      overflowReason = "search-budget";
      break;
    }
    const frame = stack[stack.length - 1]!;
    const targets = outgoing.get(frame.nodeId) ?? [];
    if (targets.length === 0 && path.length > 1) {
      const downstreamPath = path.slice(1);
      collected.push({
        id: `path:${collected.length + 1}`,
        downstreamPath,
        terminalNodeId: downstreamPath[downstreamPath.length - 1]!,
      });
      if (collected.length > CREATE_IMAGES_MAX_DOWNSTREAM_PATH_CHOICES) {
        overflowReason = "choice-limit";
        break;
      }
      const removed = path.pop();
      if (removed) inPath.delete(removed);
      stack.pop();
      continue;
    }
    const target = targets[frame.nextTargetIndex];
    if (target === undefined) {
      const removed = path.pop();
      if (removed) inPath.delete(removed);
      stack.pop();
      continue;
    }
    frame.nextTargetIndex += 1;
    searchSteps += 1;
    if (inPath.has(target)) continue;
    path.push(target);
    inPath.add(target);
    stack.push({ nodeId: target, nextTargetIndex: 0 });
  }

  return {
    choices: collected.slice(0, CREATE_IMAGES_MAX_DOWNSTREAM_PATH_CHOICES),
    truncated: overflowReason !== undefined,
    ...(overflowReason ? { overflowReason } : {}),
    searchSteps,
  };
}

function traverseMany(
  starts: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visited = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const next of edges.get(current) ?? []) pending.push(next);
  }
  return visited;
}

function traverse(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  return traverseMany([start], edges);
}

function scopedDocument(document: WorkflowDocumentV1, scope: WorkflowRunScope): WorkflowDocumentV1 {
  if (scope.kind === "all") return document;
  if (!document.nodes.some((node) => node.id === scope.nodeId)) {
    throw new WorkflowPlanError([
      {
        code: "unknown_node",
        nodeId: scope.nodeId,
        message: "The selected run node is not in this workflow revision.",
      },
    ]);
  }
  const { incoming, outgoing } = adjacency(document);
  const included = new Set<string>();
  const selectedPath = [scope.nodeId, ...(scope.downstreamPath ?? [])];
  const reachable = traverse(scope.nodeId, outgoing);
  for (let index = 1; index < selectedPath.length; index += 1) {
    const previous = selectedPath[index - 1];
    const current = selectedPath[index];
    const connected = document.edges.some(
      (edge) => edge.source === previous && edge.target === current,
    );
    if (!current || !reachable.has(current) || !connected) {
      throw new WorkflowPlanError([
        {
          code: "invalid_run_scope",
          nodeId: current,
          message: "The selected downstream run path is not connected in this workflow revision.",
        },
      ]);
    }
  }
  if (new Set(selectedPath).size !== selectedPath.length) {
    throw new WorkflowPlanError([
      {
        code: "invalid_run_scope",
        nodeId: scope.nodeId,
        message: "The selected downstream run path contains the same node more than once.",
      },
    ]);
  }
  for (const nodeId of traverseMany(selectedPath, incoming)) included.add(nodeId);
  if (scope.downstreamPath !== undefined) {
    const selectedOnlyNodeIds = traverse(scope.nodeId, incoming);
    const explicitPathNodeIds = new Set(selectedPath);
    const implicitDownstreamNodeId = [...included].find(
      (nodeId) => !selectedOnlyNodeIds.has(nodeId) && !explicitPathNodeIds.has(nodeId),
    );
    if (implicitDownstreamNodeId) {
      throw new WorkflowPlanError([
        {
          code: "invalid_run_scope",
          nodeId: implicitDownstreamNodeId,
          message:
            "The selected downstream path requires additional branch work that was not explicitly selected.",
        },
      ]);
    }
  }
  return {
    ...document,
    nodes: document.nodes.filter((node) => included.has(node.id)),
    edges: document.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

export interface WorkflowRunScopeAnalysis {
  executable: boolean;
  orderedNodeIds: readonly string[];
}

export function analyzeWorkflowRunScope(
  document: WorkflowDocumentV1,
  scope: WorkflowRunScope,
): WorkflowRunScopeAnalysis {
  try {
    const scoped = scopedDocument(document, scope);
    if (validateWorkflowGraph(scoped, { forRun: true }).length > 0) {
      return { executable: false, orderedNodeIds: [] };
    }
    const topological = topologicalWorkflowOrder(scoped);
    return topological.issues.length === 0
      ? { executable: true, orderedNodeIds: topological.order }
      : { executable: false, orderedNodeIds: [] };
  } catch (error) {
    if (error instanceof WorkflowPlanError) return { executable: false, orderedNodeIds: [] };
    throw error;
  }
}

export function isWorkflowRunScopeExecutable(
  document: WorkflowDocumentV1,
  scope: WorkflowRunScope,
): boolean {
  return analyzeWorkflowRunScope(document, scope).executable;
}

export function isWorkflowDownstreamPathExplicit(
  document: WorkflowDocumentV1,
  startNodeId: string,
  downstreamPath: readonly string[],
): boolean {
  if (downstreamPath.length === 0) return false;
  const selectedOnly = analyzeWorkflowRunScope(document, {
    kind: "from-node",
    nodeId: startNodeId,
  });
  if (!selectedOnly.executable) return false;
  const candidate = analyzeWorkflowRunScope(document, {
    kind: "from-node",
    nodeId: startNodeId,
    downstreamPath,
  });
  if (!candidate.executable) return false;
  const selectedOnlyNodeIds = new Set(selectedOnly.orderedNodeIds);
  const explicitNodeIds = new Set(downstreamPath);
  return candidate.orderedNodeIds.every(
    (nodeId) => selectedOnlyNodeIds.has(nodeId) || explicitNodeIds.has(nodeId),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableWorkflowSnapshot(document: WorkflowDocumentV1): WorkflowDocumentV1 {
  const parsed = parseWorkflowDocument(document);
  if (!parsed.success) {
    throw new Error(parsed.issues[0]?.message ?? "The workflow snapshot is invalid.");
  }
  return deepFreeze(parsed.value);
}

export function planWorkflowExecution(
  document: WorkflowDocumentV1,
  scope: WorkflowRunScope,
): WorkflowExecutionPlan {
  const snapshot = immutableWorkflowSnapshot(document);
  const snapshotScope: WorkflowRunScope =
    scope.kind === "all"
      ? { kind: "all" }
      : {
          kind: "from-node",
          nodeId: scope.nodeId,
          ...(scope.downstreamPath ? { downstreamPath: [...scope.downstreamPath] } : {}),
        };
  const scoped = scopedDocument(snapshot, snapshotScope);
  const issues = validateWorkflowGraph(scoped, { forRun: true });
  if (issues.length > 0) throw new WorkflowPlanError(issues);
  const topological = topologicalWorkflowOrder(scoped);
  if (topological.issues.length > 0) throw new WorkflowPlanError(topological.issues);
  const included = new Set(topological.order);
  const dependencies: Record<string, string[]> = Object.fromEntries(
    topological.order.map((nodeId) => [nodeId, []]),
  );
  for (const edge of scoped.edges) {
    if (included.has(edge.source) && included.has(edge.target)) {
      dependencies[edge.target]?.push(edge.source);
    }
  }
  const order = new Map(topological.order.map((nodeId, index) => [nodeId, index]));
  for (const values of Object.values(dependencies)) {
    values.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  }
  return deepFreeze({
    workflowId: snapshot.id,
    workflowRevision: snapshot.revision,
    scope: snapshotScope,
    snapshot,
    orderedNodeIds: topological.order,
    dependencies,
  });
}

export type WorkflowNodeRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface WorkflowNodeRunTransition {
  workflowId: string;
  workflowRevision: number;
  runId: string;
  nodeId: string;
  status: WorkflowNodeRunStatus;
  sequence: number;
  error?: string;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  workflowRevision: number;
  runId: string;
  statuses: Readonly<Record<string, WorkflowNodeRunStatus>>;
  outputs: ReadonlyMap<string, unknown>;
  transitions: readonly WorkflowNodeRunTransition[];
}

export interface WorkflowNodeExecutionContext {
  node: WorkflowNodeV1;
  workflowId: string;
  workflowRevision: number;
  signal: AbortSignal;
  dependencyOutputs: ReadonlyMap<string, unknown>;
}

export interface RunWorkflowPlanOptions {
  runId: string;
  concurrency: 1 | 2 | 3 | 4;
  signal?: AbortSignal;
  executeNode(context: WorkflowNodeExecutionContext): Promise<unknown>;
  onTransition?(transition: WorkflowNodeRunTransition): void;
}

type SettledExecution =
  | { nodeId: string; ok: true; output: unknown }
  | { nodeId: string; ok: false; error: unknown };

export interface WorkflowRunTransitionCursor {
  workflowId: string;
  workflowRevision: number;
  runId: string;
  lastSequence: number;
}

/** Reject cross-run, stale, duplicate, and out-of-order notifications. */
export function reduceWorkflowRunTransition(
  cursor: WorkflowRunTransitionCursor,
  transition: WorkflowNodeRunTransition,
): WorkflowRunTransitionCursor {
  if (
    cursor.workflowId !== transition.workflowId ||
    cursor.workflowRevision !== transition.workflowRevision ||
    cursor.runId !== transition.runId ||
    transition.sequence !== cursor.lastSequence + 1
  ) {
    return cursor;
  }
  return { ...cursor, lastSequence: transition.sequence };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Node execution failed.";
}

function hasNonSuccessDependency(
  dependencies: readonly string[],
  statuses: ReadonlyMap<string, WorkflowNodeRunStatus>,
): boolean {
  return dependencies.some((dependency) => {
    const status = statuses.get(dependency);
    return status === "failed" || status === "cancelled" || status === "blocked";
  });
}

function allDependenciesSucceeded(
  dependencies: readonly string[],
  statuses: ReadonlyMap<string, WorkflowNodeRunStatus>,
): boolean {
  return dependencies.every((dependency) => statuses.get(dependency) === "succeeded");
}

export async function runWorkflowPlan(
  document: WorkflowDocumentV1,
  plan: WorkflowExecutionPlan,
  options: RunWorkflowPlanOptions,
): Promise<WorkflowExecutionResult> {
  if (document.id !== plan.workflowId || document.revision !== plan.workflowRevision) {
    throw new Error("The execution plan does not match this workflow revision.");
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 4
  ) {
    throw new Error("Create Images concurrency must be between 1 and 4.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(options.runId)) {
    throw new Error("Create Images runs require an opaque run ID.");
  }
  const nodes = new Map(plan.snapshot.nodes.map((node) => [node.id, node]));
  for (const nodeId of plan.orderedNodeIds) {
    if (!nodes.has(nodeId)) throw new Error(`Execution plan references missing node "${nodeId}".`);
  }

  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const statuses = new Map<string, WorkflowNodeRunStatus>(
    plan.orderedNodeIds.map((nodeId) => [nodeId, "queued"]),
  );
  const outputs = new Map<string, unknown>();
  const transitions: WorkflowNodeRunTransition[] = [];
  const active = new Map<string, Promise<SettledExecution>>();
  const cancelled = new Promise<typeof CANCELLED_RACE>((resolve) => {
    const cancel = (): void => resolve(CANCELLED_RACE);
    if (controller.signal.aborted) cancel();
    else controller.signal.addEventListener("abort", cancel, { once: true });
  });
  let sequence = 0;
  const transition = (nodeId: string, status: WorkflowNodeRunStatus, error?: string): void => {
    statuses.set(nodeId, status);
    sequence += 1;
    const event: WorkflowNodeRunTransition = {
      workflowId: plan.workflowId,
      workflowRevision: plan.workflowRevision,
      runId: options.runId,
      nodeId,
      status,
      sequence,
      ...(error ? { error } : {}),
    };
    transitions.push(event);
    options.onTransition?.(event);
  };

  try {
    while ([...statuses.values()].some((status) => status === "queued" || status === "running")) {
      if (controller.signal.aborted) {
        for (const nodeId of plan.orderedNodeIds) {
          const status = statuses.get(nodeId);
          if (status === "queued" || status === "running") {
            transition(nodeId, "cancelled", "The workflow run was cancelled.");
          }
        }
        // Executor promises already normalize both fulfillment and rejection.
        // Detach them: a provider that ignores AbortSignal cannot hold the run open,
        // and no late settlement has a path back into outputs or transitions.
        active.clear();
        break;
      }
      for (const nodeId of plan.orderedNodeIds) {
        if (statuses.get(nodeId) !== "queued") continue;
        const dependencies = plan.dependencies[nodeId] ?? [];
        if (hasNonSuccessDependency(dependencies, statuses)) {
          transition(nodeId, "blocked", "A required upstream node did not succeed.");
        }
      }

      for (const nodeId of plan.orderedNodeIds) {
        if (active.size >= options.concurrency) break;
        if (statuses.get(nodeId) !== "queued") continue;
        const dependencies = plan.dependencies[nodeId] ?? [];
        if (!allDependenciesSucceeded(dependencies, statuses)) continue;
        const node = nodes.get(nodeId);
        if (!node) continue;
        transition(nodeId, "running");
        const dependencyOutputs = new Map<string, unknown>();
        for (const dependency of dependencies) {
          if (outputs.has(dependency)) dependencyOutputs.set(dependency, outputs.get(dependency));
        }
        const context = {
          node,
          workflowId: plan.workflowId,
          workflowRevision: plan.workflowRevision,
          signal: controller.signal,
          dependencyOutputs,
        };
        const execution = Promise.resolve()
          .then(() => options.executeNode(context))
          .then(
            (output): SettledExecution => ({ nodeId, ok: true, output }),
            (error): SettledExecution => ({ nodeId, ok: false, error }),
          );
        active.set(nodeId, execution);
      }

      if (active.size === 0) {
        for (const nodeId of plan.orderedNodeIds) {
          if (statuses.get(nodeId) === "queued") {
            transition(nodeId, "blocked", "The node's dependencies could not be scheduled.");
          }
        }
        continue;
      }

      const settled = await Promise.race([...active.values(), cancelled]);
      if ("cancelled" in settled) continue;
      active.delete(settled.nodeId);
      if (!settled.ok) {
        transition(settled.nodeId, "failed", errorMessage(settled.error));
      } else {
        outputs.set(settled.nodeId, settled.output);
        transition(settled.nodeId, "succeeded");
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
  }

  return {
    workflowId: plan.workflowId,
    workflowRevision: plan.workflowRevision,
    runId: options.runId,
    statuses: Object.fromEntries(statuses),
    outputs,
    transitions,
  };
}

const CANCELLED_RACE = { cancelled: true } as const;
