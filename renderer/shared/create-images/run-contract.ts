import { planWorkflowExecution, type WorkflowRunScope } from "./execution.js";
import {
  CREATE_IMAGES_ASSET_ID_PATTERN,
  parseWorkflowDocument,
  type WorkflowDocumentV1,
} from "./schema.js";

export const CREATE_IMAGES_RUN_JOURNAL_VERSION = 1 as const;
export const CREATE_IMAGES_MAX_RUN_EVENTS = 10_000;
export const CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE = 16;
export const CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES = 16 * 1024 * 1024;
export const CREATE_IMAGES_MAX_RUN_ERROR_CODE_LENGTH = 96;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,191}$/u;
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9-]{0,95}$/u;
const TIMESTAMP_MAX_LENGTH = 64;

export type CreateImagesRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancel_requested"
  | "needs_attention"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type CreateImagesNodeRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked"
  | "ambiguous";

export type CreateImagesCancellationReason = "user" | "renderer-disconnected" | "app-quit";

export type CreateImagesRunTerminalStatus = Extract<
  CreateImagesRunStatus,
  "succeeded" | "failed" | "cancelled" | "interrupted" | "needs_attention"
>;

interface RunEventBaseV1<TType extends string> {
  type: TType;
  workflowId: string;
  workflowRevision: number;
  runId: string;
  sequence: number;
  at: string;
}

export type CreateImagesRunStartedEventV1 = RunEventBaseV1<"run-started">;

export type CreateImagesRunPausedEventV1 = RunEventBaseV1<"run-paused"> & {
  checkpointId: string;
  beforeNodeId: string;
  edgeIds: string[];
};

export type CreateImagesRunResumedEventV1 = RunEventBaseV1<"run-resumed"> & {
  checkpointId: string;
};

export type CreateImagesNodeStartedEventV1 = RunEventBaseV1<"node-started"> & {
  nodeId: string;
};

export type CreateImagesNodeSubmissionPreparedEventV1 =
  RunEventBaseV1<"node-submission-prepared"> & {
    nodeId: string;
    attempt: number;
    idempotencyKey: string;
    providerId: string;
    modelId: string;
  };

export type CreateImagesNodeSubmissionAcceptedEventV1 =
  RunEventBaseV1<"node-submission-accepted"> & {
    nodeId: string;
    attempt: number;
    providerJobId?: string;
  };

export type CreateImagesNodeSubmissionAmbiguousEventV1 =
  RunEventBaseV1<"node-submission-ambiguous"> & {
    nodeId: string;
    attempt: number;
  };

export type CreateImagesNodeSubmissionReconciledEventV1 =
  RunEventBaseV1<"node-submission-reconciled"> & {
    nodeId: string;
    attempt: number;
    outcome: "accepted" | "not-found";
    providerJobId?: string;
  };

export type CreateImagesNodeOutputPublishedEventV1 = RunEventBaseV1<"node-output-published"> & {
  nodeId: string;
  /** Ordered output positions. Byte-identical images may intentionally repeat an asset ID. */
  outputAssetIds: string[];
};

export type CreateImagesNodeRetryScheduledEventV1 = RunEventBaseV1<"node-retry-scheduled"> & {
  nodeId: string;
  attempt: number;
  errorCode: string;
  delayMs: number;
  retrySafety: "confirmed-not-submitted" | "same-idempotency-key";
};

export type CreateImagesNodeAmbiguousEventV1 = RunEventBaseV1<"node-ambiguous"> & {
  nodeId: string;
  attempt: number;
};

export type CreateImagesNodeSucceededEventV1 = RunEventBaseV1<"node-succeeded"> & {
  nodeId: string;
  outputAssetIds: string[];
};

export type CreateImagesNodeFailedEventV1 = RunEventBaseV1<"node-failed"> & {
  nodeId: string;
  errorCode: string;
};

export type CreateImagesNodeCancelledEventV1 = RunEventBaseV1<"node-cancelled"> & {
  nodeId: string;
};

export type CreateImagesNodeBlockedEventV1 = RunEventBaseV1<"node-blocked"> & {
  nodeId: string;
  upstreamNodeIds: string[];
};

export type CreateImagesBatchItemState =
  | "queued"
  | "submission_prepared"
  | "submitted"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type CreateImagesBatchItemStateEventV1 = RunEventBaseV1<"batch-item-state"> & {
  nodeId: string;
  itemId: string;
  itemIndex: number;
  state: CreateImagesBatchItemState;
  outputAssetIds?: string[];
  errorCode?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  cost?: { kind: "unknown" } | { kind: "actual"; amountMicros: number; currency: string };
};

export type CreateImagesRunCancelRequestedEventV1 = RunEventBaseV1<"run-cancel-requested"> & {
  reason: CreateImagesCancellationReason;
};

export type CreateImagesRunTerminalEventV1 = RunEventBaseV1<"run-terminal"> & {
  status: CreateImagesRunTerminalStatus;
};

export type CreateImagesRunAmbiguityAcknowledgedEventV1 =
  RunEventBaseV1<"run-ambiguity-acknowledged"> & {
    expectedNeedsAttentionJournalRevision: number;
  };

export type CreateImagesRunEventV1 =
  | CreateImagesRunStartedEventV1
  | CreateImagesRunPausedEventV1
  | CreateImagesRunResumedEventV1
  | CreateImagesNodeStartedEventV1
  | CreateImagesNodeSubmissionPreparedEventV1
  | CreateImagesNodeSubmissionAcceptedEventV1
  | CreateImagesNodeSubmissionAmbiguousEventV1
  | CreateImagesNodeSubmissionReconciledEventV1
  | CreateImagesNodeOutputPublishedEventV1
  | CreateImagesNodeRetryScheduledEventV1
  | CreateImagesNodeAmbiguousEventV1
  | CreateImagesNodeSucceededEventV1
  | CreateImagesNodeFailedEventV1
  | CreateImagesNodeCancelledEventV1
  | CreateImagesNodeBlockedEventV1
  | CreateImagesBatchItemStateEventV1
  | CreateImagesRunCancelRequestedEventV1
  | CreateImagesRunTerminalEventV1
  | CreateImagesRunAmbiguityAcknowledgedEventV1;

export interface CreateImagesRunPlanV1 {
  scope: WorkflowRunScope;
  orderedNodeIds: string[];
  dependencies: Record<string, string[]>;
}

export interface CreateImagesRunProviderAuthorizationV1 {
  version: 1;
  executionMode: "gemini";
  authorizationId: string;
  consentFingerprint: string;
  capabilityFingerprint: string;
  credentialRecordId: string;
  credentialRevision: number;
  initialRequestCount: number;
  expectedOutputCount: number;
  maximumAttempts: number;
  createdAt: string;
  expiresAt: string;
}

export interface CreateImagesRunJournalV1 {
  version: typeof CREATE_IMAGES_RUN_JOURNAL_VERSION;
  journalRevision: number;
  runId: string;
  workflowId: string;
  workflowRevision: number;
  workflowFingerprint: string;
  workflowSnapshot: WorkflowDocumentV1;
  plan: CreateImagesRunPlanV1;
  providerAuthorization?: CreateImagesRunProviderAuthorizationV1;
  createdAt: string;
  updatedAt: string;
  events: CreateImagesRunEventV1[];
}

export interface CreateImagesRunJournalCreationInput {
  runId: string;
  workflowSnapshot: WorkflowDocumentV1;
  workflowFingerprint: string;
  plan: CreateImagesRunPlanV1;
  providerAuthorization?: CreateImagesRunProviderAuthorizationV1;
  createdAt: string;
}

export interface CreateImagesRunContractIssue {
  path: string;
  code:
    | "invalid_type"
    | "invalid_value"
    | "unknown_field"
    | "too_large"
    | "duplicate"
    | "invalid_transition";
  message: string;
}

export type CreateImagesRunJournalParseResult =
  | { success: true; value: CreateImagesRunJournalV1 }
  | { success: false; issues: CreateImagesRunContractIssue[] };

export interface CreateImagesRunAttemptProjection {
  attempt: number;
  idempotencyKey: string;
  providerId: string;
  modelId: string;
  submission: "prepared" | "accepted" | "ambiguous" | "reconciled-not-found" | "retry-scheduled";
  providerJobId?: string;
  retry?: {
    errorCode: string;
    delayMs: number;
    safety: "confirmed-not-submitted" | "same-idempotency-key";
  };
}

export interface CreateImagesNodeRunProjection {
  status: CreateImagesNodeRunStatus;
  attempts: CreateImagesRunAttemptProjection[];
  durableOutputAssetIds?: string[];
  outputAssetIds: string[];
  errorCode?: string;
  terminalAt?: string;
  batchItems?: Record<
    string,
    {
      itemId: string;
      itemIndex: number;
      state: CreateImagesBatchItemState;
      outputAssetIds: string[];
      errorCode?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      cost?: { kind: "unknown" } | { kind: "actual"; amountMicros: number; currency: string };
    }
  >;
}

export interface CreateImagesRunProjection {
  status: CreateImagesRunStatus;
  lastSequence: number;
  cancellation?: {
    reason: CreateImagesCancellationReason;
    requestedAt: string;
  };
  pause?: {
    checkpointId: string;
    beforeNodeId: string;
    edgeIds: string[];
    pausedAt: string;
    resumedAt?: string;
  };
  terminal?: { status: CreateImagesRunTerminalStatus; at: string };
  ambiguityResolution?: {
    kind: "acknowledged-unresolved-submission";
    acknowledgedAt: string;
    acknowledgedAtJournalRevision: number;
  };
  nodes: Record<string, CreateImagesNodeRunProjection>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function issue(
  issues: CreateImagesRunContractIssue[],
  path: string,
  code: CreateImagesRunContractIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: CreateImagesRunContractIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) issue(issues, `${path}.${key}`, "unknown_field", "Unknown field.");
  }
}

function boundedString(
  value: unknown,
  path: string,
  issues: CreateImagesRunContractIssue[],
  pattern: RegExp,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    issue(issues, path, "invalid_type", "Expected a string.");
    return undefined;
  }
  if (value.length < 1 || value.length > maxLength) {
    issue(
      issues,
      path,
      value.length > maxLength ? "too_large" : "invalid_value",
      "Invalid length.",
    );
    return undefined;
  }
  if (!pattern.test(value)) {
    issue(issues, path, "invalid_value", "Invalid value.");
    return undefined;
  }
  return value;
}

function opaqueId(
  value: unknown,
  path: string,
  issues: CreateImagesRunContractIssue[],
): string | undefined {
  return boundedString(value, path, issues, OPAQUE_ID_PATTERN, 128);
}

function positiveInteger(
  value: unknown,
  path: string,
  issues: CreateImagesRunContractIssue[],
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    issue(issues, path, "invalid_value", `Expected an integer from 1 through ${max}.`);
    return undefined;
  }
  return value as number;
}

function nonnegativeInteger(
  value: unknown,
  path: string,
  issues: CreateImagesRunContractIssue[],
  max: number,
): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    issue(issues, path, "invalid_value", `Expected an integer from 0 through ${max}.`);
    return undefined;
  }
  return value as number;
}

function timestamp(
  value: unknown,
  path: string,
  issues: CreateImagesRunContractIssue[],
): string | undefined {
  let canonical = false;
  if (typeof value === "string" && value.length >= 1 && value.length <= TIMESTAMP_MAX_LENGTH) {
    try {
      canonical = new Date(value).toISOString() === value;
    } catch {
      canonical = false;
    }
  }
  if (!canonical) {
    issue(issues, path, "invalid_value", "Expected a bounded ISO-8601 timestamp.");
    return undefined;
  }
  return value as string;
}

function parseScope(
  value: unknown,
  path: string,
  issues: CreateImagesRunContractIssue[],
): WorkflowRunScope | undefined {
  if (!isRecord(value)) {
    issue(issues, path, "invalid_type", "Expected an object.");
    return undefined;
  }
  if (value.kind === "all") {
    rejectUnknown(value, ["kind"], path, issues);
    return { kind: "all" };
  }
  if (value.kind !== "from-node") {
    issue(issues, `${path}.kind`, "invalid_value", "Unknown run scope.");
    return undefined;
  }
  rejectUnknown(value, ["kind", "nodeId", "downstreamPath"], path, issues);
  const nodeId = opaqueId(value.nodeId, `${path}.nodeId`, issues);
  let downstreamPath: string[] | undefined;
  if (value.downstreamPath !== undefined) {
    if (!Array.isArray(value.downstreamPath)) {
      issue(issues, `${path}.downstreamPath`, "invalid_type", "Expected an array.");
    } else if (value.downstreamPath.length > 500) {
      issue(issues, `${path}.downstreamPath`, "too_large", "Run path is too large.");
    } else {
      downstreamPath = value.downstreamPath.flatMap((candidate, index) => {
        const parsed = opaqueId(candidate, `${path}.downstreamPath[${index}]`, issues);
        return parsed ? [parsed] : [];
      });
      if (new Set(downstreamPath).size !== downstreamPath.length) {
        issue(issues, `${path}.downstreamPath`, "duplicate", "Run path contains duplicates.");
      }
    }
  }
  if (!nodeId) return undefined;
  return downstreamPath
    ? { kind: "from-node", nodeId, downstreamPath }
    : { kind: "from-node", nodeId };
}

function parsePlan(
  value: unknown,
  snapshot: WorkflowDocumentV1,
  issues: CreateImagesRunContractIssue[],
): CreateImagesRunPlanV1 | undefined {
  const path = "plan";
  if (!isRecord(value)) {
    issue(issues, path, "invalid_type", "Expected an object.");
    return undefined;
  }
  rejectUnknown(value, ["scope", "orderedNodeIds", "dependencies"], path, issues);
  const scope = parseScope(value.scope, `${path}.scope`, issues);
  if (!Array.isArray(value.orderedNodeIds)) {
    issue(issues, `${path}.orderedNodeIds`, "invalid_type", "Expected an array.");
    return undefined;
  }
  if (value.orderedNodeIds.length < 1 || value.orderedNodeIds.length > snapshot.nodes.length) {
    issue(issues, `${path}.orderedNodeIds`, "invalid_value", "Invalid planned node count.");
  }
  const orderedNodeIds = value.orderedNodeIds.flatMap((candidate, index) => {
    const parsed = opaqueId(candidate, `${path}.orderedNodeIds[${index}]`, issues);
    return parsed ? [parsed] : [];
  });
  if (new Set(orderedNodeIds).size !== orderedNodeIds.length) {
    issue(issues, `${path}.orderedNodeIds`, "duplicate", "Planned nodes must be unique.");
  }
  const snapshotNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  for (const nodeId of orderedNodeIds) {
    if (!snapshotNodeIds.has(nodeId)) {
      issue(issues, `${path}.orderedNodeIds`, "invalid_value", "Plan references an unknown node.");
    }
  }
  if (!isRecord(value.dependencies)) {
    issue(issues, `${path}.dependencies`, "invalid_type", "Expected an object.");
    return undefined;
  }
  const planned = new Set(orderedNodeIds);
  const order = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  const dependencyKeys = Object.keys(value.dependencies);
  if (
    dependencyKeys.length !== orderedNodeIds.length ||
    dependencyKeys.some((nodeId) => !planned.has(nodeId))
  ) {
    issue(
      issues,
      `${path}.dependencies`,
      "invalid_value",
      "Dependencies must exactly cover the plan.",
    );
  }
  const dependencies: Record<string, string[]> = {};
  for (const nodeId of dependencyKeys) {
    const candidate = value.dependencies[nodeId];
    if (!Array.isArray(candidate) || candidate.length > orderedNodeIds.length) {
      issue(issues, `${path}.dependencies.${nodeId}`, "invalid_type", "Expected a bounded array.");
      continue;
    }
    const values = candidate.flatMap((dependency, index) => {
      const parsed = opaqueId(dependency, `${path}.dependencies.${nodeId}[${index}]`, issues);
      return parsed ? [parsed] : [];
    });
    if (new Set(values).size !== values.length) {
      issue(issues, `${path}.dependencies.${nodeId}`, "duplicate", "Dependencies must be unique.");
    }
    for (const dependency of values) {
      if (
        !planned.has(dependency) ||
        (order.get(dependency) ?? Infinity) >= (order.get(nodeId) ?? -1)
      ) {
        issue(
          issues,
          `${path}.dependencies.${nodeId}`,
          "invalid_value",
          "Dependencies must precede their node.",
        );
      }
    }
    dependencies[nodeId] = values;
  }
  for (const nodeId of orderedNodeIds) {
    const expected = snapshot.edges
      .filter((edge) => planned.has(edge.source) && edge.target === nodeId)
      .map((edge) => edge.source)
      .sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    if (JSON.stringify(dependencies[nodeId] ?? []) !== JSON.stringify(expected)) {
      issue(
        issues,
        `${path}.dependencies.${nodeId}`,
        "invalid_value",
        "Dependencies must exactly match edges in the immutable snapshot.",
      );
    }
  }
  if (scope?.kind === "from-node") {
    const selected = [scope.nodeId, ...(scope.downstreamPath ?? [])];
    if (selected.some((nodeId) => !planned.has(nodeId))) {
      issue(issues, `${path}.scope`, "invalid_value", "Run scope is outside the immutable plan.");
    }
  } else if (scope?.kind === "all" && planned.size !== snapshot.nodes.length) {
    issue(
      issues,
      `${path}.orderedNodeIds`,
      "invalid_value",
      "Run-all must include every snapshot node.",
    );
  }
  if (scope) {
    try {
      const expected = planWorkflowExecution(snapshot, scope);
      if (JSON.stringify(orderedNodeIds) !== JSON.stringify(expected.orderedNodeIds)) {
        issue(
          issues,
          `${path}.orderedNodeIds`,
          "invalid_value",
          "Planned nodes and order must exactly match the immutable snapshot and run scope.",
        );
      }
      const expectedDependencyKeys = expected.orderedNodeIds;
      if (JSON.stringify(dependencyKeys) !== JSON.stringify(expectedDependencyKeys)) {
        issue(
          issues,
          `${path}.dependencies`,
          "invalid_value",
          "Dependencies must use the deterministic planned-node order.",
        );
      }
      for (const nodeId of expectedDependencyKeys) {
        if (
          JSON.stringify(dependencies[nodeId] ?? []) !==
          JSON.stringify(expected.dependencies[nodeId] ?? [])
        ) {
          issue(
            issues,
            `${path}.dependencies.${nodeId}`,
            "invalid_value",
            "Dependencies must exactly match the deterministic immutable plan.",
          );
        }
      }
    } catch {
      issue(
        issues,
        `${path}.scope`,
        "invalid_value",
        "Run scope cannot produce a valid deterministic plan from the immutable snapshot.",
      );
    }
  }
  return scope ? { scope, orderedNodeIds, dependencies } : undefined;
}

function parseEvent(
  value: unknown,
  index: number,
  identity: { runId: string; workflowId: string; workflowRevision: number },
  issues: CreateImagesRunContractIssue[],
): CreateImagesRunEventV1 | undefined {
  const path = `events[${index}]`;
  if (!isRecord(value)) {
    issue(issues, path, "invalid_type", "Expected an object.");
    return undefined;
  }
  const baseFields = ["type", "workflowId", "workflowRevision", "runId", "sequence", "at"];
  const type = value.type;
  const extraFields: Record<string, readonly string[]> = {
    "run-started": [],
    "run-paused": ["checkpointId", "beforeNodeId", "edgeIds"],
    "run-resumed": ["checkpointId"],
    "node-started": ["nodeId"],
    "node-submission-prepared": ["nodeId", "attempt", "idempotencyKey", "providerId", "modelId"],
    "node-submission-accepted": ["nodeId", "attempt", "providerJobId"],
    "node-submission-ambiguous": ["nodeId", "attempt"],
    "node-submission-reconciled": ["nodeId", "attempt", "outcome", "providerJobId"],
    "node-output-published": ["nodeId", "outputAssetIds"],
    "node-retry-scheduled": ["nodeId", "attempt", "errorCode", "delayMs", "retrySafety"],
    "node-ambiguous": ["nodeId", "attempt"],
    "node-succeeded": ["nodeId", "outputAssetIds"],
    "node-failed": ["nodeId", "errorCode"],
    "node-cancelled": ["nodeId"],
    "node-blocked": ["nodeId", "upstreamNodeIds"],
    "batch-item-state": [
      "nodeId",
      "itemId",
      "itemIndex",
      "state",
      "outputAssetIds",
      "errorCode",
      "usage",
      "cost",
    ],
    "run-cancel-requested": ["reason"],
    "run-terminal": ["status"],
    "run-ambiguity-acknowledged": ["expectedNeedsAttentionJournalRevision"],
  };
  if (typeof type !== "string" || !hasOwn(extraFields, type)) {
    issue(issues, `${path}.type`, "invalid_value", "Unknown run event type.");
    return undefined;
  }
  rejectUnknown(value, [...baseFields, ...(extraFields[type] ?? [])], path, issues);
  const workflowId = opaqueId(value.workflowId, `${path}.workflowId`, issues);
  const runId = opaqueId(value.runId, `${path}.runId`, issues);
  const workflowRevision = positiveInteger(
    value.workflowRevision,
    `${path}.workflowRevision`,
    issues,
  );
  const sequence = positiveInteger(
    value.sequence,
    `${path}.sequence`,
    issues,
    CREATE_IMAGES_MAX_RUN_EVENTS,
  );
  const at = timestamp(value.at, `${path}.at`, issues);
  if (
    workflowId !== identity.workflowId ||
    runId !== identity.runId ||
    workflowRevision !== identity.workflowRevision
  ) {
    issue(
      issues,
      path,
      "invalid_value",
      "Event identity does not match the immutable run snapshot.",
    );
  }
  if (!workflowId || !runId || !workflowRevision || !sequence || !at) return undefined;
  const base = { type, workflowId, workflowRevision, runId, sequence, at };
  if (type === "run-started") return base as CreateImagesRunStartedEventV1;
  if (type === "run-paused") {
    const checkpointId = opaqueId(value.checkpointId, `${path}.checkpointId`, issues);
    const beforeNodeId = opaqueId(value.beforeNodeId, `${path}.beforeNodeId`, issues);
    if (!Array.isArray(value.edgeIds) || value.edgeIds.length < 1 || value.edgeIds.length > 500) {
      issue(issues, `${path}.edgeIds`, "invalid_value", "Expected a bounded checkpoint edge list.");
      return undefined;
    }
    const edgeIds = value.edgeIds.flatMap((candidate, edgeIndex) => {
      const edgeId = opaqueId(candidate, `${path}.edgeIds[${edgeIndex}]`, issues);
      return edgeId ? [edgeId] : [];
    });
    if (new Set(edgeIds).size !== edgeIds.length) {
      issue(issues, `${path}.edgeIds`, "duplicate", "Checkpoint edge IDs must be unique.");
    }
    return checkpointId && beforeNodeId && edgeIds.length === value.edgeIds.length
      ? { ...base, type, checkpointId, beforeNodeId, edgeIds }
      : undefined;
  }
  if (type === "run-resumed") {
    const checkpointId = opaqueId(value.checkpointId, `${path}.checkpointId`, issues);
    return checkpointId ? { ...base, type, checkpointId } : undefined;
  }
  if (type === "run-cancel-requested") {
    if (
      !(["user", "renderer-disconnected", "app-quit"] as const).includes(
        value.reason as CreateImagesCancellationReason,
      )
    ) {
      issue(issues, `${path}.reason`, "invalid_value", "Unknown cancellation reason.");
      return undefined;
    }
    return {
      ...base,
      type,
      reason: value.reason as CreateImagesCancellationReason,
    };
  }
  if (type === "run-terminal") {
    if (
      !(["succeeded", "failed", "cancelled", "interrupted", "needs_attention"] as const).includes(
        value.status as CreateImagesRunTerminalStatus,
      )
    ) {
      issue(issues, `${path}.status`, "invalid_value", "Unknown terminal status.");
      return undefined;
    }
    return {
      ...base,
      type,
      status: value.status as CreateImagesRunTerminalStatus,
    };
  }
  if (type === "run-ambiguity-acknowledged") {
    const expectedNeedsAttentionJournalRevision = positiveInteger(
      value.expectedNeedsAttentionJournalRevision,
      `${path}.expectedNeedsAttentionJournalRevision`,
      issues,
      CREATE_IMAGES_MAX_RUN_EVENTS,
    );
    return expectedNeedsAttentionJournalRevision
      ? { ...base, type, expectedNeedsAttentionJournalRevision }
      : undefined;
  }
  const nodeId = opaqueId(value.nodeId, `${path}.nodeId`, issues);
  if (!nodeId) return undefined;
  if (type === "batch-item-state") {
    const itemId = opaqueId(value.itemId, `${path}.itemId`, issues);
    const itemIndex = nonnegativeInteger(value.itemIndex, `${path}.itemIndex`, issues, 7);
    const states: readonly CreateImagesBatchItemState[] = [
      "queued",
      "submission_prepared",
      "submitted",
      "succeeded",
      "failed",
      "blocked",
      "cancelled",
    ];
    const state = states.includes(value.state as CreateImagesBatchItemState)
      ? (value.state as CreateImagesBatchItemState)
      : undefined;
    if (!state) issue(issues, `${path}.state`, "invalid_value", "Unknown batch item state.");
    let outputAssetIds: string[] | undefined;
    if (value.outputAssetIds !== undefined) {
      if (!Array.isArray(value.outputAssetIds) || value.outputAssetIds.length > 4) {
        issue(issues, `${path}.outputAssetIds`, "invalid_type", "Expected a bounded asset ID array.");
      } else {
        outputAssetIds = value.outputAssetIds.flatMap((candidate, assetIndex) => {
          const assetId = boundedString(
            candidate,
            `${path}.outputAssetIds[${assetIndex}]`,
            issues,
            CREATE_IMAGES_ASSET_ID_PATTERN,
            64,
          );
          return assetId ? [assetId] : [];
        });
      }
    }
    const errorCode =
      value.errorCode === undefined
        ? undefined
        : boundedString(
            value.errorCode,
            `${path}.errorCode`,
            issues,
            ERROR_CODE_PATTERN,
            CREATE_IMAGES_MAX_RUN_ERROR_CODE_LENGTH,
          );
    let usage: CreateImagesBatchItemStateEventV1["usage"];
    if (value.usage !== undefined) {
      if (!isRecord(value.usage)) issue(issues, `${path}.usage`, "invalid_type", "Expected usage data.");
      else {
        rejectUnknown(value.usage, ["inputTokens", "outputTokens", "totalTokens"], `${path}.usage`, issues);
        const read = (field: string) =>
          value.usage && isRecord(value.usage) && value.usage[field] !== undefined
            ? nonnegativeInteger(value.usage[field], `${path}.usage.${field}`, issues, 1_000_000_000)
            : undefined;
        usage = {
          ...(read("inputTokens") !== undefined ? { inputTokens: read("inputTokens") } : {}),
          ...(read("outputTokens") !== undefined ? { outputTokens: read("outputTokens") } : {}),
          ...(read("totalTokens") !== undefined ? { totalTokens: read("totalTokens") } : {}),
        };
      }
    }
    let cost: CreateImagesBatchItemStateEventV1["cost"];
    if (value.cost !== undefined) {
      if (!isRecord(value.cost)) issue(issues, `${path}.cost`, "invalid_type", "Expected cost data.");
      else if (value.cost.kind === "unknown") {
        rejectUnknown(value.cost, ["kind"], `${path}.cost`, issues);
        cost = { kind: "unknown" };
      } else if (value.cost.kind === "actual") {
        rejectUnknown(value.cost, ["kind", "amountMicros", "currency"], `${path}.cost`, issues);
        const amountMicros = nonnegativeInteger(
          value.cost.amountMicros,
          `${path}.cost.amountMicros`,
          issues,
          Number.MAX_SAFE_INTEGER,
        );
        const currency = boundedString(
          value.cost.currency,
          `${path}.cost.currency`,
          issues,
          /^[A-Z]{3}$/u,
          3,
        );
        if (amountMicros !== undefined && currency) cost = { kind: "actual", amountMicros, currency };
      } else issue(issues, `${path}.cost.kind`, "invalid_value", "Unknown cost state.");
    }
    if (state === "succeeded" && outputAssetIds === undefined) {
      issue(issues, `${path}.outputAssetIds`, "invalid_value", "Succeeded batch items require outputs.");
    }
    if (state === "failed" && !errorCode) {
      issue(issues, `${path}.errorCode`, "invalid_value", "Failed batch items require an error code.");
    }
    return itemId && itemIndex !== undefined && state
      ? {
          ...base,
          type,
          nodeId,
          itemId,
          itemIndex,
          state,
          ...(outputAssetIds ? { outputAssetIds } : {}),
          ...(errorCode ? { errorCode } : {}),
          ...(usage ? { usage } : {}),
          ...(cost ? { cost } : {}),
        }
      : undefined;
  }
  if (type === "node-started" || type === "node-cancelled") return { ...base, type, nodeId };
  if (type === "node-submission-prepared") {
    const attempt = positiveInteger(
      value.attempt,
      `${path}.attempt`,
      issues,
      CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE,
    );
    const idempotencyKey = boundedString(
      value.idempotencyKey,
      `${path}.idempotencyKey`,
      issues,
      IDEMPOTENCY_KEY_PATTERN,
      192,
    );
    const providerId = boundedString(
      value.providerId,
      `${path}.providerId`,
      issues,
      PROVIDER_ID_PATTERN,
      128,
    );
    const modelId = boundedString(value.modelId, `${path}.modelId`, issues, MODEL_ID_PATTERN, 192);
    return attempt && idempotencyKey && providerId && modelId
      ? { ...base, type, nodeId, attempt, idempotencyKey, providerId, modelId }
      : undefined;
  }
  if (type === "node-submission-accepted") {
    const attempt = positiveInteger(
      value.attempt,
      `${path}.attempt`,
      issues,
      CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE,
    );
    const providerJobId =
      value.providerJobId === undefined
        ? undefined
        : boundedString(
            value.providerJobId,
            `${path}.providerJobId`,
            issues,
            PROVIDER_JOB_ID_PATTERN,
            256,
          );
    return attempt && (value.providerJobId === undefined || providerJobId)
      ? {
          ...base,
          type,
          nodeId,
          attempt,
          ...(providerJobId ? { providerJobId } : {}),
        }
      : undefined;
  }
  if (type === "node-submission-ambiguous") {
    const attempt = positiveInteger(
      value.attempt,
      `${path}.attempt`,
      issues,
      CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE,
    );
    return attempt ? { ...base, type, nodeId, attempt } : undefined;
  }
  if (type === "node-retry-scheduled") {
    const attempt = positiveInteger(
      value.attempt,
      `${path}.attempt`,
      issues,
      CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE,
    );
    const errorCode = boundedString(
      value.errorCode,
      `${path}.errorCode`,
      issues,
      ERROR_CODE_PATTERN,
      CREATE_IMAGES_MAX_RUN_ERROR_CODE_LENGTH,
    );
    const delayMs = nonnegativeInteger(value.delayMs, `${path}.delayMs`, issues, 5 * 60 * 1_000);
    const retrySafety =
      value.retrySafety === "confirmed-not-submitted" ||
      value.retrySafety === "same-idempotency-key"
        ? value.retrySafety
        : undefined;
    if (!retrySafety)
      issue(issues, `${path}.retrySafety`, "invalid_value", "Unknown retry safety contract.");
    return attempt && errorCode && delayMs !== undefined && retrySafety
      ? { ...base, type, nodeId, attempt, errorCode, delayMs, retrySafety }
      : undefined;
  }
  if (type === "node-ambiguous") {
    const attempt = positiveInteger(
      value.attempt,
      `${path}.attempt`,
      issues,
      CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE,
    );
    return attempt ? { ...base, type, nodeId, attempt } : undefined;
  }
  if (type === "node-submission-reconciled") {
    const attempt = positiveInteger(
      value.attempt,
      `${path}.attempt`,
      issues,
      CREATE_IMAGES_MAX_RUN_ATTEMPTS_PER_NODE,
    );
    const outcome =
      value.outcome === "accepted" || value.outcome === "not-found" ? value.outcome : undefined;
    if (!outcome)
      issue(issues, `${path}.outcome`, "invalid_value", "Unknown reconciliation outcome.");
    const providerJobId =
      value.providerJobId === undefined
        ? undefined
        : boundedString(
            value.providerJobId,
            `${path}.providerJobId`,
            issues,
            PROVIDER_JOB_ID_PATTERN,
            256,
          );
    if (outcome === "accepted" && !providerJobId) {
      issue(
        issues,
        `${path}.providerJobId`,
        "invalid_value",
        "Accepted reconciliation requires a durable provider job ID.",
      );
    }
    if (outcome === "not-found" && value.providerJobId !== undefined) {
      issue(
        issues,
        `${path}.providerJobId`,
        "invalid_value",
        "A not-found reconciliation cannot carry a provider job ID.",
      );
    }
    return attempt && outcome && (outcome !== "accepted" || providerJobId)
      ? {
          ...base,
          type,
          nodeId,
          attempt,
          outcome,
          ...(providerJobId ? { providerJobId } : {}),
        }
      : undefined;
  }
  if (type === "node-output-published" || type === "node-succeeded") {
    if (!Array.isArray(value.outputAssetIds) || value.outputAssetIds.length > 2_000) {
      issue(issues, `${path}.outputAssetIds`, "invalid_type", "Expected a bounded asset ID array.");
      return undefined;
    }
    const outputAssetIds = value.outputAssetIds.flatMap((candidate, assetIndex) => {
      const parsed = boundedString(
        candidate,
        `${path}.outputAssetIds[${assetIndex}]`,
        issues,
        CREATE_IMAGES_ASSET_ID_PATTERN,
        64,
      );
      return parsed ? [parsed] : [];
    });
    return type === "node-output-published"
      ? { ...base, type, nodeId, outputAssetIds }
      : { ...base, type, nodeId, outputAssetIds };
  }
  if (type === "node-failed") {
    const errorCode = boundedString(
      value.errorCode,
      `${path}.errorCode`,
      issues,
      ERROR_CODE_PATTERN,
      CREATE_IMAGES_MAX_RUN_ERROR_CODE_LENGTH,
    );
    return errorCode ? { ...base, type, nodeId, errorCode } : undefined;
  }
  if (
    !Array.isArray(value.upstreamNodeIds) ||
    value.upstreamNodeIds.length < 1 ||
    value.upstreamNodeIds.length > 500
  ) {
    issue(
      issues,
      `${path}.upstreamNodeIds`,
      "invalid_value",
      "Expected bounded upstream node IDs.",
    );
    return undefined;
  }
  const upstreamNodeIds = value.upstreamNodeIds.flatMap((candidate, upstreamIndex) => {
    const parsed = opaqueId(candidate, `${path}.upstreamNodeIds[${upstreamIndex}]`, issues);
    return parsed ? [parsed] : [];
  });
  if (new Set(upstreamNodeIds).size !== upstreamNodeIds.length) {
    issue(issues, `${path}.upstreamNodeIds`, "duplicate", "Upstream nodes must be unique.");
  }
  return { ...base, type: "node-blocked", nodeId, upstreamNodeIds };
}

function initialProjection(plan: CreateImagesRunPlanV1): CreateImagesRunProjection {
  return {
    status: "queued",
    lastSequence: 0,
    nodes: Object.fromEntries(
      plan.orderedNodeIds.map((nodeId) => [
        nodeId,
        { status: "queued", attempts: [], outputAssetIds: [] },
      ]),
    ),
  };
}

function terminalNode(status: CreateImagesNodeRunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked" ||
    status === "ambiguous"
  );
}

function invalidTransition(path: string, message: string): never {
  const error = new Error(message);
  Object.assign(error, { runContractPath: path });
  throw error;
}

function applyEvent(
  projection: CreateImagesRunProjection,
  plan: CreateImagesRunPlanV1,
  generateNodeIds: ReadonlySet<string>,
  event: CreateImagesRunEventV1,
  eventIndex: number,
  usedIdempotencyKeys: Set<string>,
): void {
  const path = `events[${eventIndex}]`;
  if (event.sequence !== projection.lastSequence + 1) {
    invalidTransition(`${path}.sequence`, "Run events must be strictly monotonic and gap-free.");
  }
  if (event.type === "run-ambiguity-acknowledged") {
    if (
      projection.terminal?.status !== "needs_attention" ||
      projection.status !== "needs_attention" ||
      !Object.values(projection.nodes).some((node) => node.status === "ambiguous")
    ) {
      invalidTransition(
        path,
        "Only a needs-attention run with an ambiguous node can be acknowledged.",
      );
    }
    if (projection.ambiguityResolution) {
      invalidTransition(path, "An unresolved submission can be acknowledged only once.");
    }
    if (event.expectedNeedsAttentionJournalRevision !== event.sequence) {
      invalidTransition(
        `${path}.expectedNeedsAttentionJournalRevision`,
        "The acknowledgement must name the exact needs-attention journal revision.",
      );
    }
    projection.ambiguityResolution = {
      kind: "acknowledged-unresolved-submission",
      acknowledgedAt: event.at,
      acknowledgedAtJournalRevision: event.expectedNeedsAttentionJournalRevision + 1,
    };
  } else if (projection.terminal) {
    invalidTransition(path, "Terminal runs cannot accept more events.");
  } else if (event.type === "run-started") {
    if (projection.status !== "queued") invalidTransition(path, "Run can only start once.");
    projection.status = "running";
  } else if (event.type === "run-paused") {
    if (projection.status !== "running") invalidTransition(path, "Only a running run can pause.");
    const node = projection.nodes[event.beforeNodeId];
    if (!node || node.status !== "queued") {
      invalidTransition(`${path}.beforeNodeId`, "A checkpoint must pause before a queued node.");
    }
    const dependencies = plan.dependencies[event.beforeNodeId] ?? [];
    if (dependencies.some((dependency) => projection.nodes[dependency]?.status !== "succeeded")) {
      invalidTransition(path, "Checkpoint dependencies must be durable before pausing.");
    }
    projection.status = "paused";
    projection.pause = {
      checkpointId: event.checkpointId,
      beforeNodeId: event.beforeNodeId,
      edgeIds: [...event.edgeIds],
      pausedAt: event.at,
    };
  } else if (event.type === "run-resumed") {
    if (
      projection.status !== "paused" ||
      !projection.pause ||
      projection.pause.checkpointId !== event.checkpointId
    ) {
      invalidTransition(path, "Only the current durable checkpoint can resume.");
    }
    projection.status = "running";
    projection.pause = { ...projection.pause, resumedAt: event.at };
  } else if (event.type === "run-cancel-requested") {
    if (projection.cancellation) invalidTransition(path, "Cancellation intent is immutable.");
    projection.cancellation = { reason: event.reason, requestedAt: event.at };
    projection.status = "cancel_requested";
  } else if (event.type === "run-terminal") {
    const nodes = Object.values(projection.nodes);
    if (nodes.some((node) => !terminalNode(node.status))) {
      invalidTransition(path, "Every planned node must be terminal before the run.");
    }
    if (event.status === "succeeded" && nodes.some((node) => node.status !== "succeeded")) {
      invalidTransition(path, "A succeeded run requires every node to succeed.");
    }
    if (
      event.status === "failed" &&
      !nodes.some((node) => node.status === "failed" || node.status === "blocked")
    ) {
      invalidTransition(path, "A failed run requires a failed or blocked node.");
    }
    if (event.status === "cancelled" && !projection.cancellation) {
      invalidTransition(path, "A cancelled run requires durable cancellation intent.");
    }
    if (nodes.some((node) => node.status === "ambiguous") && event.status !== "needs_attention") {
      invalidTransition(path, "An ambiguous node requires a needs-attention run terminal.");
    }
    if (event.status === "needs_attention" && !nodes.some((node) => node.status === "ambiguous")) {
      invalidTransition(path, "A needs-attention run requires an ambiguous node.");
    }
    projection.status = event.status;
    projection.terminal = { status: event.status, at: event.at };
  } else {
    const node = projection.nodes[event.nodeId];
    if (!node)
      invalidTransition(`${path}.nodeId`, "Event references a node outside the immutable plan.");
    if (event.type === "batch-item-state") {
      if (projection.status !== "running" || node.status !== "running") {
        invalidTransition(path, "Batch items can change only while their generation node runs.");
      }
      node.batchItems ??= {};
      const current = node.batchItems[event.itemId];
      const allowed: Readonly<Record<CreateImagesBatchItemState, readonly CreateImagesBatchItemState[]>> = {
        queued: ["submission_prepared", "cancelled", "blocked"],
        submission_prepared: ["submitted", "failed", "cancelled"],
        submitted: ["succeeded", "failed"],
        succeeded: [],
        failed: [],
        blocked: [],
        cancelled: [],
      };
      if (!current && event.state !== "queued") {
        invalidTransition(path, "A batch item must enter the durable queue before it changes state.");
      }
      if (current) {
        if (current.itemIndex !== event.itemIndex) {
          invalidTransition(`${path}.itemIndex`, "A batch item index is immutable.");
        }
        if (!allowed[current.state].includes(event.state)) {
          invalidTransition(path, `Batch item cannot transition from ${current.state} to ${event.state}.`);
        }
      }
      node.batchItems[event.itemId] = {
        itemId: event.itemId,
        itemIndex: event.itemIndex,
        state: event.state,
        outputAssetIds: [...(event.outputAssetIds ?? current?.outputAssetIds ?? [])],
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.usage ? { usage: { ...event.usage } } : {}),
        ...(event.cost ? { cost: { ...event.cost } } : {}),
      };
    } else if (event.type === "node-started") {
      if (projection.status !== "running" || node.status !== "queued") {
        invalidTransition(path, "Only a queued node in a running, non-cancelled run can start.");
      }
      const dependencies = plan.dependencies[event.nodeId] ?? [];
      if (dependencies.some((dependency) => projection.nodes[dependency]?.status !== "succeeded")) {
        invalidTransition(path, "Node dependencies must succeed before it starts.");
      }
      node.status = "running";
    } else if (event.type === "node-blocked") {
      if (node.status !== "queued") invalidTransition(path, "Only a queued node can be blocked.");
      const declaredDependencies = new Set(plan.dependencies[event.nodeId] ?? []);
      if (
        event.upstreamNodeIds.some(
          (dependency) =>
            !declaredDependencies.has(dependency) ||
            !["failed", "cancelled", "blocked", "ambiguous"].includes(
              projection.nodes[dependency]?.status ?? "",
            ),
        )
      ) {
        invalidTransition(path, "Blocked nodes must identify failed direct dependencies.");
      }
      node.status = "blocked";
      node.terminalAt = event.at;
    } else if (event.type === "node-cancelled") {
      if (!projection.cancellation || (node.status !== "queued" && node.status !== "running")) {
        invalidTransition(path, "Cancellation requires durable intent and a nonterminal node.");
      }
      if (node.attempts[node.attempts.length - 1]?.submission === "ambiguous") {
        invalidTransition(
          path,
          "An ambiguous submission must be reconciled or terminalized as ambiguous.",
        );
      }
      node.status = "cancelled";
      node.terminalAt = event.at;
    } else if (event.type === "node-ambiguous") {
      if (node.status !== "running")
        invalidTransition(path, "Only a running node can become ambiguous.");
      const attempt = node.attempts[node.attempts.length - 1];
      if (
        !attempt ||
        attempt.attempt !== event.attempt ||
        (attempt.submission !== "ambiguous" && attempt.submission !== "accepted")
      ) {
        invalidTransition(
          path,
          "Ambiguous terminalization requires the matching ambiguous or accepted submission.",
        );
      }
      node.status = "ambiguous";
      node.terminalAt = event.at;
    } else if (event.type === "node-output-published") {
      if (node.status !== "running") {
        invalidTransition(path, "Only a running node can publish durable output.");
      }
      if (node.durableOutputAssetIds !== undefined) {
        invalidTransition(path, "A node can publish its durable output only once.");
      }
      if (
        generateNodeIds.has(event.nodeId) &&
        node.attempts[node.attempts.length - 1]?.submission !== "accepted"
      ) {
        invalidTransition(
          path,
          "Generate Image output publication requires a durably accepted submission.",
        );
      }
      node.durableOutputAssetIds = [...event.outputAssetIds];
    } else if (event.type === "node-succeeded") {
      if (node.status !== "running") invalidTransition(path, "Only a running node can succeed.");
      if (
        node.batchItems &&
        Object.values(node.batchItems).some((item) => item.state !== "succeeded")
      ) {
        invalidTransition(path, "A successful batch node requires every item to succeed.");
      }
      if (node.attempts[node.attempts.length - 1]?.submission === "ambiguous") {
        invalidTransition(path, "An ambiguous submission must be reconciled before success.");
      }
      if (
        generateNodeIds.has(event.nodeId) &&
        node.attempts[node.attempts.length - 1]?.submission !== "accepted"
      ) {
        invalidTransition(path, "Generate Image success requires a durably accepted submission.");
      }
      if (
        node.durableOutputAssetIds === undefined ||
        JSON.stringify(node.durableOutputAssetIds) !== JSON.stringify(event.outputAssetIds)
      ) {
        invalidTransition(
          path,
          "Node success must match its previously published durable output positions.",
        );
      }
      node.status = "succeeded";
      node.outputAssetIds = [...event.outputAssetIds];
      node.terminalAt = event.at;
    } else if (event.type === "node-failed") {
      const interruptedBeforeStart =
        node.status === "queued" &&
        event.errorCode === "interrupted" &&
        (projection.status === "queued" || projection.status === "running");
      if (node.status !== "running" && !interruptedBeforeStart) {
        invalidTransition(path, "Only a running node can fail, except for a queued interruption.");
      }
      if (node.attempts[node.attempts.length - 1]?.submission === "ambiguous") {
        invalidTransition(
          path,
          "An ambiguous submission must be reconciled or terminalized as ambiguous.",
        );
      }
      if (
        node.batchItems &&
        Object.values(node.batchItems).some((item) =>
          ["queued", "submission_prepared", "submitted"].includes(item.state),
        )
      ) {
        invalidTransition(path, "A failed batch node requires every item to be terminal.");
      }
      node.status = "failed";
      node.errorCode = event.errorCode;
      node.terminalAt = event.at;
    } else {
      if (node.status !== "running")
        invalidTransition(path, "Submission state requires a running node.");
      if (event.type === "node-submission-prepared") {
        const previous = node.attempts[node.attempts.length - 1];
        if (
          event.attempt !== node.attempts.length + 1 ||
          (previous &&
            previous.submission !== "reconciled-not-found" &&
            previous.submission !== "retry-scheduled")
        ) {
          invalidTransition(path, "A new attempt requires a safely sealed predecessor.");
        }
        const reusesRequiredKey =
          previous?.submission === "retry-scheduled" &&
          previous.retry?.safety === "same-idempotency-key";
        if (reusesRequiredKey && event.idempotencyKey !== previous.idempotencyKey) {
          invalidTransition(
            `${path}.idempotencyKey`,
            "This safe retry must reuse the prior idempotency key.",
          );
        }
        if (
          previous?.submission === "retry-scheduled" &&
          previous.retry?.safety === "confirmed-not-submitted" &&
          event.idempotencyKey === previous.idempotencyKey
        ) {
          invalidTransition(
            `${path}.idempotencyKey`,
            "A confirmed-not-submitted retry requires a fresh idempotency key.",
          );
        }
        if (usedIdempotencyKeys.has(event.idempotencyKey) && !reusesRequiredKey) {
          invalidTransition(`${path}.idempotencyKey`, "Idempotency keys must be unique per run.");
        }
        usedIdempotencyKeys.add(event.idempotencyKey);
        node.attempts.push({
          attempt: event.attempt,
          idempotencyKey: event.idempotencyKey,
          providerId: event.providerId,
          modelId: event.modelId,
          submission: "prepared",
        });
      } else {
        const attempt = node.attempts[node.attempts.length - 1];
        if (!attempt || attempt.attempt !== event.attempt) {
          invalidTransition(path, "Submission event does not match the active attempt.");
        }
        if (event.type === "node-retry-scheduled") {
          if (
            (attempt.submission !== "prepared" && attempt.submission !== "ambiguous") ||
            (attempt.submission === "ambiguous" && event.retrySafety !== "same-idempotency-key")
          ) {
            invalidTransition(
              path,
              "A retry requires a prepared submission or an ambiguous submission with the same idempotency key.",
            );
          }
          attempt.submission = "retry-scheduled";
          attempt.retry = {
            errorCode: event.errorCode,
            delayMs: event.delayMs,
            safety: event.retrySafety,
          };
        } else if (event.type === "node-submission-accepted") {
          if (attempt.submission !== "prepared")
            invalidTransition(path, "Only a prepared submission can be accepted.");
          attempt.submission = "accepted";
          if (event.providerJobId) attempt.providerJobId = event.providerJobId;
        } else if (event.type === "node-submission-ambiguous") {
          if (attempt.submission !== "prepared")
            invalidTransition(path, "Only a prepared submission can become ambiguous.");
          attempt.submission = "ambiguous";
        } else {
          if (attempt.submission !== "ambiguous")
            invalidTransition(path, "Only an ambiguous submission can be reconciled.");
          attempt.submission = event.outcome === "accepted" ? "accepted" : "reconciled-not-found";
          if (event.providerJobId) attempt.providerJobId = event.providerJobId;
        }
      }
    }
  }
  projection.lastSequence = event.sequence;
}

export function hasUnresolvedCreateImagesRunAmbiguity(
  projection: CreateImagesRunProjection,
): boolean {
  return (
    projection.terminal?.status === "needs_attention" &&
    projection.ambiguityResolution === undefined &&
    Object.values(projection.nodes).some((node) => node.status === "ambiguous")
  );
}

function replay(
  plan: CreateImagesRunPlanV1,
  events: readonly CreateImagesRunEventV1[],
  generateNodeIds: ReadonlySet<string>,
): CreateImagesRunProjection {
  const projection = initialProjection(plan);
  const usedIdempotencyKeys = new Set<string>();
  for (const [index, event] of events.entries()) {
    applyEvent(projection, plan, generateNodeIds, event, index, usedIdempotencyKeys);
  }
  return projection;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createImagesRunJournalSerializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") return undefined;
    return new TextEncoder().encode(`${serialized}\n`).byteLength;
  } catch {
    return undefined;
  }
}

/** Canonical, path-free snapshot material used by main to calculate SHA-256. */
export function createImagesWorkflowSnapshotFingerprintMaterial(
  snapshot: WorkflowDocumentV1,
): string {
  const parsed = parseWorkflowDocument(snapshot);
  if (!parsed.success) throw new Error(parsed.issues[0]?.message ?? "Invalid workflow snapshot.");
  return `${JSON.stringify(parsed.value)}\n`;
}

export function isFutureCreateImagesRunJournal(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    value.version > CREATE_IMAGES_RUN_JOURNAL_VERSION
  );
}

export function parseCreateImagesRunJournal(value: unknown): CreateImagesRunJournalParseResult {
  const issues: CreateImagesRunContractIssue[] = [];
  const bytes = createImagesRunJournalSerializedBytes(value);
  if (bytes === undefined || bytes > CREATE_IMAGES_MAX_RUN_JOURNAL_BYTES) {
    issue(issues, "$", "too_large", "Run journal exceeds its byte limit.");
    return { success: false, issues };
  }
  if (!isRecord(value)) {
    issue(issues, "$", "invalid_type", "Expected an object.");
    return { success: false, issues };
  }
  rejectUnknown(
    value,
    [
      "version",
      "journalRevision",
      "runId",
      "workflowId",
      "workflowRevision",
      "workflowFingerprint",
      "workflowSnapshot",
      "plan",
      "providerAuthorization",
      "createdAt",
      "updatedAt",
      "events",
    ],
    "$",
    issues,
  );
  if (value.version !== CREATE_IMAGES_RUN_JOURNAL_VERSION) {
    issue(issues, "version", "invalid_value", "Unsupported run journal version.");
  }
  const journalRevision = positiveInteger(
    value.journalRevision,
    "journalRevision",
    issues,
    CREATE_IMAGES_MAX_RUN_EVENTS + 1,
  );
  const runId = opaqueId(value.runId, "runId", issues);
  const workflowId = opaqueId(value.workflowId, "workflowId", issues);
  const workflowRevision = positiveInteger(value.workflowRevision, "workflowRevision", issues);
  const workflowFingerprint = boundedString(
    value.workflowFingerprint,
    "workflowFingerprint",
    issues,
    FINGERPRINT_PATTERN,
    64,
  );
  const createdAt = timestamp(value.createdAt, "createdAt", issues);
  const updatedAt = timestamp(value.updatedAt, "updatedAt", issues);
  const parsedSnapshot = parseWorkflowDocument(value.workflowSnapshot);
  if (!parsedSnapshot.success) {
    for (const snapshotIssue of parsedSnapshot.issues) {
      issue(
        issues,
        `workflowSnapshot.${snapshotIssue.path}`,
        snapshotIssue.code === "too_large" ? "too_large" : "invalid_value",
        snapshotIssue.message,
      );
    }
  }
  const snapshot = parsedSnapshot.success ? parsedSnapshot.value : undefined;
  if (snapshot && (snapshot.id !== workflowId || snapshot.revision !== workflowRevision)) {
    issue(issues, "workflowSnapshot", "invalid_value", "Snapshot identity does not match the run.");
  }
  const plan = snapshot ? parsePlan(value.plan, snapshot, issues) : undefined;
  let providerAuthorization: CreateImagesRunProviderAuthorizationV1 | undefined;
  if (value.providerAuthorization !== undefined) {
    const candidate = value.providerAuthorization;
    if (!isRecord(candidate)) {
      issue(issues, "providerAuthorization", "invalid_type", "Expected an object.");
    } else {
      rejectUnknown(
        candidate,
        [
          "version",
          "executionMode",
          "authorizationId",
          "consentFingerprint",
          "capabilityFingerprint",
          "credentialRecordId",
          "credentialRevision",
          "initialRequestCount",
          "expectedOutputCount",
          "maximumAttempts",
          "createdAt",
          "expiresAt",
        ],
        "providerAuthorization",
        issues,
      );
      const authorizationId = opaqueId(
        candidate.authorizationId,
        "providerAuthorization.authorizationId",
        issues,
      );
      const credentialRecordId = opaqueId(
        candidate.credentialRecordId,
        "providerAuthorization.credentialRecordId",
        issues,
      );
      const consentFingerprint = boundedString(
        candidate.consentFingerprint,
        "providerAuthorization.consentFingerprint",
        issues,
        FINGERPRINT_PATTERN,
        64,
      );
      const capabilityFingerprint = boundedString(
        candidate.capabilityFingerprint,
        "providerAuthorization.capabilityFingerprint",
        issues,
        FINGERPRINT_PATTERN,
        64,
      );
      const credentialRevision = positiveInteger(
        candidate.credentialRevision,
        "providerAuthorization.credentialRevision",
        issues,
      );
      const initialRequestCount = positiveInteger(
        candidate.initialRequestCount,
        "providerAuthorization.initialRequestCount",
        issues,
        500,
      );
      const expectedOutputCount = positiveInteger(
        candidate.expectedOutputCount,
        "providerAuthorization.expectedOutputCount",
        issues,
        2_000,
      );
      const maximumAttempts = positiveInteger(
        candidate.maximumAttempts,
        "providerAuthorization.maximumAttempts",
        issues,
        1_500,
      );
      const authorizationCreatedAt = timestamp(
        candidate.createdAt,
        "providerAuthorization.createdAt",
        issues,
      );
      const authorizationExpiresAt = timestamp(
        candidate.expiresAt,
        "providerAuthorization.expiresAt",
        issues,
      );
      if (candidate.version !== 1 || candidate.executionMode !== "gemini") {
        issue(
          issues,
          "providerAuthorization",
          "invalid_value",
          "Unsupported provider authorization.",
        );
      }
      if (
        authorizationId &&
        credentialRecordId &&
        consentFingerprint &&
        capabilityFingerprint &&
        credentialRevision &&
        initialRequestCount &&
        expectedOutputCount &&
        maximumAttempts &&
        authorizationCreatedAt &&
        authorizationExpiresAt &&
        candidate.version === 1 &&
        candidate.executionMode === "gemini"
      ) {
        if (
          maximumAttempts !== initialRequestCount ||
          Date.parse(authorizationExpiresAt) <= Date.parse(authorizationCreatedAt)
        ) {
          issue(
            issues,
            "providerAuthorization",
            "invalid_value",
            "Provider authorization accounting or expiry is invalid.",
          );
        } else {
          providerAuthorization = {
            version: 1,
            executionMode: "gemini",
            authorizationId,
            consentFingerprint,
            capabilityFingerprint,
            credentialRecordId,
            credentialRevision,
            initialRequestCount,
            expectedOutputCount,
            maximumAttempts,
            createdAt: authorizationCreatedAt,
            expiresAt: authorizationExpiresAt,
          };
        }
      }
    }
  }
  if (!Array.isArray(value.events)) {
    issue(issues, "events", "invalid_type", "Expected an array.");
  } else if (value.events.length > CREATE_IMAGES_MAX_RUN_EVENTS) {
    issue(issues, "events", "too_large", "Run event history exceeds its limit.");
  }
  const events: CreateImagesRunEventV1[] = [];
  if (
    Array.isArray(value.events) &&
    value.events.length <= CREATE_IMAGES_MAX_RUN_EVENTS &&
    runId &&
    workflowId &&
    workflowRevision
  ) {
    for (const [index, candidate] of value.events.entries()) {
      const parsed = parseEvent(candidate, index, { runId, workflowId, workflowRevision }, issues);
      if (parsed) events.push(parsed);
    }
  }
  if (snapshot) {
    const nodeTypes = new Map(snapshot.nodes.map((node) => [node.id, node.type]));
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    for (const [index, event] of events.entries()) {
      if (
        [
          "node-submission-prepared",
          "node-submission-accepted",
          "node-submission-ambiguous",
          "node-submission-reconciled",
          "node-retry-scheduled",
          "node-ambiguous",
        ].includes(event.type) &&
        "nodeId" in event &&
        nodeTypes.get(event.nodeId) !== "generate-image"
      ) {
        issue(
          issues,
          `events[${index}].nodeId`,
          "invalid_value",
          "Submission events are only valid for Generate Image nodes.",
        );
      }
      if (
        event.type === "node-succeeded" &&
        nodeTypes.get(event.nodeId) === "generate-image" &&
        events
          .slice(0, index)
          .filter(
            (candidate): candidate is CreateImagesNodeSubmissionPreparedEventV1 =>
              candidate.type === "node-submission-prepared" && candidate.nodeId === event.nodeId,
          ).length === 0
      ) {
        issue(
          issues,
          `events[${index}]`,
          "invalid_transition",
          "Generate Image success requires a durable submission attempt.",
        );
      }
      if (event.type === "node-submission-prepared" && providerAuthorization) {
        const node = nodes.get(event.nodeId);
        if (
          event.providerId !== "gemini" ||
          node?.type !== "generate-image" ||
          node.data.modelId !== event.modelId
        ) {
          issue(
            issues,
            `events[${index}]`,
            "invalid_value",
            "Submission metadata does not match the durable provider authorization.",
          );
        }
      }
    }
  }
  if (journalRevision !== undefined && journalRevision !== events.length + 1) {
    issue(
      issues,
      "journalRevision",
      "invalid_value",
      "Journal revision must match its append-only history.",
    );
  }
  if (createdAt && updatedAt) {
    const expectedUpdatedAt = events[events.length - 1]?.at ?? createdAt;
    if (updatedAt !== expectedUpdatedAt || Date.parse(updatedAt) < Date.parse(createdAt)) {
      issue(
        issues,
        "updatedAt",
        "invalid_value",
        "Updated time must match the latest journal event.",
      );
    }
    let previous = Date.parse(createdAt);
    for (const [index, event] of events.entries()) {
      const current = Date.parse(event.at);
      if (current < previous)
        issue(issues, `events[${index}].at`, "invalid_value", "Event time moved backwards.");
      previous = current;
    }
  }
  if (plan && events.length === (Array.isArray(value.events) ? value.events.length : -1)) {
    try {
      replay(
        plan,
        events,
        new Set(
          snapshot?.nodes.filter((node) => node.type === "generate-image").map((node) => node.id),
        ),
      );
    } catch (error) {
      const path = (error as { runContractPath?: string }).runContractPath ?? "events";
      issue(
        issues,
        path,
        "invalid_transition",
        error instanceof Error ? error.message : "Invalid run transition.",
      );
    }
  }
  if (
    issues.length > 0 ||
    !journalRevision ||
    !runId ||
    !workflowId ||
    !workflowRevision ||
    !workflowFingerprint ||
    !snapshot ||
    !plan ||
    !createdAt ||
    !updatedAt
  ) {
    return { success: false, issues };
  }
  return {
    success: true,
    value: deepFreeze({
      version: CREATE_IMAGES_RUN_JOURNAL_VERSION,
      journalRevision,
      runId,
      workflowId,
      workflowRevision,
      workflowFingerprint,
      workflowSnapshot: snapshot,
      plan,
      ...(providerAuthorization ? { providerAuthorization } : {}),
      createdAt,
      updatedAt,
      events,
    }),
  };
}

export function createCreateImagesRunJournal(
  input: CreateImagesRunJournalCreationInput,
): CreateImagesRunJournalV1 {
  const candidate = {
    version: CREATE_IMAGES_RUN_JOURNAL_VERSION,
    journalRevision: 1,
    runId: input.runId,
    workflowId: input.workflowSnapshot.id,
    workflowRevision: input.workflowSnapshot.revision,
    workflowFingerprint: input.workflowFingerprint,
    workflowSnapshot: input.workflowSnapshot,
    plan: input.plan,
    ...(input.providerAuthorization ? { providerAuthorization: input.providerAuthorization } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    events: [],
  };
  const parsed = parseCreateImagesRunJournal(candidate);
  if (!parsed.success) throw new Error(parsed.issues[0]?.message ?? "Invalid Create Images run.");
  return parsed.value;
}

export function appendCreateImagesRunEvent(
  journal: CreateImagesRunJournalV1,
  event: CreateImagesRunEventV1,
): CreateImagesRunJournalV1 {
  const candidate = {
    ...journal,
    journalRevision: journal.journalRevision + 1,
    updatedAt: event.at,
    events: [...journal.events, event],
  };
  const parsed = parseCreateImagesRunJournal(candidate);
  if (!parsed.success)
    throw new Error(parsed.issues[0]?.message ?? "Invalid Create Images run event.");
  return parsed.value;
}

export function projectCreateImagesRun(
  journal: CreateImagesRunJournalV1,
): CreateImagesRunProjection {
  const parsed = parseCreateImagesRunJournal(journal);
  if (!parsed.success)
    throw new Error(parsed.issues[0]?.message ?? "Invalid Create Images run journal.");
  return deepFreeze(
    replay(
      parsed.value.plan,
      parsed.value.events,
      new Set(
        parsed.value.workflowSnapshot.nodes
          .filter((node) => node.type === "generate-image")
          .map((node) => node.id),
      ),
    ),
  );
}
