import { createHash } from "node:crypto";
import {
  planWorkflowExecution,
  type WorkflowExecutionPlan,
  type WorkflowRunScope,
} from "../../../renderer/shared/create-images/execution.js";
import { CREATE_IMAGES_NODE_DEFINITIONS } from "../../../renderer/shared/create-images/ports.js";
import type {
  WorkflowDocumentV1,
  WorkflowNodeV1,
} from "../../../renderer/shared/create-images/schema.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,191}$/u;
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_TOTAL_RETRY_DELAY_MS = 10 * 60_000;

export type CoordinatorExecutionLane = "local" | "remote";

export type CoordinatorNodeStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked"
  | "ambiguous";

export type CoordinatorRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_attention";

export type CoordinatorErrorCode =
  | "cancelled"
  | "dependency-unschedulable"
  | "execution-failed"
  | "interrupted"
  | "output-invalid"
  | "output-publication-failed"
  | "provider-refused"
  | "provider-unavailable"
  | "rate-limited"
  | "submission-ambiguous"
  | "upstream-blocked";

export type CoordinatorRetrySafety =
  | "never"
  | "local-safe"
  | "confirmed-not-submitted"
  | "same-idempotency-key";

export type CoordinatorAttemptResult =
  | { kind: "success"; output: unknown }
  | {
      kind: "failure";
      error: string;
      retrySafety: CoordinatorRetrySafety;
      idempotencyKey?: string;
      errorCode?: CoordinatorErrorCode;
    }
  | {
      kind: "rate-limited";
      error: string;
      retrySafety: CoordinatorRetrySafety;
      retryAfterMs?: number;
      idempotencyKey?: string;
      errorCode?: CoordinatorErrorCode;
    }
  | { kind: "cancelled"; error?: string }
  | { kind: "ambiguous-submit"; error: string };

export interface CoordinatorRunIdentity {
  workflowId: string;
  workflowRevision: number;
  runId: string;
}

interface CoordinatorEventBase extends CoordinatorRunIdentity {
  sequence: number;
  atMs: number;
}

export type CoordinatorEvent =
  | (CoordinatorEventBase & {
      kind: "run";
      status: Exclude<CoordinatorRunStatus, "pending">;
    })
  | (CoordinatorEventBase & {
      kind: "node";
      nodeId: string;
      status: CoordinatorNodeStatus;
      attempt: number;
      errorCode?: CoordinatorErrorCode;
      retryDelayMs?: number;
      retrySafety?: CoordinatorRetrySafety;
    })
  | (CoordinatorEventBase & {
      kind: "remote-job";
      nodeId: string;
      attempt: number;
      remoteJobId: string;
    });

export type CoordinatorEventPayload =
  | {
      kind: "run";
      status: Exclude<CoordinatorRunStatus, "pending">;
    }
  | {
      kind: "node";
      nodeId: string;
      status: CoordinatorNodeStatus;
      attempt: number;
      errorCode?: CoordinatorErrorCode;
      retryDelayMs?: number;
      retrySafety?: CoordinatorRetrySafety;
    }
  | {
      kind: "remote-job";
      nodeId: string;
      attempt: number;
      remoteJobId: string;
    };

export interface CoordinatorClock {
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface CoordinatorJitter {
  /** A deterministic sample in the inclusive range 0 through 1. */
  sample(): number;
}

export interface CoordinatorRetryPolicy {
  maxRetriesPerNode: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxTotalDelayMs: number;
  jitterRatio: number;
  retryRemoteNotSubmitted: boolean;
  retryRemoteIdempotent: boolean;
}

export interface CoordinatorPlanRecord extends CoordinatorRunIdentity {
  plan: WorkflowExecutionPlan;
  localConcurrency: number;
  remoteConcurrency: number;
}

export interface CoordinatorCancelIntent extends CoordinatorRunIdentity {
  reason: "user" | "renderer-disconnected" | "app-quit";
  remoteJobs: Readonly<Record<string, string>>;
}

export class CoordinatorCancellationRequest extends Error {
  readonly cancellationReason: CoordinatorCancelIntent["reason"];

  constructor(cancellationReason: CoordinatorCancelIntent["reason"]) {
    if (!["user", "renderer-disconnected", "app-quit"].includes(cancellationReason)) {
      throw new Error("The Create Images cancellation reason is invalid.");
    }
    super(`Create Images cancellation requested: ${cancellationReason}.`);
    this.name = "CoordinatorCancellationRequest";
    this.cancellationReason = cancellationReason;
  }
}

export interface CoordinatorRemoteJobRecord extends CoordinatorRunIdentity {
  nodeId: string;
  attempt: number;
  /** Stable for same-idempotency-key retries; fresh after confirmed non-submission. */
  idempotencyKey: string;
  remoteJobId: string;
}

export interface CoordinatorSubmissionPreparedRecord extends CoordinatorRunIdentity {
  nodeId: string;
  attempt: number;
  idempotencyKey: string;
}

export interface CoordinatorDurability {
  persistPlan(record: CoordinatorPlanRecord): Promise<void>;
  appendEvent(event: CoordinatorEvent): Promise<void>;
  persistCancelIntent(intent: CoordinatorCancelIntent): Promise<void>;
  /** Must journal the idempotency key before executeNode may submit remote work. */
  persistSubmissionPrepared(record: CoordinatorSubmissionPreparedRecord): Promise<void>;
  persistRemoteJob(record: CoordinatorRemoteJobRecord): Promise<void>;
  publishOutput(
    record: CoordinatorRunIdentity & { nodeId: string; output: unknown },
  ): Promise<unknown>;
}

export interface CoordinatorNodeExecutionContext extends CoordinatorRunIdentity {
  node: WorkflowNodeV1;
  lane: CoordinatorExecutionLane;
  attempt: number;
  /** Stable for same-idempotency-key retries; fresh after confirmed non-submission. */
  idempotencyKey?: string;
  signal: AbortSignal;
  dependencyOutputs: ReadonlyMap<string, unknown>;
  recordRemoteJobId(remoteJobId: string): Promise<void>;
}

export interface RunWorkflowCoordinatorOptions {
  runId: string;
  localConcurrency: number;
  remoteConcurrency: number;
  clock: CoordinatorClock;
  jitter: CoordinatorJitter;
  retryPolicy: CoordinatorRetryPolicy;
  durability: CoordinatorDurability;
  signal?: AbortSignal;
  executeNode(context: CoordinatorNodeExecutionContext): Promise<CoordinatorAttemptResult>;
  cancelRemoteJob?(record: CoordinatorRemoteJobRecord): Promise<void>;
  onEvent?(event: CoordinatorEvent): void;
}

export interface WorkflowCoordinatorResult extends CoordinatorRunIdentity {
  status: Exclude<CoordinatorRunStatus, "pending" | "running">;
  nodeStatuses: Readonly<Record<string, CoordinatorNodeStatus>>;
  outputs: ReadonlyMap<string, unknown>;
  events: readonly CoordinatorEvent[];
  retryDelayMs: number;
}

type SettledNode = {
  nodeId: string;
  lane: CoordinatorExecutionLane;
  result: CoordinatorAttemptResult;
};

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID_PATTERN.test(value)) throw new Error(`${label} must be an opaque identifier.`);
}

function assertProviderJobId(value: string): void {
  if (!PROVIDER_JOB_ID_PATTERN.test(value)) {
    throw new Error("Remote job ID must be a bounded provider identifier.");
  }
}

function assertConcurrency(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error(`${label} concurrency must be between 1 and 4.`);
  }
}

function validatedPolicy(policy: CoordinatorRetryPolicy): CoordinatorRetryPolicy {
  if (
    !Number.isInteger(policy.maxRetriesPerNode) ||
    policy.maxRetriesPerNode < 0 ||
    policy.maxRetriesPerNode > MAX_RETRIES
  ) {
    throw new Error(`Retry count must be between 0 and ${MAX_RETRIES}.`);
  }
  for (const [label, value, maximum] of [
    ["base delay", policy.baseDelayMs, MAX_RETRY_DELAY_MS],
    ["maximum delay", policy.maxDelayMs, MAX_RETRY_DELAY_MS],
    ["total delay", policy.maxTotalDelayMs, MAX_TOTAL_RETRY_DELAY_MS],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new Error(`Retry ${label} must be an integer between 0 and ${maximum}.`);
    }
  }
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("Retry maximum delay cannot be smaller than the base delay.");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error("Retry jitter ratio must be between 0 and 1.");
  }
  return deepFreeze({ ...policy });
}

function immutableVerifiedPlan(plan: WorkflowExecutionPlan): WorkflowExecutionPlan {
  const rebuilt = planWorkflowExecution(plan.snapshot, plan.scope);
  if (
    rebuilt.workflowId !== plan.workflowId ||
    rebuilt.workflowRevision !== plan.workflowRevision ||
    JSON.stringify(rebuilt.orderedNodeIds) !== JSON.stringify(plan.orderedNodeIds) ||
    JSON.stringify(rebuilt.dependencies) !== JSON.stringify(plan.dependencies)
  ) {
    throw new Error("The Create Images execution plan is stale or has been altered.");
  }
  return rebuilt;
}

export function createWorkflowCoordinatorPlan(
  document: WorkflowDocumentV1,
  scope: WorkflowRunScope,
): WorkflowExecutionPlan {
  return planWorkflowExecution(document, scope);
}

function laneFor(node: WorkflowNodeV1): CoordinatorExecutionLane {
  return CREATE_IMAGES_NODE_DEFINITIONS[node.type].execution;
}

function terminalNode(status: CoordinatorNodeStatus): boolean {
  return ["succeeded", "failed", "cancelled", "blocked", "ambiguous"].includes(status);
}

function dependencyBlocks(status: CoordinatorNodeStatus | undefined): boolean {
  return (
    status === "failed" || status === "cancelled" || status === "blocked" || status === "ambiguous"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The node executor failed without a usable error.";
}

function retryIsAllowed(
  lane: CoordinatorExecutionLane,
  result: Extract<CoordinatorAttemptResult, { kind: "failure" | "rate-limited" }>,
  policy: CoordinatorRetryPolicy,
  expectedIdempotencyKey: string | undefined,
): boolean {
  if (lane === "local") return result.retrySafety === "local-safe";
  if (result.retrySafety === "confirmed-not-submitted") return policy.retryRemoteNotSubmitted;
  return (
    result.retrySafety === "same-idempotency-key" &&
    policy.retryRemoteIdempotent &&
    typeof result.idempotencyKey === "string" &&
    IDEMPOTENCY_KEY_PATTERN.test(result.idempotencyKey) &&
    result.idempotencyKey === expectedIdempotencyKey
  );
}

function idempotencyKeyFor(
  identity: CoordinatorRunIdentity,
  nodeId: string,
  generation: number,
): string {
  const digest = createHash("sha256")
    .update(identity.workflowId)
    .update("\0")
    .update(String(identity.workflowRevision))
    .update("\0")
    .update(identity.runId)
    .update("\0")
    .update(nodeId)
    .update("\0")
    .update(String(generation))
    .digest("hex");
  return `aiden-ci-${digest}`;
}

function retryDelay(
  retryIndex: number,
  result: Extract<CoordinatorAttemptResult, { kind: "failure" | "rate-limited" }>,
  policy: CoordinatorRetryPolicy,
  jitter: CoordinatorJitter,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryIndex);
  const retryAfter = result.kind === "rate-limited" ? (result.retryAfterMs ?? 0) : 0;
  if (!Number.isInteger(retryAfter) || retryAfter < 0 || retryAfter > policy.maxDelayMs) return -1;
  const floor = Math.max(exponential, retryAfter);
  const sample = jitter.sample();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error("The injected retry jitter sample must be between 0 and 1.");
  }
  const factor = 1 + policy.jitterRatio * (sample * 2 - 1);
  return Math.min(policy.maxDelayMs, Math.max(retryAfter, Math.max(0, Math.round(floor * factor))));
}

function finalRunStatus(
  statuses: ReadonlyMap<string, CoordinatorNodeStatus>,
): WorkflowCoordinatorResult["status"] {
  const values = [...statuses.values()];
  if (values.some((status) => status === "ambiguous")) return "needs_attention";
  if (values.some((status) => status === "failed")) return "failed";
  if (values.some((status) => status === "cancelled")) return "cancelled";
  return "succeeded";
}

export async function runWorkflowCoordinator(
  inputPlan: WorkflowExecutionPlan,
  options: RunWorkflowCoordinatorOptions,
): Promise<WorkflowCoordinatorResult> {
  assertOpaqueId(options.runId, "Run ID");
  assertConcurrency(options.localConcurrency, "Local");
  assertConcurrency(options.remoteConcurrency, "Remote");
  const policy = validatedPolicy(options.retryPolicy);
  const plan = immutableVerifiedPlan(inputPlan);
  const identity = deepFreeze({
    workflowId: plan.workflowId,
    workflowRevision: plan.workflowRevision,
    runId: options.runId,
  });
  const nodes = new Map(plan.snapshot.nodes.map((node) => [node.id, node]));
  const statuses = new Map<string, CoordinatorNodeStatus>();
  const outputs = new Map<string, unknown>();
  const nodeAttempts = new Map<string, number>();
  const events: CoordinatorEvent[] = [];
  const active = new Map<string, Promise<SettledNode>>();
  const controllers = new Map<string, AbortController>();
  const remoteJobs = new Map<string, CoordinatorRemoteJobRecord>();
  const uncertainRemoteSubmissions = new Set<string>();
  const remoteCancelIssued = new Set<string>();
  let sequence = 0;
  let lastAtMs = 0;
  let totalRetryDelayMs = 0;
  let acceptSettlements = true;
  let admissionStopped = false;
  let cancelRequested = false;
  let planPersisted = false;
  let cancelPersisted = false;
  let cancelFailure: unknown;
  let cancelWakeResolve!: () => void;
  const cancelWake = new Promise<void>((resolve) => {
    cancelWakeResolve = resolve;
  });
  let cancelTask: Promise<void> | undefined;
  let eventQueue: Promise<void> = Promise.resolve();

  const emit = async (event: CoordinatorEventPayload): Promise<void> => {
    const now = options.clock.now();
    if (!Number.isFinite(now) || now < 0)
      throw new Error("The coordinator clock returned an invalid time.");
    lastAtMs = Math.max(lastAtMs, now);
    sequence += 1;
    const durableEvent = deepFreeze({
      ...identity,
      ...event,
      sequence,
      atMs: lastAtMs,
    } as CoordinatorEvent);
    const append = eventQueue.then(() => options.durability.appendEvent(durableEvent));
    eventQueue = append.catch(() => undefined);
    await append;
    events.push(durableEvent);
    options.onEvent?.(durableEvent);
  };

  const cancelRemote = async (record: CoordinatorRemoteJobRecord): Promise<void> => {
    if (!options.cancelRemoteJob || remoteCancelIssued.has(record.nodeId)) return;
    remoteCancelIssued.add(record.nodeId);
    await options.cancelRemoteJob(record);
  };

  const cancellationReason = (): CoordinatorCancelIntent["reason"] =>
    options.signal?.reason instanceof CoordinatorCancellationRequest
      ? options.signal.reason.cancellationReason
      : "user";

  const beginCancel = (): void => {
    if (cancelTask) return;
    cancelRequested = true;
    admissionStopped = true;
    if (!planPersisted) return;
    cancelTask = (async () => {
      try {
        const remoteJobSnapshot = Object.fromEntries(
          [...remoteJobs.entries()].map(([nodeId, record]) => [nodeId, record.remoteJobId]),
        );
        await options.durability.persistCancelIntent(
          deepFreeze({
            ...identity,
            reason: cancellationReason(),
            remoteJobs: remoteJobSnapshot,
          }),
        );
        cancelPersisted = true;
        acceptSettlements = false;
        for (const controller of controllers.values()) controller.abort(options.signal?.reason);
        await Promise.allSettled([...remoteJobs.values()].map(cancelRemote));
      } catch (error) {
        cancelFailure = error;
      } finally {
        cancelWakeResolve();
      }
    })();
  };

  const abortListener = (): void => beginCancel();
  if (options.signal?.aborted) {
    cancelRequested = true;
    admissionStopped = true;
  } else options.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    await options.durability.persistPlan(
      deepFreeze({
        ...identity,
        plan,
        localConcurrency: options.localConcurrency,
        remoteConcurrency: options.remoteConcurrency,
      }),
    );
    planPersisted = true;
    if (cancelRequested) beginCancel();
    await emit({ kind: "run", status: "running" });
    for (const nodeId of plan.orderedNodeIds) {
      statuses.set(nodeId, "queued");
      await emit({ kind: "node", nodeId, status: "queued", attempt: 0 });
    }

    const execute = async (
      nodeId: string,
      lane: CoordinatorExecutionLane,
    ): Promise<SettledNode> => {
      const node = nodes.get(nodeId);
      if (!node) {
        return {
          nodeId,
          lane,
          result: {
            kind: "failure",
            error: "The planned node no longer exists.",
            retrySafety: "never",
          },
        };
      }
      const controller = new AbortController();
      controllers.set(nodeId, controller);
      let attempt = 1;
      let idempotencyGeneration = 1;
      let idempotencyKey =
        lane === "remote" ? idempotencyKeyFor(identity, nodeId, idempotencyGeneration) : undefined;
      let nodeRetryDelayMs = 0;
      const dependencies = plan.dependencies[nodeId] ?? [];
      const dependencyOutputs = new Map<string, unknown>();
      for (const dependency of dependencies) {
        if (outputs.has(dependency)) dependencyOutputs.set(dependency, outputs.get(dependency));
      }

      while (true) {
        if (controller.signal.aborted) return { nodeId, lane, result: { kind: "cancelled" } };
        nodeAttempts.set(nodeId, attempt);
        await emit({ kind: "node", nodeId, status: "running", attempt });
        if (lane === "remote" && idempotencyKey) {
          await options.durability.persistSubmissionPrepared(
            deepFreeze({ ...identity, nodeId, attempt, idempotencyKey }),
          );
          uncertainRemoteSubmissions.add(nodeId);
        }
        let result: CoordinatorAttemptResult;
        try {
          result = await options.executeNode({
            ...identity,
            node,
            lane,
            attempt,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            signal: controller.signal,
            dependencyOutputs,
            recordRemoteJobId: async (remoteJobId) => {
              if (lane !== "remote") throw new Error("Only remote nodes can record provider jobs.");
              if (!idempotencyKey)
                throw new Error("Remote jobs require a prepared idempotency key.");
              assertProviderJobId(remoteJobId);
              const existing = remoteJobs.get(nodeId);
              if (existing && existing.remoteJobId !== remoteJobId) {
                throw new Error("A node attempt cannot replace its durable remote job ID.");
              }
              if (existing) return;
              const record = deepFreeze({
                ...identity,
                nodeId,
                attempt,
                idempotencyKey,
                remoteJobId,
              });
              await options.durability.persistRemoteJob(record);
              remoteJobs.set(nodeId, record);
              uncertainRemoteSubmissions.delete(nodeId);
              await emit({ kind: "remote-job", nodeId, attempt, remoteJobId });
              if (cancelPersisted) await cancelRemote(record);
            },
          });
        } catch (error) {
          result =
            lane === "remote"
              ? {
                  kind: "ambiguous-submit",
                  error: errorMessage(error),
                }
              : {
                  kind: "failure",
                  error: errorMessage(error),
                  retrySafety: "never",
                };
        }
        if (controller.signal.aborted) return { nodeId, lane, result: { kind: "cancelled" } };
        if (result.kind !== "failure" && result.kind !== "rate-limited") {
          return { nodeId, lane, result };
        }
        if (
          remoteJobs.has(nodeId) &&
          (result.retrySafety === "confirmed-not-submitted" ||
            result.retrySafety === "same-idempotency-key")
        ) {
          return {
            nodeId,
            lane,
            result: {
              kind: "ambiguous-submit",
              error:
                "A durable remote job must be reconciled and cannot enter the submission retry path.",
            },
          };
        }
        const retriesUsed = attempt - 1;
        if (
          retriesUsed >= policy.maxRetriesPerNode ||
          !retryIsAllowed(lane, result, policy, idempotencyKey)
        ) {
          return { nodeId, lane, result };
        }
        const delayMs = retryDelay(retriesUsed, result, policy, options.jitter);
        if (
          delayMs < 0 ||
          totalRetryDelayMs + delayMs > policy.maxTotalDelayMs ||
          nodeRetryDelayMs + delayMs > policy.maxTotalDelayMs
        ) {
          return { nodeId, lane, result };
        }
        totalRetryDelayMs += delayMs;
        nodeRetryDelayMs += delayMs;
        // A retry-scheduled event durably seals the preceding prepared
        // submission with an explicit safe-retry classification. The next
        // attempt becomes uncertain only after its own prepared record lands.
        uncertainRemoteSubmissions.delete(nodeId);
        await emit({
          kind: "node",
          nodeId,
          status: "retry_wait",
          attempt,
          errorCode:
            result.errorCode ??
            (result.kind === "rate-limited" ? "rate-limited" : "execution-failed"),
          retryDelayMs: delayMs,
          retrySafety: result.retrySafety,
        });
        try {
          await options.clock.sleep(delayMs, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return { nodeId, lane, result: { kind: "cancelled" } };
          return {
            nodeId,
            lane,
            result: {
              kind: "failure",
              error: errorMessage(error),
              retrySafety: "never",
            },
          };
        }
        attempt += 1;
        if (lane === "remote" && result.retrySafety === "confirmed-not-submitted") {
          idempotencyGeneration += 1;
          idempotencyKey = idempotencyKeyFor(identity, nodeId, idempotencyGeneration);
        }
      }
    };

    while ([...statuses.values()].some((status) => !terminalNode(status))) {
      if (cancelFailure) throw cancelFailure;
      if (cancelPersisted) {
        for (const nodeId of plan.orderedNodeIds) {
          const status = statuses.get(nodeId);
          if (status === "running" || status === "retry_wait") {
            const submissionIsUncertain = uncertainRemoteSubmissions.has(nodeId);
            statuses.set(nodeId, submissionIsUncertain ? "ambiguous" : "cancelled");
            await emit({
              kind: "node",
              nodeId,
              status: submissionIsUncertain ? "ambiguous" : "cancelled",
              attempt: nodeAttempts.get(nodeId) ?? 0,
              errorCode: submissionIsUncertain ? "submission-ambiguous" : "cancelled",
            });
          }
        }
        for (const nodeId of plan.orderedNodeIds) {
          if (statuses.get(nodeId) !== "queued") continue;
          const dependencies = plan.dependencies[nodeId] ?? [];
          const blocked = dependencies.some((dependency) =>
            dependencyBlocks(statuses.get(dependency)),
          );
          statuses.set(nodeId, blocked ? "blocked" : "cancelled");
          await emit({
            kind: "node",
            nodeId,
            status: blocked ? "blocked" : "cancelled",
            attempt: 0,
            errorCode: blocked ? "upstream-blocked" : "cancelled",
          });
        }
        active.clear();
        break;
      }

      for (const nodeId of plan.orderedNodeIds) {
        if (statuses.get(nodeId) !== "queued") continue;
        const dependencies = plan.dependencies[nodeId] ?? [];
        if (dependencies.some((dependency) => dependencyBlocks(statuses.get(dependency)))) {
          statuses.set(nodeId, "blocked");
          await emit({
            kind: "node",
            nodeId,
            status: "blocked",
            attempt: 0,
            errorCode: "upstream-blocked",
          });
        }
      }

      if (!admissionStopped) {
        for (const nodeId of plan.orderedNodeIds) {
          if (statuses.get(nodeId) !== "queued") continue;
          const dependencies = plan.dependencies[nodeId] ?? [];
          if (!dependencies.every((dependency) => statuses.get(dependency) === "succeeded"))
            continue;
          const node = nodes.get(nodeId);
          if (!node) continue;
          const lane = laneFor(node);
          const activeInLane = [...active.keys()].filter((activeId) => {
            const activeNode = nodes.get(activeId);
            return activeNode ? laneFor(activeNode) === lane : false;
          }).length;
          const limit = lane === "local" ? options.localConcurrency : options.remoteConcurrency;
          if (activeInLane >= limit) continue;
          statuses.set(nodeId, "running");
          const task = execute(nodeId, lane).catch(
            (error): SettledNode => ({
              nodeId,
              lane,
              result: {
                kind: "failure",
                error: errorMessage(error),
                retrySafety: "never",
              },
            }),
          );
          active.set(nodeId, task);
        }
      }

      if (active.size === 0) {
        if (admissionStopped && cancelTask) {
          await cancelWake;
          continue;
        }
        for (const nodeId of plan.orderedNodeIds) {
          if (statuses.get(nodeId) === "queued") {
            statuses.set(nodeId, "blocked");
            await emit({
              kind: "node",
              nodeId,
              status: "blocked",
              attempt: 0,
              errorCode: "dependency-unschedulable",
            });
          }
        }
        continue;
      }

      const settled = await Promise.race([...active.values(), cancelWake.then(() => undefined)]);
      if (!settled) continue;
      active.delete(settled.nodeId);
      controllers.delete(settled.nodeId);
      if (!acceptSettlements) continue;
      const result = settled.result;
      if (result.kind === "success") {
        try {
          const durableOutput = await options.durability.publishOutput({
            ...identity,
            nodeId: settled.nodeId,
            output: result.output,
          });
          outputs.set(settled.nodeId, durableOutput);
          statuses.set(settled.nodeId, "succeeded");
          await emit({
            kind: "node",
            nodeId: settled.nodeId,
            status: "succeeded",
            attempt: nodeAttempts.get(settled.nodeId) ?? 0,
          });
        } catch {
          statuses.set(settled.nodeId, "failed");
          await emit({
            kind: "node",
            nodeId: settled.nodeId,
            status: "failed",
            attempt: nodeAttempts.get(settled.nodeId) ?? 0,
            errorCode: "output-publication-failed",
          });
        }
      } else if (result.kind === "ambiguous-submit") {
        statuses.set(settled.nodeId, "ambiguous");
        await emit({
          kind: "node",
          nodeId: settled.nodeId,
          status: "ambiguous",
          attempt: nodeAttempts.get(settled.nodeId) ?? 0,
          errorCode: "submission-ambiguous",
        });
      } else if (result.kind === "cancelled") {
        statuses.set(settled.nodeId, "cancelled");
        await emit({
          kind: "node",
          nodeId: settled.nodeId,
          status: "cancelled",
          attempt: nodeAttempts.get(settled.nodeId) ?? 0,
          errorCode: "cancelled",
        });
      } else {
        statuses.set(settled.nodeId, "failed");
        await emit({
          kind: "node",
          nodeId: settled.nodeId,
          status: "failed",
          attempt: nodeAttempts.get(settled.nodeId) ?? 0,
          errorCode:
            result.errorCode ??
            (result.kind === "rate-limited" ? "rate-limited" : "execution-failed"),
        });
      }
    }

    if (cancelTask) {
      await cancelTask;
      if (cancelFailure) throw cancelFailure;
    }
    const completedStatus = finalRunStatus(statuses);
    const status =
      completedStatus === "needs_attention"
        ? completedStatus
        : cancelPersisted
          ? "cancelled"
          : completedStatus;
    await emit({ kind: "run", status });
    return deepFreeze({
      ...identity,
      status,
      nodeStatuses: Object.fromEntries(statuses),
      outputs,
      events,
      retryDelayMs: totalRetryDelayMs,
    });
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
  }
}

export interface CoordinatorEventCursor extends CoordinatorRunIdentity {
  lastSequence: number;
  runStatus: CoordinatorRunStatus;
  nodeStatuses: Readonly<Record<string, CoordinatorNodeStatus | undefined>>;
  nodeAttempts: Readonly<Record<string, number>>;
}

export type CoordinatorEventRejection =
  | "wrong-run"
  | "duplicate-or-stale"
  | "out-of-order"
  | "late-after-terminal"
  | "unknown-node"
  | "invalid-transition"
  | "attempt-regression";

export type CoordinatorEventReduction =
  | { accepted: true; cursor: CoordinatorEventCursor }
  | {
      accepted: false;
      cursor: CoordinatorEventCursor;
      reason: CoordinatorEventRejection;
    };

export function createCoordinatorEventCursor(
  identity: CoordinatorRunIdentity,
  nodeIds: readonly string[],
): CoordinatorEventCursor {
  assertOpaqueId(identity.workflowId, "Workflow ID");
  assertOpaqueId(identity.runId, "Run ID");
  if (!Number.isInteger(identity.workflowRevision) || identity.workflowRevision < 0) {
    throw new Error("Workflow revision must be a non-negative integer.");
  }
  const unique = new Set(nodeIds);
  if (unique.size !== nodeIds.length || nodeIds.some((nodeId) => !OPAQUE_ID_PATTERN.test(nodeId))) {
    throw new Error("Event cursors require unique opaque node IDs.");
  }
  return deepFreeze({
    ...identity,
    lastSequence: 0,
    runStatus: "pending",
    nodeStatuses: Object.fromEntries(nodeIds.map((nodeId) => [nodeId, undefined])),
    nodeAttempts: Object.fromEntries(nodeIds.map((nodeId) => [nodeId, 0])),
  });
}

const NODE_TRANSITIONS: Readonly<Record<string, readonly CoordinatorNodeStatus[]>> = {
  unseen: ["queued"],
  queued: ["running", "cancelled", "blocked"],
  running: ["retry_wait", "succeeded", "failed", "cancelled", "ambiguous"],
  retry_wait: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  blocked: [],
  ambiguous: [],
};

export function reduceCoordinatorEvent(
  cursor: CoordinatorEventCursor,
  event: CoordinatorEvent,
): CoordinatorEventReduction {
  if (
    cursor.workflowId !== event.workflowId ||
    cursor.workflowRevision !== event.workflowRevision ||
    cursor.runId !== event.runId
  ) {
    return { accepted: false, cursor, reason: "wrong-run" };
  }
  if (event.sequence <= cursor.lastSequence) {
    return { accepted: false, cursor, reason: "duplicate-or-stale" };
  }
  if (event.sequence !== cursor.lastSequence + 1) {
    return { accepted: false, cursor, reason: "out-of-order" };
  }
  if (!["pending", "running"].includes(cursor.runStatus)) {
    return { accepted: false, cursor, reason: "late-after-terminal" };
  }
  if (event.kind === "run") {
    if (cursor.runStatus === "pending" && event.status !== "running") {
      return { accepted: false, cursor, reason: "invalid-transition" };
    }
    if (cursor.runStatus === "running" && event.status === "running") {
      return { accepted: false, cursor, reason: "invalid-transition" };
    }
    if (cursor.runStatus === "running") {
      const entries = Object.entries(cursor.nodeStatuses);
      if (
        entries.some(([, status]) => status === undefined || !terminalNode(status)) ||
        finalRunStatus(new Map(entries as Array<[string, CoordinatorNodeStatus]>)) !== event.status
      ) {
        return { accepted: false, cursor, reason: "invalid-transition" };
      }
    }
    return {
      accepted: true,
      cursor: deepFreeze({
        ...cursor,
        lastSequence: event.sequence,
        runStatus: event.status,
      }),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(cursor.nodeStatuses, event.nodeId)) {
    return { accepted: false, cursor, reason: "unknown-node" };
  }
  const previousAttempt = cursor.nodeAttempts[event.nodeId] ?? 0;
  if (!Number.isInteger(event.attempt) || event.attempt < 0 || event.attempt < previousAttempt) {
    return { accepted: false, cursor, reason: "attempt-regression" };
  }
  if (event.kind === "remote-job") {
    if (
      !PROVIDER_JOB_ID_PATTERN.test(event.remoteJobId) ||
      cursor.nodeStatuses[event.nodeId] !== "running" ||
      event.attempt !== previousAttempt
    ) {
      return { accepted: false, cursor, reason: "invalid-transition" };
    }
    return {
      accepted: true,
      cursor: deepFreeze({ ...cursor, lastSequence: event.sequence }),
    };
  }
  const previous = cursor.nodeStatuses[event.nodeId];
  const retryContractValid =
    event.status !== "retry_wait" ||
    (Number.isInteger(event.retryDelayMs) &&
      (event.retryDelayMs ?? -1) >= 0 &&
      (event.retryDelayMs ?? MAX_RETRY_DELAY_MS + 1) <= MAX_RETRY_DELAY_MS &&
      event.retrySafety !== undefined &&
      event.retrySafety !== "never" &&
      event.errorCode !== undefined);
  const nonRetryContractValid =
    event.status === "retry_wait" ||
    (event.retryDelayMs === undefined && event.retrySafety === undefined);
  const failureCodeRequired = ["failed", "cancelled", "blocked", "ambiguous"].includes(
    event.status,
  );
  if (
    !retryContractValid ||
    !nonRetryContractValid ||
    (failureCodeRequired && event.errorCode === undefined) ||
    (!failureCodeRequired && event.status !== "retry_wait" && event.errorCode !== undefined)
  ) {
    return { accepted: false, cursor, reason: "invalid-transition" };
  }
  if (!(NODE_TRANSITIONS[previous ?? "unseen"] ?? []).includes(event.status)) {
    return { accepted: false, cursor, reason: "invalid-transition" };
  }
  if (event.status === "running" && event.attempt !== previousAttempt + 1) {
    return { accepted: false, cursor, reason: "attempt-regression" };
  }
  if (
    event.status !== "running" &&
    event.status !== "queued" &&
    event.attempt !== previousAttempt
  ) {
    return { accepted: false, cursor, reason: "attempt-regression" };
  }
  return {
    accepted: true,
    cursor: deepFreeze({
      ...cursor,
      lastSequence: event.sequence,
      nodeStatuses: { ...cursor.nodeStatuses, [event.nodeId]: event.status },
      nodeAttempts: {
        ...cursor.nodeAttempts,
        [event.nodeId]: event.status === "running" ? event.attempt : previousAttempt,
      },
    }),
  };
}

export type RendererLifecycleEvent =
  | { kind: "route-change"; documentId: string }
  | { kind: "document-destroyed"; documentId: string };

export type RendererDisconnectDecision =
  | "continue-and-resubscribe"
  | "request-best-effort-cancel"
  | "ignore";

export function rendererDisconnectDecision(
  runOwnerDocumentId: string,
  event: RendererLifecycleEvent,
): RendererDisconnectDecision {
  assertOpaqueId(runOwnerDocumentId, "Run owner document ID");
  assertOpaqueId(event.documentId, "Renderer document ID");
  if (event.documentId !== runOwnerDocumentId) return "ignore";
  return event.kind === "route-change" ? "continue-and-resubscribe" : "request-best-effort-cancel";
}

export type RestartNodePhase =
  | "never-started"
  | "local-running"
  | "remote-submitting"
  | "remote-submitted"
  | "output-publishing"
  | "cancel-requested"
  | "terminal";

export interface RestartNodeRecord {
  phase: RestartNodePhase;
  lane: CoordinatorExecutionLane;
  remoteJobId?: string;
  durableOutputAvailable?: boolean;
}

export type RestartReconciliationCategory =
  | "await-explicit-resume"
  | "mark-interrupted"
  | "ambiguous-submit"
  | "reconcile-remote-job"
  | "resume-output-publication"
  | "reconcile-cancel"
  | "finalize-cancel"
  | "terminal";

export interface RestartReconciliationDecision {
  category: RestartReconciliationCategory;
  autoSubmit: false;
  maySubmitAfterExplicitApproval: boolean;
  remoteJobId?: string;
}

export function reconcileRestartNode(record: RestartNodeRecord): RestartReconciliationDecision {
  if (record.remoteJobId !== undefined) assertProviderJobId(record.remoteJobId);
  if (record.remoteJobId !== undefined && record.lane !== "remote") {
    throw new Error("Only remote restart records can contain provider job IDs.");
  }
  if (record.phase === "local-running" && record.lane !== "local") {
    throw new Error("A local-running restart record must use the local lane.");
  }
  if (
    (record.phase === "remote-submitting" || record.phase === "remote-submitted") &&
    record.lane !== "remote"
  ) {
    throw new Error("Remote submission restart records must use the remote lane.");
  }
  switch (record.phase) {
    case "never-started":
      return {
        category: "await-explicit-resume",
        autoSubmit: false,
        maySubmitAfterExplicitApproval: true,
      };
    case "local-running":
      return {
        category: "mark-interrupted",
        autoSubmit: false,
        maySubmitAfterExplicitApproval: true,
      };
    case "remote-submitting":
      if (record.remoteJobId) {
        return {
          category: "reconcile-remote-job",
          autoSubmit: false,
          maySubmitAfterExplicitApproval: false,
          remoteJobId: record.remoteJobId,
        };
      }
      return {
        category: "ambiguous-submit",
        autoSubmit: false,
        maySubmitAfterExplicitApproval: false,
      };
    case "remote-submitted":
      if (!record.remoteJobId) {
        return {
          category: "ambiguous-submit",
          autoSubmit: false,
          maySubmitAfterExplicitApproval: false,
        };
      }
      return {
        category: "reconcile-remote-job",
        autoSubmit: false,
        maySubmitAfterExplicitApproval: false,
        remoteJobId: record.remoteJobId,
      };
    case "output-publishing":
      return record.durableOutputAvailable
        ? {
            category: "resume-output-publication",
            autoSubmit: false,
            maySubmitAfterExplicitApproval: false,
          }
        : {
            category: "mark-interrupted",
            autoSubmit: false,
            maySubmitAfterExplicitApproval: true,
          };
    case "cancel-requested":
      return record.remoteJobId
        ? {
            category: "reconcile-cancel",
            autoSubmit: false,
            maySubmitAfterExplicitApproval: false,
            remoteJobId: record.remoteJobId,
          }
        : {
            category: "finalize-cancel",
            autoSubmit: false,
            maySubmitAfterExplicitApproval: false,
          };
    case "terminal":
      return {
        category: "terminal",
        autoSubmit: false,
        maySubmitAfterExplicitApproval: false,
      };
  }
}
