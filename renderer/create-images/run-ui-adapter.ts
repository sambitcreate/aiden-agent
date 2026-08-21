import type {
  CreateImagesRunChangedNotification,
  CreateImagesRunListResult,
  CreateImagesRunNodeView,
  CreateImagesRunRecoveryView,
  CreateImagesRunSubscriptionResult,
  CreateImagesRunView,
  CreateImagesTerminalRunView,
} from "../shared/create-images/ipc";
import {
  createImagesRunUiProjection,
  type CreateImagesNodeRunUiState,
  type CreateImagesRunUiProjection,
  type CreateImagesRunUiStatus,
  type CreateImagesSafeRunError,
  type CreateImagesSafeRunErrorCode,
  type CreateImagesTerminalRunHistoryItem,
} from "./run-ui-core";

export interface CreateImagesRendererRunState {
  projection?: CreateImagesRunUiProjection;
  history: readonly CreateImagesTerminalRunHistoryItem[];
  recoveries: readonly CreateImagesRunRecoveryView[];
  runAssetOwners: Readonly<Record<string, string>>;
  runTombstones?: readonly string[];
  projectionUpdatedAt?: string;
  errorMessage?: string;
}

export type CreateImagesSelectedRunSnapshotTransition =
  | { kind: "unchanged" }
  | { kind: "recovery-changed"; recovery: CreateImagesRunRecoveryView }
  | { kind: "became-healthy" }
  | { kind: "removed" };

const MAX_RENDERER_RUN_TOMBSTONES = 256;

const EMPTY_RUN_STATE: CreateImagesRendererRunState = Object.freeze({
  history: Object.freeze([]),
  recoveries: Object.freeze([]),
  runAssetOwners: Object.freeze({}),
  runTombstones: Object.freeze([]),
});

const RUN_STATUS: Readonly<Record<CreateImagesRunView["status"], CreateImagesRunUiStatus>> = {
  queued: "queued",
  running: "running",
  paused: "paused",
  cancel_requested: "stopping",
  needs_attention: "retry",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

function sameRunRecovery(
  previous: CreateImagesRunRecoveryView | undefined,
  next: CreateImagesRunRecoveryView,
): boolean {
  if (
    !previous ||
    previous.status !== next.status ||
    previous.workflowId !== next.workflowId ||
    previous.runId !== next.runId ||
    previous.reason !== next.reason
  ) {
    return false;
  }
  if (previous.status === "unsafe" || next.status === "unsafe") return true;
  return (
    previous.currentJournalRevision === next.currentJournalRevision &&
    previous.lastKnownGoodJournalRevision === next.lastKnownGoodJournalRevision &&
    previous.recoverySource === next.recoverySource &&
    previous.expectedCandidateJournalRevision === next.expectedCandidateJournalRevision
  );
}

/** Classifies only authoritative changes to the currently selected durable run record. */
export function createImagesSelectedRunSnapshotTransition(
  result: Extract<CreateImagesRunListResult, { status: "ready" }>,
  selectedRunId: string,
  previousRecovery?: CreateImagesRunRecoveryView,
): CreateImagesSelectedRunSnapshotTransition {
  const recovery = result.recoveries.find((item) => item.runId === selectedRunId);
  if (recovery) {
    return sameRunRecovery(previousRecovery, recovery)
      ? { kind: "unchanged" }
      : { kind: "recovery-changed", recovery };
  }
  const healthy =
    result.activeRun?.runId === selectedRunId ||
    result.latestTerminalRun?.runId === selectedRunId ||
    result.history.some((item) => item.runId === selectedRunId);
  if (!healthy) return { kind: "removed" };
  return previousRecovery ? { kind: "became-healthy" } : { kind: "unchanged" };
}

const SAFE_ERROR_CODES: Readonly<Record<string, CreateImagesSafeRunErrorCode>> = {
  "authentication-required": "authentication_required",
  offline: "offline",
  "permission-denied": "permission_denied",
  "rate-limited": "rate_limited",
  "request-rejected": "request_rejected",
  "provider-refused": "provider_refused",
  "provider-unavailable": "provider_unavailable",
  "output-invalid": "output_invalid",
  "output-publication-failed": "output_save_failed",
  "quota-full": "quota_full",
  interrupted: "interrupted",
  "submission-ambiguous": "submission_ambiguous",
};

function nodeError(node: CreateImagesRunNodeView): CreateImagesSafeRunError | undefined {
  if (node.status === "ambiguous") {
    return { code: "submission_ambiguous", retryKind: "none" };
  }
  if (!node.errorCode) return undefined;
  return {
    code: SAFE_ERROR_CODES[node.errorCode] ?? "unknown",
    retryKind: node.status === "failed" ? "local" : "none",
  };
}

function runNode(node: CreateImagesRunNodeView): Omit<CreateImagesNodeRunUiState, "sequence"> {
  const automaticMockRetry = node.status === "running" && node.retrySafety !== undefined;
  const status = automaticMockRetry ? "retry" : node.status === "ambiguous" ? "retry" : node.status;
  return {
    nodeId: node.nodeId,
    label: node.label,
    status,
    attempt: node.attempt,
    outputAssetIds: [...node.outputAssetIds],
    ...(automaticMockRetry ? { retryMode: "automatic-mock" as const } : {}),
    ...(node.status === "ambiguous" ? { retryMode: "manual-review" as const } : {}),
    ...(nodeError(node) ? { error: nodeError(node) } : {}),
  };
}

export function createImagesRunProjectionFromView(
  run: CreateImagesRunView,
): CreateImagesRunUiProjection {
  return createImagesRunUiProjection({
    workflowId: run.workflowId,
    workflowRevision: run.workflowRevision,
    runId: run.runId,
    journalRevision: run.journalRevision,
    ...(run.executionMode ? { executionMode: run.executionMode } : {}),
    status: RUN_STATUS[run.status],
    lastSequence: run.lastSequence,
    ...(run.ambiguityResolution ? { ambiguityAcknowledged: true as const } : {}),
    nodes: run.nodes.map(runNode),
  });
}

function terminalStatus(
  status: CreateImagesTerminalRunView["status"],
): CreateImagesTerminalRunHistoryItem["status"] {
  return status === "needs_attention" ? "retry" : status;
}

function scopeLabel(
  run: CreateImagesTerminalRunView,
  nodeLabels: Readonly<Record<string, string>>,
): string {
  if (run.scope.kind === "all") return `Entire workflow · revision ${run.workflowRevision}`;
  return `From ${nodeLabels[run.scope.nodeId] ?? run.scope.nodeId}`;
}

export function createImagesTerminalHistoryFromViews(
  history: readonly CreateImagesTerminalRunView[],
  nodeLabels: Readonly<Record<string, string>> = {},
): readonly CreateImagesTerminalRunHistoryItem[] {
  return history.map((run) => ({
    runId: run.runId,
    workflowRevision: run.workflowRevision,
    scopeLabel: scopeLabel(run, nodeLabels),
    status: terminalStatus(run.status),
    startedAt: run.createdAt,
    finishedAt: run.updatedAt,
    providerLabel: run.providerLabel ?? "Aiden local mock",
    modelLabel: run.modelLabel ?? "Deterministic Phase 3",
    requestCount: run.requestCount,
    completedNodeCount: run.completedNodeCount,
    totalNodeCount: run.totalNodeCount,
    outputCount: run.outputCount,
    costLabel: run.costLabel ?? "$0.00 mock actual",
    ...(run.ambiguityResolution ? { ambiguityAcknowledged: true as const } : {}),
  }));
}

export function createImagesRunAssetOwners(
  run: CreateImagesRunView,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      run.nodes.flatMap((node) => node.outputAssetIds.map((assetId) => [assetId, run.runId])),
    ),
  );
}

function activeUiStatus(status: CreateImagesRunUiStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "paused" ||
    status === "stopping"
  );
}

function addRunTombstones(
  current: readonly string[] | undefined,
  additions: Iterable<string>,
): readonly string[] {
  const ordered = new Set(current ?? []);
  for (const runId of additions) {
    ordered.delete(runId);
    ordered.add(runId);
  }
  return Object.freeze([...ordered].slice(-MAX_RENDERER_RUN_TOMBSTONES));
}

function rendererRunIds(state: CreateImagesRendererRunState): ReadonlySet<string> {
  return new Set([
    ...(state.projection ? [state.projection.runId] : []),
    ...state.history.map((item) => item.runId),
    ...state.recoveries.map((item) => item.runId),
  ]);
}

function withAuthoritativeRunTombstones(
  previous: CreateImagesRendererRunState,
  next: CreateImagesRendererRunState,
): CreateImagesRendererRunState {
  const nextRunIds = rendererRunIds(next);
  const removedRunIds = [...rendererRunIds(previous)].filter((runId) => !nextRunIds.has(runId));
  return {
    ...next,
    runTombstones: addRunTombstones(previous.runTombstones, removedRunIds),
  };
}

function terminalProjection(
  projection: CreateImagesRunUiProjection,
  terminal: CreateImagesTerminalRunView,
): CreateImagesRunUiProjection {
  const status = terminalStatus(terminal.status);
  return {
    ...projection,
    status,
    ...(terminal.ambiguityResolution
      ? { ambiguityAcknowledged: true as const }
      : { ambiguityAcknowledged: undefined }),
    announcement:
      status === "retry"
        ? "Workflow run needs review before any retry."
        : `Workflow run ${status}.`,
  };
}

/**
 * Reconciles self-contained main-owned run snapshots. Sequence gaps are valid
 * because every notification is complete; older snapshots and cross-workflow
 * active runs are ignored. A terminal summary may seal the last full node view
 * after main removes it from the active-run slot.
 */
export function reconcileCreateImagesRunState(
  current: CreateImagesRendererRunState | undefined,
  result: CreateImagesRunListResult,
  workflowId: string,
  nodeLabels: Readonly<Record<string, string>> = {},
): CreateImagesRendererRunState {
  const previous = current ?? EMPTY_RUN_STATE;
  if (result.status === "unavailable" || result.status === "not-found") {
    return {
      ...previous,
      errorMessage:
        result.status === "not-found" ? "This workflow no longer exists." : result.message,
    };
  }
  const recoveries = Object.freeze(
    result.recoveries.filter((recovery) => recovery.workflowId === workflowId),
  );
  const recoveryRunIds = new Set(recoveries.map((recovery) => recovery.runId));
  const incomingHistory = createImagesTerminalHistoryFromViews(
    result.history.filter((run) => !recoveryRunIds.has(run.runId)),
    nodeLabels,
  );
  const history = Object.freeze(
    incomingHistory
      .slice()
      .sort(
        (left, right) =>
          Date.parse(right.finishedAt) - Date.parse(left.finishedAt) ||
          right.runId.localeCompare(left.runId),
      ),
  );
  const finish = (next: CreateImagesRendererRunState) =>
    withAuthoritativeRunTombstones(previous, next);
  const retainedPrevious: CreateImagesRendererRunState =
    previous.projection && recoveryRunIds.has(previous.projection.runId)
      ? {
          history: previous.history,
          recoveries: previous.recoveries,
          runAssetOwners: Object.freeze({}),
          runTombstones: previous.runTombstones,
          errorMessage: previous.errorMessage,
        }
      : previous;
  const retainedProjection = retainedPrevious.projection;
  const retainedProjectionSealed =
    retainedProjection !== undefined &&
    history.some((item) => item.runId === retainedProjection.runId);
  const retainedTerminalProjectionTombstoned =
    retainedProjection !== undefined &&
    !activeUiStatus(retainedProjection.status) &&
    !retainedProjectionSealed;
  const active =
    result.activeRun?.workflowId === workflowId && !recoveryRunIds.has(result.activeRun.runId)
      ? result.activeRun
      : undefined;
  if (active) {
    const nextProjection = createImagesRunProjectionFromView(active);
    const oldProjection = retainedProjection;
    if (history.some((item) => item.runId === active.runId)) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    if (
      oldProjection?.runId === nextProjection.runId &&
      nextProjection.lastSequence < oldProjection.lastSequence
    ) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    if (
      oldProjection &&
      oldProjection.runId !== nextProjection.runId &&
      activeUiStatus(oldProjection.status) &&
      !retainedProjectionSealed
    ) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    if (
      oldProjection?.runId !== nextProjection.runId &&
      !retainedProjectionSealed &&
      !retainedTerminalProjectionTombstoned &&
      retainedPrevious.projectionUpdatedAt &&
      Date.parse(active.updatedAt) < Date.parse(retainedPrevious.projectionUpdatedAt)
    ) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    return finish({
      projection: nextProjection,
      projectionUpdatedAt: active.updatedAt,
      history,
      recoveries,
      runAssetOwners: createImagesRunAssetOwners(active),
      errorMessage: undefined,
    });
  }
  const latestTerminalRun =
    result.latestTerminalRun?.workflowId === workflowId &&
    !recoveryRunIds.has(result.latestTerminalRun.runId)
      ? result.latestTerminalRun
      : undefined;
  if (latestTerminalRun) {
    const nextProjection = createImagesRunProjectionFromView(latestTerminalRun);
    const oldProjection = retainedProjection;
    if (
      oldProjection?.runId === nextProjection.runId &&
      nextProjection.lastSequence < oldProjection.lastSequence
    ) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    if (
      oldProjection &&
      oldProjection.runId !== nextProjection.runId &&
      activeUiStatus(oldProjection.status) &&
      !retainedProjectionSealed
    ) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    if (
      oldProjection?.runId !== nextProjection.runId &&
      !retainedProjectionSealed &&
      !retainedTerminalProjectionTombstoned &&
      retainedPrevious.projectionUpdatedAt &&
      Date.parse(latestTerminalRun.updatedAt) < Date.parse(retainedPrevious.projectionUpdatedAt)
    ) {
      return finish({ ...retainedPrevious, history, recoveries, errorMessage: undefined });
    }
    return finish({
      projection: nextProjection,
      projectionUpdatedAt: latestTerminalRun.updatedAt,
      history,
      recoveries,
      runAssetOwners: createImagesRunAssetOwners(latestTerminalRun),
      errorMessage: undefined,
    });
  }
  const oldProjection = retainedPrevious.projection;
  const terminal = oldProjection
    ? result.history.find((candidate) => candidate.runId === oldProjection.runId)
    : undefined;
  if (!oldProjection || !terminal || recoveryRunIds.has(oldProjection.runId)) {
    return finish({
      history,
      recoveries,
      runAssetOwners: Object.freeze({}),
      errorMessage: undefined,
    });
  }
  return finish({
    projection: terminalProjection(oldProjection, terminal),
    projectionUpdatedAt: terminal.updatedAt,
    history,
    recoveries,
    runAssetOwners: retainedPrevious.runAssetOwners,
    errorMessage: undefined,
  });
}

/**
 * Reconciles a single mutation acknowledgement without inferring anything
 * about authoritative history or recovery retention from that response.
 */
export function reconcileCreateImagesRunMutation(
  current: CreateImagesRendererRunState | undefined,
  run: CreateImagesRunView,
  workflowId: string,
): CreateImagesRendererRunState {
  const previous = current ?? EMPTY_RUN_STATE;
  if (run.workflowId !== workflowId) return previous;

  const nextProjection = createImagesRunProjectionFromView(run);
  const oldProjection = previous.projection;
  const currentSameRun = oldProjection?.runId === nextProjection.runId;
  if (previous.runTombstones?.includes(run.runId)) return previous;
  if (previous.recoveries.some((recovery) => recovery.runId === run.runId)) return previous;
  if (previous.history.some((item) => item.runId === run.runId) && !currentSameRun) {
    return previous;
  }
  if (currentSameRun && nextProjection.lastSequence < oldProjection.lastSequence) {
    return previous;
  }
  if (!currentSameRun) {
    if (oldProjection && activeUiStatus(oldProjection.status)) return previous;
  }

  return {
    ...previous,
    projection: nextProjection,
    projectionUpdatedAt: run.updatedAt,
    runAssetOwners: createImagesRunAssetOwners(run),
    errorMessage: undefined,
  };
}

export interface CreateImagesRunHistoryRequestIdentity {
  runId: string;
  lifecycleGeneration: number;
  requestSequence: number;
}

export interface CreateImagesRunHistoryRequestAuthority {
  mounted: boolean;
  lifecycleGeneration: number;
  selectedRunId?: string;
  requestSequence: number;
}

export interface CreateImagesRunRecoveryRequestIdentity extends CreateImagesRunHistoryRequestIdentity {
  source: "last-known-good" | "current";
  expectedCandidateJournalRevision: number;
}

export interface CreateImagesRunAmbiguityRequestIdentity extends CreateImagesRunHistoryRequestIdentity {
  expectedLastSequence: number;
}

/** Validates ownership of a selected-run async continuation. */
export function isCreateImagesRunHistoryRequestCurrent(
  state: CreateImagesRendererRunState | undefined,
  authority: CreateImagesRunHistoryRequestAuthority,
  request: CreateImagesRunHistoryRequestIdentity,
): boolean {
  return (
    authority.mounted &&
    authority.lifecycleGeneration === request.lifecycleGeneration &&
    authority.requestSequence === request.requestSequence &&
    authority.selectedRunId === request.runId &&
    !state?.runTombstones?.includes(request.runId)
  );
}

/** Validates that an async recovery response still owns the selected candidate. */
export function isCreateImagesRunRecoveryRequestCurrent(
  state: CreateImagesRendererRunState | undefined,
  authority: CreateImagesRunHistoryRequestAuthority,
  request: CreateImagesRunRecoveryRequestIdentity,
): boolean {
  if (!state || !isCreateImagesRunHistoryRequestCurrent(state, authority, request)) return false;
  const recovery = state.recoveries.find((item) => item.runId === request.runId);
  return (
    recovery?.status === "recovery-required" &&
    recovery.recoverySource === request.source &&
    recovery.expectedCandidateJournalRevision === request.expectedCandidateJournalRevision
  );
}

/** Validates that an ambiguity acknowledgement still owns the visible run. */
export function isCreateImagesRunAmbiguityRequestCurrent(
  state: CreateImagesRendererRunState | undefined,
  authority: CreateImagesRunHistoryRequestAuthority,
  request: CreateImagesRunAmbiguityRequestIdentity,
): boolean {
  if (!state || !isCreateImagesRunHistoryRequestCurrent(state, authority, request)) return false;
  if (state.recoveries.some((recovery) => recovery.runId === request.runId)) return false;
  if (state.projection) {
    if (state.projection.runId !== request.runId || state.projection.status !== "retry")
      return false;
    return (
      state.projection.lastSequence === request.expectedLastSequence ||
      (state.projection.ambiguityAcknowledged === true &&
        state.projection.lastSequence >= request.expectedLastSequence)
    );
  }
  return state.history.some((item) => item.runId === request.runId && item.status === "retry");
}

/** Removes only the causally confirmed run while preserving unrelated state. */
export function removeCreateImagesRunRecord(
  current: CreateImagesRendererRunState | undefined,
  runId: string,
): CreateImagesRendererRunState {
  const previous = current ?? EMPTY_RUN_STATE;
  const projectionRemoved = previous.projection?.runId === runId;
  const history = previous.history.some((item) => item.runId === runId)
    ? Object.freeze(previous.history.filter((item) => item.runId !== runId))
    : previous.history;
  const recoveries = previous.recoveries.some((item) => item.runId === runId)
    ? Object.freeze(previous.recoveries.filter((item) => item.runId !== runId))
    : previous.recoveries;
  const hasOwnedAssets = Object.values(previous.runAssetOwners).includes(runId);
  const runAssetOwners = hasOwnedAssets
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(previous.runAssetOwners).filter(([, ownerRunId]) => ownerRunId !== runId),
        ),
      )
    : previous.runAssetOwners;

  return {
    ...previous,
    ...(projectionRemoved ? { projection: undefined, projectionUpdatedAt: undefined } : {}),
    history,
    recoveries,
    runAssetOwners,
    runTombstones: addRunTombstones(previous.runTombstones, [runId]),
  };
}

export function createImagesRunOutputAssetIds(
  state: CreateImagesRendererRunState | undefined,
): readonly string[] {
  return state ? Object.keys(state.runAssetOwners) : [];
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000, 8_000]);
const MAX_PENDING_SUBSCRIPTIONS = 8;

type SubscriptionTimer = unknown;

export interface CreateImagesRunSubscriptionControllerOptions {
  workflowId: string;
  subscribe(request: { workflowId: string }): Promise<CreateImagesRunSubscriptionResult>;
  unsubscribe(request: { subscriptionId: string }): Promise<unknown> | unknown;
  onChanged(handler: (notification: CreateImagesRunChangedNotification) => void): () => void;
  apply(result: CreateImagesRunListResult): void;
  retryDelaysMs?: readonly number[];
  schedule?(callback: () => void, delayMs: number): SubscriptionTimer;
  cancelSchedule?(timer: SubscriptionTimer): void;
}

export interface CreateImagesRunSubscriptionController {
  start(): void;
  retryNow(): void;
  dispose(): void;
}

function boundedRetryAfter(retryAfterMs: number | undefined, fallbackMs: number): number {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) return fallbackMs;
  return Math.max(fallbackMs, Math.min(30_000, Math.max(250, Math.trunc(retryAfterMs))));
}

/**
 * Owns one main-process subscription at a time. Automatic retries are bounded;
 * a later focus/visibility signal can open a fresh bounded retry window.
 */
export function createImagesRunSubscriptionController(
  options: CreateImagesRunSubscriptionControllerOptions,
): CreateImagesRunSubscriptionController {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_SUBSCRIPTION_RETRY_DELAYS_MS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule =
    options.cancelSchedule ??
    ((timer: SubscriptionTimer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const pending = new Map<string, CreateImagesRunChangedNotification>();
  let disposed = false;
  let started = false;
  let inFlight = false;
  let attemptGeneration = 0;
  let failedAttempts = 0;
  let retryTimer: SubscriptionTimer | undefined;
  let subscriptionId: string | undefined;
  let lastStreamSequence = -1;
  let removeNotificationListener: (() => void) | undefined;

  const clearRetry = () => {
    if (retryTimer === undefined) return;
    cancelSchedule(retryTimer);
    retryTimer = undefined;
  };

  const release = (id: string) => {
    void Promise.resolve(options.unsubscribe({ subscriptionId: id })).catch(() => undefined);
  };

  const rememberPending = (notification: CreateImagesRunChangedNotification) => {
    const prior = pending.get(notification.subscriptionId);
    if (prior && prior.streamSequence >= notification.streamSequence) return;
    if (!prior && pending.size >= MAX_PENDING_SUBSCRIPTIONS) {
      const oldestId = pending.keys().next().value as string | undefined;
      if (oldestId) pending.delete(oldestId);
    }
    pending.set(notification.subscriptionId, notification);
  };

  const releaseCurrentForSnapshot = (snapshot: CreateImagesRunListResult) => {
    if (snapshot.status === "ready" || !subscriptionId) return;
    const releasedSubscriptionId = subscriptionId;
    subscriptionId = undefined;
    lastStreamSequence = -1;
    pending.clear();
    release(releasedSubscriptionId);
    if (snapshot.status === "unavailable") {
      failedAttempts += 1;
      scheduleRetry(snapshot.retryAfterMs);
    }
  };

  const onNotification = (notification: CreateImagesRunChangedNotification) => {
    if (disposed) return;
    if (!subscriptionId) {
      rememberPending(notification);
      return;
    }
    if (
      notification.subscriptionId === subscriptionId &&
      notification.streamSequence > lastStreamSequence
    ) {
      lastStreamSequence = notification.streamSequence;
      options.apply(notification.snapshot);
      releaseCurrentForSnapshot(notification.snapshot);
    }
  };

  const scheduleRetry = (retryAfterMs?: number) => {
    if (disposed || retryTimer !== undefined || failedAttempts > retryDelays.length) return;
    const fallbackMs = retryDelays[Math.max(0, failedAttempts - 1)];
    if (fallbackMs === undefined) return;
    retryTimer = schedule(
      () => {
        retryTimer = undefined;
        void attempt();
      },
      boundedRetryAfter(retryAfterMs, fallbackMs),
    );
  };

  const attempt = async () => {
    if (disposed || inFlight || subscriptionId) return;
    inFlight = true;
    const generation = ++attemptGeneration;
    try {
      const result = await options.subscribe({ workflowId: options.workflowId });
      if (disposed || generation !== attemptGeneration) {
        if (result.status === "ready") release(result.subscriptionId);
        return;
      }
      if (result.status !== "ready") {
        failedAttempts += 1;
        options.apply(
          result.status === "not-found"
            ? { status: "not-found" }
            : {
                status: "unavailable",
                message: result.message,
                ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
              },
        );
        if (result.status === "unavailable") scheduleRetry(result.retryAfterMs);
        return;
      }
      subscriptionId = result.subscriptionId;
      lastStreamSequence = result.streamSequence;
      failedAttempts = 0;
      clearRetry();
      options.apply(result.snapshot);
      releaseCurrentForSnapshot(result.snapshot);
      if (!subscriptionId) return;
      const pendingSnapshot = pending.get(result.subscriptionId);
      if (pendingSnapshot && pendingSnapshot.streamSequence > lastStreamSequence) {
        lastStreamSequence = pendingSnapshot.streamSequence;
        options.apply(pendingSnapshot.snapshot);
        releaseCurrentForSnapshot(pendingSnapshot.snapshot);
      }
      pending.clear();
    } catch {
      if (disposed || generation !== attemptGeneration) return;
      failedAttempts += 1;
      options.apply({
        status: "unavailable",
        message: "Run updates are temporarily unavailable.",
      });
      scheduleRetry();
    } finally {
      if (generation === attemptGeneration) inFlight = false;
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      removeNotificationListener = options.onChanged(onNotification);
      void attempt();
    },
    retryNow() {
      if (disposed || subscriptionId || inFlight) return;
      clearRetry();
      failedAttempts = 0;
      void attempt();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      attemptGeneration += 1;
      clearRetry();
      removeNotificationListener?.();
      removeNotificationListener = undefined;
      pending.clear();
      if (subscriptionId) release(subscriptionId);
      subscriptionId = undefined;
    },
  };
}
