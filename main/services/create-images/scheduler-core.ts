// Pure planning and ready-set dispatch for Create Images. Electron-free: the
// executor supplies ledger writes and provider calls through hooks.
import { topologicalWorkflowOrder, validateWorkflowGraph } from "../../../renderer/shared/images/ports.js";
import type { OutputRef, RunScope, RunState } from "../../../renderer/shared/images/run-types.js";
import type { ImageNodeType, WorkflowDocV1, WorkflowEdge, WorkflowNode } from "../../../renderer/shared/images/schema.js";

export type NodeValue = { kind: "text"; text: string } | { kind: "images"; images: OutputRef[] };

export interface PlannedStep {
  nodeId: string;
  type: ImageNodeType;
  variant: number;
  /** Inputs wired to this step, in document edge order. */
  inputs: readonly { port: string; source: string }[];
  /** Prompt text or Image Input asset, resolved at plan time. */
  local?: NodeValue;
  provider?: { provider: string; model: string };
}

export interface PlannedRequest {
  nodeId: string;
  variant: number;
  provider: string;
  model: string;
  referenceCount: number;
  knownReferences: OutputRef[];
  /** Reference inputs produced earlier in this same run; their images exist only after they finish. */
  pendingReferenceCount: number;
}

export interface RunPlan {
  scope: RunScope;
  steps: PlannedStep[];
  requests: PlannedRequest[];
  /** Upstream Generate outputs outside the scope, taken from their latest succeeded attempt. */
  seeded: Record<string, NodeValue>;
}

export interface PlanIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

export interface PlanContext {
  priorOutputs: Readonly<Record<string, readonly OutputRef[]>>;
  asset(assetId: string): OutputRef | undefined;
  maxRequests: number;
}

export type PlanResult = { ok: true; plan: RunPlan } | { ok: false; issues: PlanIssue[] };

function group(edges: readonly WorkflowEdge[], key: "source" | "target"): Map<string, WorkflowEdge[]> {
  const grouped = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const list = grouped.get(edge[key]) ?? [];
    list.push(edge);
    grouped.set(edge[key], list);
  }
  return grouped;
}

function toStep(node: WorkflowNode, edges: readonly WorkflowEdge[], context: PlanContext): PlannedStep {
  const base = {
    nodeId: node.id,
    type: node.type,
    variant: 0,
    inputs: edges.map((edge) => ({ port: edge.targetPort, source: edge.source })),
  };
  switch (node.type) {
    case "prompt":
      return { ...base, local: { kind: "text", text: node.data.text } };
    case "image-input":
      return { ...base, local: { kind: "images", images: [context.asset(node.data.assetId!)!] } };
    case "generate-image":
      return { ...base, provider: { provider: node.data.model!.provider, model: node.data.model!.id } };
    case "output":
      return base;
  }
}

export function planRun(doc: WorkflowDocV1, scope: RunScope, context: PlanContext): PlanResult {
  const structural = validateWorkflowGraph(doc);
  if (structural.length > 0) return { ok: false, issues: structural };
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  if (scope.kind !== "all" && !nodes.has(scope.nodeId)) {
    return { ok: false, issues: [{ code: "unknown_scope", message: "That node is no longer in the workflow." }] };
  }
  if (scope.kind === "node-only" && nodes.get(scope.nodeId)!.type !== "generate-image") {
    return {
      ok: false,
      issues: [{ code: "node_only_requires_generate", nodeId: scope.nodeId, message: "Only a Generate Image node can run on its own." }],
    };
  }
  const incoming = group(doc.edges, "target");
  const outgoing = group(doc.edges, "source");

  const included = new Set<string>();
  if (scope.kind === "all") {
    for (const node of doc.nodes) included.add(node.id);
  } else if (scope.kind === "node-only") {
    included.add(scope.nodeId);
  } else {
    const queue = [scope.nodeId];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (included.has(id)) continue;
      included.add(id);
      for (const edge of outgoing.get(id) ?? []) queue.push(edge.target);
    }
  }

  // Walk upstream: free local nodes are recomputed; Generate nodes are seeded, never re-run.
  const seeded: Record<string, NodeValue> = {};
  const issues: PlanIssue[] = [];
  const pending = [...included];
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const edge of incoming.get(id) ?? []) {
      const source = nodes.get(edge.source)!;
      if (included.has(source.id) || seeded[source.id] || issues.some((issue) => issue.nodeId === source.id)) continue;
      if (source.type === "generate-image") {
        const prior = context.priorOutputs[source.id];
        if (prior && prior.length > 0) {
          seeded[source.id] = { kind: "images", images: [...prior] };
        } else {
          issues.push({
            code: "upstream_not_run",
            nodeId: source.id,
            message: "Run upstream first: this Generate Image node has no images yet.",
          });
        }
      } else {
        included.add(source.id);
        pending.push(source.id);
      }
    }
  }

  issues.push(...validateWorkflowGraph(doc, { forRun: true, nodeIds: included }));
  for (const id of included) {
    const node = nodes.get(id)!;
    if (node.type === "image-input" && node.data.assetId && !context.asset(node.data.assetId)) {
      issues.push({ code: "missing_asset", nodeId: id, message: "This image is no longer available. Choose it again." });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const order = topologicalWorkflowOrder(doc).order.filter((id) => included.has(id));
  const steps = order.map((id) => toStep(nodes.get(id)!, incoming.get(id) ?? [], context));
  const stepById = new Map(steps.map((step) => [step.nodeId, step]));
  const requests: PlannedRequest[] = steps
    .filter((step) => step.provider)
    .map((step) => {
      const knownReferences: OutputRef[] = [];
      let pendingReferenceCount = 0;
      for (const input of step.inputs) {
        if (input.port !== "references") continue;
        const value = seeded[input.source] ?? stepById.get(input.source)?.local;
        if (value?.kind === "images") knownReferences.push(...value.images);
        else pendingReferenceCount += 1;
      }
      return {
        nodeId: step.nodeId,
        variant: step.variant,
        provider: step.provider!.provider,
        model: step.provider!.model,
        referenceCount: knownReferences.length + pendingReferenceCount,
        knownReferences,
        pendingReferenceCount,
      };
    });
  if (requests.length === 0) {
    return { ok: false, issues: [{ code: "no_requests", message: "Add a Generate Image node to run this workflow." }] };
  }
  if (requests.length > context.maxRequests) {
    return {
      ok: false,
      issues: [
        {
          code: "request_cap",
          message: `This run needs ${requests.length} image requests. Create Images allows at most ${context.maxRequests} per run for now.`,
        },
      ],
    };
  }
  return { ok: true, plan: { scope, steps, requests, seeded } };
}

/** What a consent approved: re-planning at start must reproduce it exactly. */
export function planDigest(plan: RunPlan): string {
  return JSON.stringify({
    scope: plan.scope,
    steps: plan.steps.map((step) => step.nodeId),
    requests: plan.requests.map((request) => [
      request.nodeId,
      request.variant,
      request.provider,
      request.model,
      request.knownReferences.map((reference) => reference.assetId),
      request.pendingReferenceCount,
    ]),
  });
}

/**
 * Nodes whose output predates a newer result upstream of them. A node-only run
 * re-runs one Generate node and leaves its descendants' outputs in place; this
 * is how they are recognised afterwards. Only Generate results count as a newer
 * upstream: free local nodes are recomputed by every run and never change what
 * a descendant produced. A node with no output has not run, so it is not stale.
 */
export function staleNodeIds(doc: WorkflowDocV1, sequence: Readonly<Record<string, number>>): string[] {
  const generating = new Set(doc.nodes.filter((node) => node.type === "generate-image").map((node) => node.id));
  const incoming = group(doc.edges, "target");
  const newestUpstream = new Map<string, number>();
  const stale: string[] = [];
  for (const id of topologicalWorkflowOrder(doc).order) {
    let newest = 0;
    for (const edge of incoming.get(id) ?? []) {
      const own = generating.has(edge.source) ? (sequence[edge.source] ?? 0) : 0;
      newest = Math.max(newest, own, newestUpstream.get(edge.source) ?? 0);
    }
    newestUpstream.set(id, newest);
    const produced = sequence[id];
    if (produced !== undefined && newest > produced) stale.push(id);
  }
  return stale;
}

export interface StepInputs {
  prompt: string;
  references: OutputRef[];
}

export type StepOutcome = { ok: true; value: NodeValue } | { ok: false; state: "failed" | "cancelled" };

export interface StepTransition {
  nodeId: string;
  variant: number;
  state: "succeeded" | "failed" | "skipped" | "cancelled";
  value?: NodeValue;
  /** True when executeProvider ran the step and already recorded its ledger row. */
  executed: boolean;
  /** Set when the step failed because the executor itself threw, not because the provider failed. */
  errorCode?: string;
}

export const MAX_RUN_CONCURRENCY = 4;
export const DEFAULT_RUN_CONCURRENCY = 2;

/** Whatever the caller asks for, a run dispatches between one and four provider requests at once. */
export function clampRunConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RUN_CONCURRENCY;
  return Math.min(MAX_RUN_CONCURRENCY, Math.max(1, Math.trunc(value)));
}

export interface RunPlanHooks {
  /** Clamped to 1 through 4 by runPlan. */
  concurrency: number;
  signal: AbortSignal;
  executeProvider(step: PlannedStep, inputs: StepInputs, signal: AbortSignal): Promise<StepOutcome>;
  onSettled(transitions: StepTransition[]): void;
}

function sourcesOf(step: PlannedStep, port: string, values: ReadonlyMap<string, NodeValue>): NodeValue[] {
  return step.inputs
    .filter((input) => input.port === port)
    .map((input) => values.get(input.source))
    .filter((value): value is NodeValue => value !== undefined);
}

function imagesOf(values: readonly NodeValue[]): OutputRef[] {
  return values.flatMap((value) => (value.kind === "images" ? value.images : []));
}

export async function runPlan(plan: RunPlan, hooks: RunPlanHooks): Promise<Map<string, StepTransition["state"]>> {
  const steps = new Map(plan.steps.map((step) => [step.nodeId, step]));
  const values = new Map<string, NodeValue>(Object.entries(plan.seeded));
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of plan.steps) {
    const sources = new Set(step.inputs.map((input) => input.source).filter((source) => steps.has(source)));
    waiting.set(step.nodeId, sources.size);
    for (const source of sources) dependents.set(source, [...(dependents.get(source) ?? []), step.nodeId]);
  }
  const settled = new Map<string, StepTransition["state"]>();
  const localReady: string[] = [];
  const providerReady: string[] = [];
  const running = new Map<string, Promise<void>>();
  let batch: StepTransition[] = [];

  const enqueue = (id: string) => (steps.get(id)!.provider ? providerReady : localReady).push(id);
  const concurrency = clampRunConcurrency(hooks.concurrency);
  const settle = (id: string, state: StepTransition["state"], executed: boolean, value?: NodeValue, errorCode?: string) => {
    if (settled.has(id)) return;
    settled.set(id, state);
    batch.push({
      nodeId: id,
      variant: steps.get(id)!.variant,
      state,
      executed,
      ...(value ? { value } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    if (state === "succeeded") {
      values.set(id, value!);
      for (const dependent of dependents.get(id) ?? []) {
        const left = waiting.get(dependent)! - 1;
        waiting.set(dependent, left);
        if (left === 0 && !settled.has(dependent)) enqueue(dependent);
      }
    } else {
      const downstream = state === "cancelled" ? "cancelled" : "skipped";
      for (const dependent of dependents.get(id) ?? []) settle(dependent, downstream, false);
    }
  };
  const flush = () => {
    if (batch.length === 0) return;
    const transitions = batch;
    batch = [];
    hooks.onSettled(transitions);
  };

  for (const step of plan.steps) if (waiting.get(step.nodeId) === 0) enqueue(step.nodeId);
  while (true) {
    if (hooks.signal.aborted) {
      for (const step of plan.steps) {
        if (!settled.has(step.nodeId) && !running.has(step.nodeId)) settle(step.nodeId, "cancelled", false);
      }
      localReady.length = 0;
      providerReady.length = 0;
    }
    while (localReady.length > 0) {
      const step = steps.get(localReady.shift()!)!;
      const value: NodeValue = step.local ?? { kind: "images", images: imagesOf(sourcesOf(step, "images", values)) };
      settle(step.nodeId, "succeeded", false, value);
    }
    while (providerReady.length > 0 && running.size < concurrency) {
      const step = steps.get(providerReady.shift()!)!;
      if (settled.has(step.nodeId)) continue;
      const prompt = sourcesOf(step, "prompt", values).find((value) => value.kind === "text");
      const inputs: StepInputs = {
        prompt: prompt?.kind === "text" ? prompt.text : "",
        references: imagesOf(sourcesOf(step, "references", values)),
      };
      const task = hooks.executeProvider(step, inputs, hooks.signal).then(
        (outcome) => {
          running.delete(step.nodeId);
          if (outcome.ok) settle(step.nodeId, "succeeded", true, outcome.value);
          else settle(step.nodeId, outcome.state, true);
        },
        () => {
          // An executor fault is recorded through onSettled because executeProvider did not record it.
          running.delete(step.nodeId);
          settle(step.nodeId, "failed", false, undefined, "executor-fault");
        },
      );
      running.set(step.nodeId, task);
    }
    flush();
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  for (const step of plan.steps) if (!settled.has(step.nodeId)) settle(step.nodeId, "cancelled", false);
  flush();
  return settled;
}

export function summarizeRunState(
  plan: RunPlan,
  states: ReadonlyMap<string, StepTransition["state"]>,
  aborted: boolean,
): Exclude<RunState, "running" | "interrupted"> {
  if (aborted) return "cancelled";
  if (plan.steps.every((step) => states.get(step.nodeId) === "succeeded")) return "succeeded";
  const generated = plan.steps.some((step) => step.provider && states.get(step.nodeId) === "succeeded");
  return generated ? "partial" : "failed";
}
