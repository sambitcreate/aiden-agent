import {
  CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY,
  createImagesLocalMockAttemptBudget,
} from "../shared/create-images/retry-policy";
import type {
  CreateImagesDegradedRunDiscardPlanResult,
  CreateImagesDiscardDegradedRunRequest,
} from "../shared/create-images/ipc";

export function createImagesDegradedRunDiscardRequest(
  plan: Extract<CreateImagesDegradedRunDiscardPlanResult, { status: "ready" }>,
  reviewed: boolean,
): CreateImagesDiscardDegradedRunRequest | undefined {
  if (!reviewed) return undefined;
  return Object.freeze({
    runId: plan.runId,
    ...(plan.expectedCurrentJournalRevision === undefined
      ? {}
      : { expectedCurrentJournalRevision: plan.expectedCurrentJournalRevision }),
    ...(plan.expectedLastKnownGoodJournalRevision === undefined
      ? {}
      : { expectedLastKnownGoodJournalRevision: plan.expectedLastKnownGoodJournalRevision }),
    authorizationToken: plan.authorizationToken,
    confirmed: true,
  });
}

export type CreateImagesNodeRunUiStatus =
  | "queued"
  | "running"
  | "retry"
  | "blocked"
  | "failed"
  | "cancelled"
  | "succeeded";

export type CreateImagesRunUiStatus =
  | "awaiting-consent"
  | "queued"
  | "running"
  | "stopping"
  | "retry"
  | "failed"
  | "cancelled"
  | "succeeded"
  | "interrupted";

export type CreateImagesRunScopeView =
  | { kind: "all"; includedNodeCount: number }
  | {
      kind: "from-node";
      startNodeId: string;
      startNodeLabel: string;
      includedNodeCount: number;
      downstreamPathLabels: readonly string[];
    };

export interface CreateImagesMockEstimate {
  kind: "mock" | "best-effort" | "unavailable";
  amount?: number;
  currency?: string;
  estimatedAt: string;
  sourceLabel: string;
}

export interface CreateImagesRunConfirmationInput {
  workflowId: string;
  workflowTitle: string;
  workflowRevision: number;
  scope: CreateImagesRunScopeView;
  executionMode: "local-mock" | "cloud";
  providerLabel: string;
  modelLabel: string;
  remoteRequestCount: number;
  outputCount: number;
  imageSizeLabel: string;
  qualityLabel: string;
  referenceImageCount: number;
  sendsPrompt: boolean;
  estimate: CreateImagesMockEstimate;
  firstCloudUse?: boolean;
}

export interface CreateImagesRunConfirmationRow {
  id: "scope" | "destination" | "requests" | "outputs" | "estimate" | "privacy";
  label: string;
  value: string;
  detail?: string;
}

export interface CreateImagesRunConfirmationViewModel {
  title: string;
  confirmLabel: string;
  workflowId: string;
  workflowRevision: number;
  scopeKind: CreateImagesRunScopeView["kind"];
  rows: readonly CreateImagesRunConfirmationRow[];
  privacyNotices: readonly string[];
  consentStatement: string;
  estimateLabel: string;
  isMock: boolean;
}

const COUNT_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function boundedCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function nonEmptyLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function plural(count: number, singular: string, multiple = `${singular}s`): string {
  return `${COUNT_FORMATTER.format(count)} ${count === 1 ? singular : multiple}`;
}

export function formatCreateImagesEstimate(estimate: CreateImagesMockEstimate): string {
  if (!Number.isFinite(Date.parse(estimate.estimatedAt))) {
    throw new Error("The estimate timestamp must be an ISO-compatible date.");
  }
  nonEmptyLabel(estimate.sourceLabel, "Estimate source");
  if (estimate.kind === "unavailable") return "Estimate unavailable";
  if (
    estimate.amount === undefined ||
    !Number.isFinite(estimate.amount) ||
    estimate.amount < 0 ||
    !estimate.currency
  ) {
    throw new Error("A priced estimate requires a non-negative amount and currency.");
  }
  let amount: string;
  try {
    amount = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: estimate.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(estimate.amount);
  } catch {
    throw new Error("The estimate currency is invalid.");
  }
  return estimate.kind === "mock" ? `${amount} mock estimate` : `About ${amount}`;
}

function scopePresentation(scope: CreateImagesRunScopeView): {
  title: string;
  value: string;
  detail?: string;
} {
  const includedNodeCount = boundedCount(scope.includedNodeCount, "Included node count");
  if (scope.kind === "all") {
    return {
      title: "Run workflow?",
      value: `Entire workflow · ${plural(includedNodeCount, "node")}`,
    };
  }
  const startNodeLabel = nonEmptyLabel(scope.startNodeLabel, "Start node label");
  const downstreamPathLabels = scope.downstreamPathLabels.map((label) =>
    nonEmptyLabel(label, "Downstream path label"),
  );
  const downstreamPathDetail =
    downstreamPathLabels.length <= 4
      ? downstreamPathLabels.join(" → ")
      : `${downstreamPathLabels[0]} → ${downstreamPathLabels[1]} → … ${downstreamPathLabels.length - 3} more → ${downstreamPathLabels[downstreamPathLabels.length - 1]}`;
  return {
    title: "Run from here?",
    value: `${startNodeLabel} · ${plural(includedNodeCount, "node")}`,
    detail:
      downstreamPathLabels.length > 0
        ? `Selected path: ${downstreamPathDetail}`
        : "Required inputs and the selected node are included.",
  };
}

export function createImagesRunConfirmationViewModel(
  input: CreateImagesRunConfirmationInput,
): CreateImagesRunConfirmationViewModel {
  nonEmptyLabel(input.workflowId, "Workflow ID");
  nonEmptyLabel(input.workflowTitle, "Workflow title");
  if (!Number.isSafeInteger(input.workflowRevision) || input.workflowRevision < 0) {
    throw new Error("Workflow revision must be a non-negative safe integer.");
  }
  const provider = nonEmptyLabel(input.providerLabel, "Provider label");
  const model = nonEmptyLabel(input.modelLabel, "Model label");
  const imageSize = nonEmptyLabel(input.imageSizeLabel, "Image size label");
  const quality = nonEmptyLabel(input.qualityLabel, "Quality label");
  const remoteRequests = boundedCount(input.remoteRequestCount, "Remote request count");
  const outputCount = boundedCount(input.outputCount, "Output count");
  const referenceImageCount = boundedCount(input.referenceImageCount, "Reference image count");
  const scope = scopePresentation(input.scope);
  const estimateLabel = formatCreateImagesEstimate(input.estimate);
  const isMock = input.executionMode === "local-mock";
  const attemptBudget = isMock
    ? createImagesLocalMockAttemptBudget(remoteRequests)
    : {
        initialGenerationRequests: remoteRequests,
        maximumAutomaticRetryAttempts: 0,
        maximumTotalAttempts: remoteRequests,
      };
  const dataKinds = [
    ...(input.sendsPrompt ? ["prompt text"] : []),
    ...(referenceImageCount > 0 ? [plural(referenceImageCount, "reference image")] : []),
  ];
  const privacyValue = isMock
    ? "Local simulation · nothing leaves this Mac"
    : dataKinds.length > 0
      ? `${dataKinds.join(" and ")} sent to ${provider}`
      : `Run metadata sent to ${provider}`;
  const privacyNotices = isMock
    ? [
        "This Phase 3 mock run makes no provider request and creates no billable work.",
        "The confirmation mirrors the information Aiden will require before a future cloud run.",
        "Mock outputs remain in Aiden's device-local image store.",
      ]
    : [
        "Prompts and reference images listed above leave this Mac and are handled under the provider's terms and retention policy.",
        "Cost may be incurred. Stopping a submitted request may not prevent provider completion or billing.",
        "Only upload material you have the rights and consent to use. Aiden copies valid outputs to its device-local image store.",
      ];
  if (!isMock && input.firstCloudUse) {
    privacyNotices.unshift(
      "This is the first cloud image run confirmed for this workflow on this device.",
    );
  }
  return {
    title: scope.title,
    confirmLabel: isMock ? "Run mock workflow" : "Confirm & run",
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    scopeKind: input.scope.kind,
    estimateLabel,
    isMock,
    consentStatement: isMock
      ? "I reviewed this mock run plan and understand that it stays on this Mac."
      : "I reviewed the requests, estimate, and data transfer described above.",
    rows: [
      {
        id: "scope",
        label: "Scope",
        value: scope.value,
        ...(scope.detail ? { detail: scope.detail } : {}),
      },
      { id: "destination", label: "Destination", value: `${provider} · ${model}` },
      {
        id: "requests",
        label: isMock ? "Simulated requests" : "Remote requests",
        value: isMock
          ? `${plural(attemptBudget.initialGenerationRequests, "initial request")} · up to ${plural(attemptBudget.maximumTotalAttempts, "total attempt")}`
          : plural(attemptBudget.initialGenerationRequests, "request"),
        detail: isMock
          ? `Includes up to ${plural(attemptBudget.maximumAutomaticRetryAttempts, "safe automatic retry attempt")} (${CREATE_IMAGES_LOCAL_MOCK_RETRY_POLICY.maxRetriesPerNode} per generation node). The Phase 3 mock stays local and costs $0.`
          : "This confirmation does not authorize paid automatic retries. A provider retry policy must be reviewed separately before launch.",
      },
      {
        id: "outputs",
        label: "Expected output",
        value: `${plural(outputCount, "image")} · ${imageSize} · ${quality}`,
      },
      {
        id: "estimate",
        label: "Cost",
        value: estimateLabel,
        detail: `${input.estimate.sourceLabel} · ${new Date(input.estimate.estimatedAt).toLocaleString()}`,
      },
      { id: "privacy", label: "Data", value: privacyValue },
    ],
    privacyNotices,
  };
}

export type CreateImagesSafeRunErrorCode =
  | "offline"
  | "rate_limited"
  | "provider_refused"
  | "provider_unavailable"
  | "output_invalid"
  | "quota_full"
  | "interrupted"
  | "submission_ambiguous"
  | "unknown";

export type CreateImagesRunErrorAction =
  | "review-retry"
  | "check-connection"
  | "open-provider-settings"
  | "manage-storage"
  | "view-history";

export interface CreateImagesSafeRunError {
  code: CreateImagesSafeRunErrorCode;
  nodeLabel?: string;
  retainedOutputCount?: number;
  retryKind: "none" | "local" | "remote";
}

export interface CreateImagesRunErrorViewModel {
  title: string;
  description: string;
  nextStep: string;
  actions: readonly CreateImagesRunErrorAction[];
  retainedOutputLabel?: string;
  retry: {
    available: boolean;
    automatic: false;
    requiresConfirmation: boolean;
    label: "Retry" | "Review & retry";
  };
}

const SAFE_ERROR_COPY: Readonly<
  Record<
    CreateImagesSafeRunErrorCode,
    Pick<CreateImagesRunErrorViewModel, "title" | "description" | "nextStep" | "actions">
  >
> = {
  offline: {
    title: "No network connection",
    description: "Aiden could not reach the configured image provider.",
    nextStep: "Check the connection, then review the run before retrying.",
    actions: ["check-connection", "review-retry"],
  },
  rate_limited: {
    title: "Provider rate limit reached",
    description: "The provider asked Aiden to wait before another request.",
    nextStep: "Retry only when you are ready; Aiden will not submit a paid retry automatically.",
    actions: ["review-retry"],
  },
  provider_refused: {
    title: "Provider declined this request",
    description: "The provider did not generate an image for this request.",
    nextStep: "Review the prompt and provider policy before starting a new run.",
    actions: ["view-history"],
  },
  provider_unavailable: {
    title: "Image provider unavailable",
    description: "The configured provider or model cannot accept this run right now.",
    nextStep: "Check the provider connection and model configuration before retrying.",
    actions: ["open-provider-settings", "review-retry"],
  },
  output_invalid: {
    title: "Provider output could not be saved",
    description: "Aiden rejected the returned file because it did not pass image validation.",
    nextStep: "Review the run record. A new provider request requires an explicit retry.",
    actions: ["view-history", "review-retry"],
  },
  quota_full: {
    title: "Image storage is full",
    description: "Aiden cannot safely persist another output within the configured storage limit.",
    nextStep: "Free space or raise the storage limit before retrying.",
    actions: ["manage-storage"],
  },
  interrupted: {
    title: "Run interrupted",
    description: "Aiden could not safely continue this run to a durable terminal result.",
    nextStep: "Inspect the terminal run record before deciding whether to start a new run.",
    actions: ["view-history", "review-retry"],
  },
  submission_ambiguous: {
    title: "Provider submission is unresolved",
    description: "Aiden cannot confirm whether the provider accepted the request.",
    nextStep:
      "Do not retry. Open the durable run record and explicitly acknowledge the unresolved outcome before considering a separately confirmed new run.",
    actions: ["view-history"],
  },
  unknown: {
    title: "Run could not continue",
    description: "Aiden recorded a safe error code without exposing provider response data.",
    nextStep: "Review the run history and configuration before retrying.",
    actions: ["view-history"],
  },
};

export function createImagesRunErrorViewModel(
  error: CreateImagesSafeRunError,
): CreateImagesRunErrorViewModel {
  const copy = SAFE_ERROR_COPY[error.code];
  const retainedOutputCount = boundedCount(error.retainedOutputCount ?? 0, "Retained output count");
  const retryAvailable = error.retryKind !== "none" && copy.actions.includes("review-retry");
  return {
    ...copy,
    retainedOutputLabel:
      retainedOutputCount > 0
        ? `${plural(retainedOutputCount, "completed output")} retained locally.`
        : undefined,
    retry: {
      available: retryAvailable,
      automatic: false,
      requiresConfirmation: error.retryKind === "remote",
      label: error.retryKind === "remote" ? "Review & retry" : "Retry",
    },
  };
}

export interface CreateImagesRunUiIdentity {
  workflowId: string;
  workflowRevision: number;
  runId: string;
}

export interface CreateImagesNodeRunUiState {
  nodeId: string;
  label: string;
  status: CreateImagesNodeRunUiStatus;
  sequence: number;
  attempt: number;
  outputAssetIds?: readonly string[];
  retryMode?: "automatic-mock" | "manual-review";
  progress?: { completed: number; total: number; label: string };
  error?: CreateImagesSafeRunError;
}

interface CreateImagesRunUiEventBase extends CreateImagesRunUiIdentity {
  sequence: number;
}

export type CreateImagesRunUiEvent =
  | (CreateImagesRunUiEventBase & {
      kind: "node-status";
      nodeId: string;
      status: CreateImagesNodeRunUiStatus;
      attempt: number;
      retryMode?: "automatic-mock" | "manual-review";
      error?: CreateImagesSafeRunError;
    })
  | (CreateImagesRunUiEventBase & {
      kind: "node-progress";
      nodeId: string;
      completed: number;
      total: number;
      label: string;
    })
  | (CreateImagesRunUiEventBase & {
      kind: "run-status";
      status: CreateImagesRunUiStatus;
    });

export interface CreateImagesRunUiProjection extends CreateImagesRunUiIdentity {
  executionMode?: "local-mock" | "gemini";
  status: CreateImagesRunUiStatus;
  lastSequence: number;
  nodes: Readonly<Record<string, CreateImagesNodeRunUiState>>;
  ignoredEventCount: number;
  announcement: string;
  ambiguityAcknowledged?: true;
}

export interface CreateImagesRunUiSnapshot extends CreateImagesRunUiIdentity {
  executionMode?: "local-mock" | "gemini";
  status: CreateImagesRunUiStatus;
  lastSequence: number;
  nodes: readonly Omit<CreateImagesNodeRunUiState, "sequence">[];
  ambiguityAcknowledged?: true;
}

const NODE_TRANSITIONS: Readonly<
  Record<CreateImagesNodeRunUiStatus, readonly CreateImagesNodeRunUiStatus[]>
> = {
  queued: ["running", "blocked", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "retry"],
  retry: ["running"],
  blocked: [],
  failed: ["retry"],
  cancelled: [],
  succeeded: [],
};

const RUN_TRANSITIONS: Readonly<
  Record<CreateImagesRunUiStatus, readonly CreateImagesRunUiStatus[]>
> = {
  "awaiting-consent": ["queued", "cancelled"],
  queued: ["running", "failed", "cancelled", "interrupted"],
  running: ["stopping", "retry", "failed", "cancelled", "succeeded", "interrupted"],
  stopping: ["failed", "cancelled", "succeeded", "interrupted"],
  retry: [],
  failed: ["retry"],
  cancelled: [],
  succeeded: [],
  interrupted: ["retry"],
};

const NODE_STATUS_LABELS: Readonly<Record<CreateImagesNodeRunUiStatus, string>> = {
  queued: "Queued",
  running: "Running",
  retry: "Retry needed",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
  succeeded: "Succeeded",
};

export const CREATE_IMAGES_RUN_STATUS_LABELS: Readonly<Record<CreateImagesRunUiStatus, string>> = {
  "awaiting-consent": "Waiting for confirmation",
  queued: "Queued",
  running: "Running",
  stopping: "Stopping",
  retry: "Retry needs review",
  failed: "Failed",
  cancelled: "Cancelled",
  succeeded: "Succeeded",
  interrupted: "Interrupted",
};

function validIdentity(identity: CreateImagesRunUiIdentity): void {
  nonEmptyLabel(identity.workflowId, "Workflow ID");
  nonEmptyLabel(identity.runId, "Run ID");
  if (!Number.isSafeInteger(identity.workflowRevision) || identity.workflowRevision < 0) {
    throw new Error("Workflow revision must be a non-negative safe integer.");
  }
}

function validSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Run event sequence must be a non-negative safe integer.");
  }
}

export function createImagesRunUiProjection(
  snapshot: CreateImagesRunUiSnapshot,
): CreateImagesRunUiProjection {
  validIdentity(snapshot);
  validSequence(snapshot.lastSequence);
  const nodes: Record<string, CreateImagesNodeRunUiState> = {};
  for (const node of snapshot.nodes) {
    nonEmptyLabel(node.nodeId, "Node ID");
    nonEmptyLabel(node.label, "Node label");
    if (nodes[node.nodeId]) throw new Error(`Duplicate run node "${node.nodeId}".`);
    if (!Number.isSafeInteger(node.attempt) || node.attempt < 0) {
      throw new Error("Node attempt must be a non-negative safe integer.");
    }
    if (node.attempt === 0 && !["queued", "blocked", "cancelled"].includes(node.status)) {
      throw new Error("Only nodes that have not started may use attempt zero.");
    }
    nodes[node.nodeId] = { ...node, sequence: snapshot.lastSequence };
  }
  return {
    workflowId: snapshot.workflowId,
    workflowRevision: snapshot.workflowRevision,
    runId: snapshot.runId,
    ...(snapshot.executionMode ? { executionMode: snapshot.executionMode } : {}),
    status: snapshot.status,
    lastSequence: snapshot.lastSequence,
    nodes,
    ignoredEventCount: 0,
    announcement: `${CREATE_IMAGES_RUN_STATUS_LABELS[snapshot.status]} run loaded.`,
    ...(snapshot.ambiguityAcknowledged ? { ambiguityAcknowledged: true as const } : {}),
  };
}

function ignoreRunUiEvent(state: CreateImagesRunUiProjection): CreateImagesRunUiProjection {
  return { ...state, ignoredEventCount: state.ignoredEventCount + 1 };
}

function identitiesEqual(
  state: CreateImagesRunUiIdentity,
  event: CreateImagesRunUiIdentity,
): boolean {
  return (
    state.workflowId === event.workflowId &&
    state.workflowRevision === event.workflowRevision &&
    state.runId === event.runId
  );
}

function isRunTerminal(status: CreateImagesRunUiStatus): boolean {
  return ["retry", "failed", "cancelled", "succeeded", "interrupted"].includes(status);
}

function progressIsValid(completed: number, total: number): boolean {
  return (
    Number.isSafeInteger(completed) &&
    Number.isSafeInteger(total) &&
    completed >= 0 &&
    total > 0 &&
    completed <= total
  );
}

/**
 * Applies only the exact next event for this immutable workflow revision and run.
 * Gaps, duplicates, other runs, invalid transitions, and late terminal events are
 * ignored. A fresh main-owned snapshot is the only way to reconcile a sequence gap.
 */
export function reduceCreateImagesRunUiEvent(
  state: CreateImagesRunUiProjection,
  event: CreateImagesRunUiEvent,
): CreateImagesRunUiProjection {
  if (
    !identitiesEqual(state, event) ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence !== state.lastSequence + 1 ||
    isRunTerminal(state.status)
  ) {
    return ignoreRunUiEvent(state);
  }
  if (event.kind === "run-status") {
    if (!RUN_TRANSITIONS[state.status].includes(event.status)) return ignoreRunUiEvent(state);
    return {
      ...state,
      status: event.status,
      lastSequence: event.sequence,
      announcement: `Workflow run ${CREATE_IMAGES_RUN_STATUS_LABELS[event.status].toLowerCase()}.`,
    };
  }
  const node = state.nodes[event.nodeId];
  if (!node) return ignoreRunUiEvent(state);
  if (event.kind === "node-progress") {
    if (
      node.status !== "running" ||
      !progressIsValid(event.completed, event.total) ||
      !event.label.trim()
    ) {
      return ignoreRunUiEvent(state);
    }
    const percentage = Math.round((event.completed / event.total) * 100);
    return {
      ...state,
      lastSequence: event.sequence,
      nodes: {
        ...state.nodes,
        [node.nodeId]: {
          ...node,
          sequence: event.sequence,
          progress: {
            completed: event.completed,
            total: event.total,
            label: event.label.trim(),
          },
        },
      },
      announcement: `${node.label}: ${event.label.trim()}, ${percentage} percent.`,
    };
  }
  if (!Number.isSafeInteger(event.attempt) || event.attempt < 0) {
    return ignoreRunUiEvent(state);
  }
  if (!NODE_TRANSITIONS[node.status].includes(event.status)) return ignoreRunUiEvent(state);
  if (
    node.status === "retry" &&
    (node.retryMode !== "automatic-mock" ||
      event.status !== "running" ||
      event.attempt !== node.attempt + 1)
  ) {
    return ignoreRunUiEvent(state);
  }
  if (
    node.status === "queued" &&
    event.status === "running" &&
    event.attempt !== node.attempt + 1
  ) {
    return ignoreRunUiEvent(state);
  }
  if (
    !(node.status === "queued" && event.status === "running") &&
    node.status !== "retry" &&
    event.attempt !== node.attempt
  ) {
    return ignoreRunUiEvent(state);
  }
  if (event.status === "retry" && !event.retryMode) return ignoreRunUiEvent(state);
  return {
    ...state,
    lastSequence: event.sequence,
    nodes: {
      ...state.nodes,
      [node.nodeId]: {
        ...node,
        status: event.status,
        attempt: event.attempt,
        sequence: event.sequence,
        ...(event.status === "retry" && event.retryMode
          ? { retryMode: event.retryMode }
          : { retryMode: undefined }),
        ...(event.error ? { error: event.error } : { error: undefined }),
        ...(event.status === "running" ? { progress: undefined } : {}),
      },
    },
    announcement: `${node.label}: ${NODE_STATUS_LABELS[event.status].toLowerCase()}.`,
  };
}

export interface CreateImagesRunProgressSummary {
  completed: number;
  total: number;
  active: number;
  waiting: number;
  failed: number;
  percentage: number;
  label: string;
}

export function summarizeCreateImagesRunProgress(
  nodes: readonly CreateImagesNodeRunUiState[],
): CreateImagesRunProgressSummary {
  const automaticRetryWaiting = (node: CreateImagesNodeRunUiState): boolean =>
    node.status === "retry" && node.retryMode === "automatic-mock";
  const completed = nodes.filter(
    (node) =>
      ["succeeded", "failed", "cancelled", "blocked", "retry"].includes(node.status) &&
      !automaticRetryWaiting(node),
  ).length;
  const active = nodes.filter((node) => node.status === "running").length;
  const waiting = nodes.filter(
    (node) => node.status === "queued" || automaticRetryWaiting(node),
  ).length;
  const failed = nodes.filter(
    (node) =>
      node.status === "failed" || (node.status === "retry" && node.retryMode !== "automatic-mock"),
  ).length;
  const total = nodes.length;
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  return {
    completed,
    total,
    active,
    waiting,
    failed,
    percentage,
    label:
      total === 0
        ? "No nodes scheduled"
        : `${plural(completed, "node")} finished of ${COUNT_FORMATTER.format(total)}`,
  };
}

export interface CreateImagesTerminalRunHistoryItem {
  runId: string;
  workflowRevision: number;
  scopeLabel: string;
  status: "retry" | "failed" | "cancelled" | "succeeded" | "interrupted";
  startedAt: string;
  finishedAt: string;
  providerLabel: string;
  modelLabel: string;
  requestCount: number;
  completedNodeCount: number;
  totalNodeCount: number;
  outputCount: number;
  costLabel: string;
  ambiguityAcknowledged?: true;
}

export interface CreateImagesTerminalRunHistoryView extends CreateImagesTerminalRunHistoryItem {
  durationLabel: string;
  nodeSummary: string;
  outputSummary: string;
}

function durationLabel(startedAt: string, finishedAt: string): string {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) return "Duration unavailable";
  const seconds = Math.round(duration / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function createImagesTerminalRunHistoryViews(
  items: readonly CreateImagesTerminalRunHistoryItem[],
): readonly CreateImagesTerminalRunHistoryView[] {
  return [...items]
    .map((item) => {
      nonEmptyLabel(item.runId, "Run ID");
      boundedCount(item.requestCount, "Request count");
      boundedCount(item.completedNodeCount, "Completed node count");
      boundedCount(item.totalNodeCount, "Total node count");
      boundedCount(item.outputCount, "Output count");
      if (item.completedNodeCount > item.totalNodeCount) {
        throw new Error("Completed nodes cannot exceed total nodes.");
      }
      return {
        ...item,
        durationLabel: durationLabel(item.startedAt, item.finishedAt),
        nodeSummary: `${item.completedNodeCount} of ${item.totalNodeCount} nodes succeeded`,
        outputSummary: plural(item.outputCount, "output"),
      };
    })
    .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt));
}
