import type { WorkflowRunScope } from "./execution";
import type { CreateImagesNodeRunStatus, CreateImagesRunStatus } from "./run-contract";
import type { WorkflowDocumentV1 } from "./schema";
import type { CreateImagesWorkflowTemplateId } from "./templates";
import type { CreateImagesNodeBananaImportReport } from "./node-banana-import";
import {
  CREATE_IMAGES_MAX_WORKFLOW_BYTES,
  createImagesWorkflowSerializedBytes,
  parseWorkflowDocument,
} from "./schema";

export const CREATE_IMAGES_MAX_IPC_DOCUMENT_BYTES = CREATE_IMAGES_MAX_WORKFLOW_BYTES;
export const CREATE_IMAGES_MAX_TITLE_LENGTH = 120;
export const CREATE_IMAGES_ASSET_PROTOCOL = "aiden-asset:" as const;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u;
const GRANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const RETENTION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const CONSENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export interface CreateImagesWorkflowSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  assetCount: number;
  missingAssetCount: number;
  health: "healthy" | "recovery-required" | "unsafe";
}

export type CreateImagesWorkflowRecoveryView =
  | { status: "missing"; workflowId: string }
  | {
      status: "healthy";
      workflowId: string;
      revision: number;
      lastKnownGoodAvailable: boolean;
      autosave: "none" | "pending";
      autosaveTargetRevision?: number;
    }
  | {
      status: "recovery-required";
      workflowId: string;
      reason:
        | "current-corrupt"
        | "current-missing"
        | "last-known-good-corrupt"
        | "journal-corrupt"
        | "journal-pending"
        | "journal-conflict";
      currentRevision?: number;
      lastKnownGoodAvailable: boolean;
      lastKnownGoodRevision?: number;
      autosave: "none" | "pending" | "corrupt";
      autosaveTargetRevision?: number;
    }
  | {
      status: "unsafe";
      workflowId: string;
      reason: "current-future-schema" | "last-known-good-future-schema" | "journal-future-schema";
      lastKnownGoodAvailable: boolean;
      autosave: "none" | "pending" | "unsafe";
    };

export type CreateImagesWorkflowListResult =
  | {
      status: "ready";
      workflows: CreateImagesWorkflowSummary[];
      recoveries: CreateImagesWorkflowRecoveryView[];
    }
  | { status: "unavailable"; message: string };

export type CreateImagesWorkflowLoadResult =
  | {
      status: "ready";
      workflow: WorkflowDocumentV1;
      missingAssetIds: string[];
    }
  | { status: "recovery-required"; recovery: CreateImagesWorkflowRecoveryView }
  | {
      status: "unsafe";
      recovery: CreateImagesWorkflowRecoveryView;
      message: string;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

export type CreateImagesWorkflowMutationResult =
  | { status: "saved"; workflow: WorkflowDocumentV1 }
  | { status: "deleted" }
  | {
      status: "conflict";
      expectedRevision: number;
      currentRevision: number;
      current: WorkflowDocumentV1;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

export interface CreateImagesExportArchiveRequest {
  workflowId: string;
  expectedRevision: number;
}

export type CreateImagesExportArchiveResult =
  | { status: "canceled" }
  | {
      status: "exported";
      workflowId: string;
      revision: number;
      fileName: string;
      assetCount: number;
    }
  | { status: "conflict"; currentRevision?: number }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

export type CreateImagesImportArchiveResult =
  | { status: "canceled" }
  | {
      status: "imported";
      workflow: WorkflowDocumentV1;
      sourceFileName: string;
      importedAssetCount: number;
    }
  | { status: "unavailable"; message: string };

export type CreateImagesImportNodeBananaResult =
  | { status: "canceled" }
  | {
      status: "imported";
      workflow: WorkflowDocumentV1;
      sourceFileName: string;
      importedAssetCount: number;
      report: CreateImagesNodeBananaImportReport;
    }
  | { status: "unavailable"; message: string };

export type CreateImagesWorkspaceStatus =
  | { status: "unconfigured" }
  | {
      status: "ready";
      displayName: string;
      importedAssetCount: number;
      generatedAssetCount: number;
      conflictCount: number;
      lastSyncedAt?: string;
    }
  | {
      status: "unavailable";
      reason: "missing" | "permission-denied" | "changed" | "unsafe" | "sync-failed";
      displayName?: string;
      message: string;
    };

export type CreateImagesChooseWorkspaceResult =
  | { status: "canceled" }
  | { status: "ready"; workspace: Extract<CreateImagesWorkspaceStatus, { status: "ready" }> }
  | { status: "unavailable"; message: string };

export type CreateImagesOpenWorkspaceResult =
  | { status: "opened" }
  | { status: "unconfigured" }
  | { status: "unavailable"; message: string };

export type CreateImagesSyncWorkspaceResult =
  | { status: "synced"; workspace: Extract<CreateImagesWorkspaceStatus, { status: "ready" }> }
  | { status: "unconfigured" }
  | { status: "unavailable"; message: string };

export interface CreateImagesAssetView {
  assetId: string;
  mediaType: "image/jpeg" | "image/png";
  byteLength: number;
  width: number;
  height: number;
  importedAt: string;
  originalName?: string;
}

export interface CreateImagesAssetGrantView {
  token: string;
  url: string;
  expiresAt: number;
  asset: CreateImagesAssetView;
}

export type CreateImagesAssetPickResult =
  | { status: "canceled" }
  | { status: "imported"; grant: CreateImagesAssetGrantView }
  | { status: "unavailable"; message: string };

export interface CreateImagesPasteImageRequest {
  workflowId: string;
}

export type CreateImagesPasteImageResult =
  | { status: "no-image" }
  | { status: "imported"; grant: CreateImagesAssetGrantView }
  | { status: "unavailable"; message: string };

export const CREATE_IMAGES_MAX_DROPPED_FILES = 24;

export type CreateImagesDroppedAssetImportItem =
  | { status: "imported"; grant: CreateImagesAssetGrantView }
  | { status: "unavailable"; fileName: string; message: string };

export type CreateImagesDroppedAssetImportResult =
  | { status: "completed"; items: CreateImagesDroppedAssetImportItem[] }
  | { status: "unavailable"; message: string };

export type CreateImagesAssetGrantResult =
  | { status: "ready"; grant: CreateImagesAssetGrantView }
  | { status: "not-found" | "forbidden" }
  | { status: "unavailable"; message: string };

export interface CreateImagesDownloadRunAssetRequest {
  workflowId: string;
  runId: string;
  assetId: string;
}

export type CreateImagesDownloadRunAssetResult =
  | { status: "canceled" }
  | { status: "saved"; fileName: string }
  | { status: "not-found" | "forbidden" }
  | { status: "unavailable"; message: string };

export interface CreateImagesStorageHealthView {
  workflowCount: number;
  assetCount: number;
  assetBytes: number;
  recoverableWorkflowCount: number;
  orphanAssetCount: number;
  missingAssetCount: number;
  runIndex: {
    status: "healthy" | "recovered" | "needs-attention" | "unsafe";
    entryCount?: number;
    quarantinedIndexCount?: number;
    degradedRecordCount: number;
    degradedRecordsTruncated: boolean;
    degradedRecords: CreateImagesDegradedRunRecordView[];
  };
}

export type CreateImagesAssetCleanupPlanResult =
  | { status: "empty" }
  | {
      status: "ready";
      planId: string;
      candidateCount: number;
      reclaimableBytes: number;
      expiresAt: number;
    }
  | { status: "unavailable"; message: string };

export interface CreateImagesApplyAssetCleanupRequest {
  planId: string;
  confirmed: true;
}

export type CreateImagesAssetCleanupResult =
  | {
      status: "cleaned";
      deletedCount: number;
      reclaimedBytes: number;
      skippedCount: number;
    }
  | { status: "stale" }
  | { status: "unavailable"; message: string };

export interface CreateImagesRunNodeView {
  nodeId: string;
  label: string;
  status: CreateImagesNodeRunStatus;
  attempt: number;
  outputAssetIds: string[];
  errorCode?: string;
  retrySafety?: "confirmed-not-submitted" | "same-idempotency-key";
}

export interface CreateImagesRunAmbiguityResolutionView {
  kind: "acknowledged-unresolved-submission";
  acknowledgedAt: string;
  acknowledgedAtJournalRevision: number;
}

export interface CreateImagesRunView {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  journalRevision: number;
  status: CreateImagesRunStatus;
  lastSequence: number;
  scope: WorkflowRunScope;
  createdAt: string;
  updatedAt: string;
  executionMode?: "local-mock" | "gemini";
  ambiguityResolution?: CreateImagesRunAmbiguityResolutionView;
  nodes: CreateImagesRunNodeView[];
}

export interface CreateImagesTerminalRunView {
  runId: string;
  workflowRevision: number;
  status: "succeeded" | "failed" | "cancelled" | "interrupted" | "needs_attention";
  scope: WorkflowRunScope;
  createdAt: string;
  updatedAt: string;
  executionMode?: "local-mock" | "gemini";
  providerLabel?: string;
  modelLabel?: string;
  costLabel?: string;
  ambiguityResolution?: CreateImagesRunAmbiguityResolutionView;
  requestCount: number;
  outputCount: number;
  completedNodeCount: number;
  totalNodeCount: number;
}

export interface CreateImagesRunRecoveryRequiredView {
  status: "recovery-required";
  workflowId: string;
  runId: string;
  reason:
    | "current-corrupt"
    | "current-missing"
    | "last-known-good-corrupt"
    | "last-known-good-missing"
    | "last-known-good-mismatch"
    | "pending-corrupt"
    | "pending-conflict";
  currentJournalRevision?: number;
  lastKnownGoodJournalRevision?: number;
  recoverySource?: "last-known-good" | "current";
  expectedCandidateJournalRevision?: number;
}

export interface CreateImagesRunUnsafeRecoveryView {
  status: "unsafe";
  workflowId: string;
  runId: string;
  reason:
    | "current-future-schema"
    | "last-known-good-future-schema"
    | "pending-future-schema"
    | "unsafe-storage";
}

export type CreateImagesRunRecoveryView =
  | CreateImagesRunRecoveryRequiredView
  | CreateImagesRunUnsafeRecoveryView;

export type CreateImagesRunListResult =
  | {
      status: "ready";
      authoritative: true;
      activeRun?: CreateImagesRunView;
      latestTerminalRun?: CreateImagesRunView;
      history: CreateImagesTerminalRunView[];
      recoveries: CreateImagesRunRecoveryView[];
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string; retryAfterMs?: number };

export type CreateImagesRunDetailResult =
  | { status: "ready"; run: CreateImagesRunView }
  | {
      status: "recovery-required";
      recovery: CreateImagesRunRecoveryRequiredView;
    }
  | {
      status: "unsafe";
      recovery: CreateImagesRunUnsafeRecoveryView;
      message: string;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string };

export type CreateImagesRunRecoveryMutationResult =
  | { status: "recovered"; run: CreateImagesRunView }
  | {
      status: "conflict";
      source: "last-known-good" | "current";
      expectedCandidateJournalRevision: number;
      currentCandidateJournalRevision?: number;
    }
  | {
      status: "recovery-required";
      recovery: CreateImagesRunRecoveryRequiredView;
    }
  | {
      status: "unsafe";
      recovery: CreateImagesRunUnsafeRecoveryView;
      message: string;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string; retryAfterMs?: number };

export type CreateImagesRunAmbiguityResolutionResult =
  | {
      status: "resolved" | "already-resolved";
      run: CreateImagesRunView;
      authoritativeList: Extract<CreateImagesRunListResult, { status: "ready" }>;
    }
  | {
      status: "conflict";
      expectedJournalRevision: number;
      currentJournalRevision: number;
    }
  | { status: "not-ambiguous" }
  | { status: "not-found" }
  | { status: "unavailable"; message: string; retryAfterMs?: number };

export type CreateImagesRunMutationResult =
  | { status: "started" | "stopping"; run: CreateImagesRunView }
  | { status: "already-running"; run: CreateImagesRunView }
  | { status: "conflict"; expectedRevision: number; currentRevision: number }
  | { status: "invalid" | "not-found" | "unavailable"; message: string };

export interface CreateImagesProviderConsentAccountingView {
  initialRequestCount: number;
  expectedOutputCount: number;
  maximumAttempts: number;
  promptBytes: number;
  referenceImageCount: number;
  referenceImageBytes: number;
  initialProviderInputBytes: number;
  dataLeavesDevice: true;
  retryPolicy: "manual-new-consent";
}

export interface CreateImagesProviderConsentPlanView {
  version: 1;
  authorizationId: string;
  workflowId: string;
  workflowRevision: number;
  executionMode: "gemini";
  providerId: "gemini";
  providerLabel: "Google Gemini";
  modelId: string;
  modelLabel: string;
  accounting: CreateImagesProviderConsentAccountingView;
  estimate: {
    kind: "best-effort" | "unavailable";
    amountMicros?: number;
    currency?: string;
    estimatedAt: string;
    sourceFingerprint: string;
  };
  createdAt: string;
  expiresAt: string;
  consentFingerprint: string;
  token: string;
}

export type CreateImagesPrepareRunResult =
  | { status: "ready"; plan: CreateImagesProviderConsentPlanView }
  | { status: "conflict"; expectedRevision: number; currentRevision: number }
  | { status: "invalid" | "not-found" | "unavailable"; message: string };

export type CreateImagesRunHistoryPrunePlanResult =
  | {
      status: "ready";
      scope: "all-workflows";
      mayReleaseUniqueOutputs: true;
      authorizationToken: string;
      keepLatest: number;
      candidateRunCount: number;
      releasedAssetCount: number;
    }
  | { status: "nothing-to-prune" }
  | { status: "unavailable"; message: string; retryAfterMs?: number };

export type CreateImagesRunHistoryPruneResult =
  | {
      status: "pruned";
      removedRunCount: number;
      releasedAssetCount: number;
    }
  | { status: "nothing-to-prune" }
  | { status: "conflict"; message: string }
  | { status: "unavailable"; message: string; retryAfterMs?: number };

export type CreateImagesDegradedRunReason =
  | CreateImagesRunRecoveryRequiredView["reason"]
  | CreateImagesRunUnsafeRecoveryView["reason"];

export interface CreateImagesDegradedRunRecordView {
  runId: string;
  association: "workflow" | "unassociated";
  workflowId?: string;
  status: "recovery-required" | "unsafe";
  reason: CreateImagesDegradedRunReason;
  discardEligible: boolean;
}

export type CreateImagesDegradedRunDiscardPlanResult =
  | {
      status: "ready";
      runId: string;
      reason: CreateImagesDegradedRunReason;
      association: "workflow" | "unassociated";
      workflowId?: string;
      expectedCurrentJournalRevision?: number;
      expectedLastKnownGoodJournalRevision?: number;
      authorizationToken: string;
      mayLoseOutputs: true;
      mayDuplicateProviderWork: true;
    }
  | { status: "not-found" }
  | { status: "not-degraded" }
  | { status: "recoverable" }
  | { status: "unavailable"; message: string };

export type CreateImagesDegradedRunDiscardResult =
  | {
      status: "discarded";
      runId: string;
      releasedAssetCount: number;
      authoritativeList?: CreateImagesRunListResult;
    }
  | { status: "conflict" }
  | { status: "not-found" }
  | { status: "not-degraded" }
  | { status: "recoverable" }
  | { status: "unavailable"; message: string };

export type CreateImagesRunSubscriptionResult =
  | {
      status: "ready";
      subscriptionId: string;
      streamSequence: number;
      snapshot: CreateImagesRunListResult;
    }
  | { status: "not-found" }
  | { status: "unavailable"; message: string; retryAfterMs?: number };

export interface CreateImagesRunChangedNotification {
  subscriptionId: string;
  streamSequence: number;
  snapshot: CreateImagesRunListResult;
}

export interface CreateImagesGetWorkflowRequest {
  workflowId: string;
}

export interface CreateImagesCreateWorkflowRequest {
  template: CreateImagesWorkflowTemplateId;
  title?: string;
}

export interface CreateImagesSaveWorkflowRequest {
  expectedRevision: number;
  workflow: WorkflowDocumentV1;
}

export interface CreateImagesRenameWorkflowRequest {
  workflowId: string;
  expectedRevision: number;
  title: string;
}

export interface CreateImagesDuplicateWorkflowRequest {
  workflowId: string;
  expectedRevision: number;
  title?: string;
}

export interface CreateImagesDeleteWorkflowRequest {
  workflowId: string;
  expectedRevision: number;
}

export interface CreateImagesPickAssetRequest {
  workflowId: string;
}

export interface CreateImagesDroppedAssetImportRequest {
  workflowId: string;
  /** Main-process-only paths resolved by Electron's trusted preload bridge. */
  filePaths: string[];
}

export interface CreateImagesGrantAssetRequest {
  workflowId: string;
  assetId: string;
}

export interface CreateImagesRevokeAssetGrantRequest {
  token: string;
}

export interface CreateImagesRecoverWorkflowRequest {
  workflowId: string;
  source: "last-known-good" | "autosave";
  expectedCandidateRevision: number;
}

export interface CreateImagesRepairWorkflowRequest {
  workflowId: string;
  expectedRevision: number;
}

export interface CreateImagesDiscardAutosaveRequest {
  workflowId: string;
  expectedTargetRevision: number;
}

export interface CreateImagesStartRunRequest {
  workflowId: string;
  expectedRevision: number;
  scope: WorkflowRunScope;
  consent:
    | { executionMode: "local-mock"; reviewed: true }
    | {
        executionMode: "gemini";
        version: 1;
        authorizationId: string;
        consentFingerprint: string;
        token: string;
        reviewed: true;
      };
}

export interface CreateImagesPrepareRunRequest {
  workflowId: string;
  expectedRevision: number;
  scope: WorkflowRunScope;
  executionMode: "gemini";
}

export interface CreateImagesStopRunRequest {
  workflowId: string;
  runId: string;
}

export interface CreateImagesListRunsRequest {
  workflowId: string;
}

export interface CreateImagesSubscribeRunsRequest {
  workflowId: string;
}

export interface CreateImagesUnsubscribeRunsRequest {
  subscriptionId: string;
}

export interface CreateImagesGrantRunAssetRequest {
  workflowId: string;
  runId: string;
  assetId: string;
}

export interface CreateImagesGetRunRequest {
  workflowId: string;
  runId: string;
}

export interface CreateImagesRecoverRunRequest {
  workflowId: string;
  runId: string;
  source: "last-known-good" | "current";
  expectedCandidateJournalRevision: number;
}

export interface CreateImagesResolveRunAmbiguityRequest {
  workflowId: string;
  runId: string;
  expectedJournalRevision: number;
  resolution: "acknowledge-unresolved-submission";
}

export interface CreateImagesPlanRunHistoryPruneRequest {
  keepLatest: number;
}

export interface CreateImagesPruneRunHistoryRequest {
  keepLatest: number;
  authorizationToken: string;
  confirmed: true;
}

export interface CreateImagesPlanDegradedRunDiscardRequest {
  runId: string;
}

export interface CreateImagesDiscardDegradedRunRequest {
  runId: string;
  expectedCurrentJournalRevision?: number;
  expectedLastKnownGoodJournalRevision?: number;
  authorizationToken: string;
  confirmed: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function opaqueId(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value) ? value : undefined;
}

function title(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > CREATE_IMAGES_MAX_TITLE_LENGTH) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function revision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function runScope(value: unknown): WorkflowRunScope | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "all" && exactKeys(value, ["kind"])) return { kind: "all" };
  if (value.kind !== "from-node" || !exactKeys(value, ["kind", "nodeId"], ["downstreamPath"])) {
    return undefined;
  }
  const nodeId = opaqueId(value.nodeId);
  if (!nodeId) return undefined;
  if (value.downstreamPath === undefined) return { kind: "from-node", nodeId };
  if (!Array.isArray(value.downstreamPath) || value.downstreamPath.length > 500) return undefined;
  const downstreamPath = value.downstreamPath.map(opaqueId);
  if (
    downstreamPath.some((node): node is undefined => node === undefined) ||
    new Set(downstreamPath).size !== downstreamPath.length
  ) {
    return undefined;
  }
  return {
    kind: "from-node",
    nodeId,
    downstreamPath: downstreamPath as string[],
  };
}

function invalidRequest(): never {
  throw new Error("Invalid Create Images request.");
}

export function parseCreateImagesGetWorkflowRequest(
  value: unknown,
): CreateImagesGetWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId"])) invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  if (!workflowId) invalidRequest();
  return { workflowId };
}

export function parseCreateImagesCreateWorkflowRequest(
  value: unknown,
): CreateImagesCreateWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["template"], ["title"])) invalidRequest();
  if (
    value.template !== "blank" &&
    value.template !== "starter" &&
    value.template !== "reference-edit" &&
    value.template !== "variant-set"
  ) {
    invalidRequest();
  }
  const parsedTitle = value.title === undefined ? undefined : title(value.title);
  if (value.title !== undefined && !parsedTitle) invalidRequest();
  return {
    template: value.template,
    ...(parsedTitle ? { title: parsedTitle } : {}),
  };
}

export function parseCreateImagesSaveWorkflowRequest(
  value: unknown,
): CreateImagesSaveWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["expectedRevision", "workflow"])) invalidRequest();
  const expectedRevision = revision(value.expectedRevision);
  if (!expectedRevision) invalidRequest();
  const serializedBytes = createImagesWorkflowSerializedBytes(value.workflow);
  if (serializedBytes === undefined) invalidRequest();
  if (serializedBytes! > CREATE_IMAGES_MAX_IPC_DOCUMENT_BYTES) invalidRequest();
  const parsed = parseWorkflowDocument(value.workflow);
  if (!parsed.success || parsed.value.revision !== expectedRevision + 1) invalidRequest();
  return { expectedRevision, workflow: parsed.value };
}

export function parseCreateImagesRenameWorkflowRequest(
  value: unknown,
): CreateImagesRenameWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "expectedRevision", "title"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  const parsedTitle = title(value.title);
  if (!workflowId || !expectedRevision || !parsedTitle) invalidRequest();
  return { workflowId, expectedRevision, title: parsedTitle };
}

export function parseCreateImagesDuplicateWorkflowRequest(
  value: unknown,
): CreateImagesDuplicateWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "expectedRevision"], ["title"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  const parsedTitle = value.title === undefined ? undefined : title(value.title);
  if (!workflowId || !expectedRevision || (value.title !== undefined && !parsedTitle)) {
    invalidRequest();
  }
  return {
    workflowId,
    expectedRevision,
    ...(parsedTitle ? { title: parsedTitle } : {}),
  };
}

export function parseCreateImagesDeleteWorkflowRequest(
  value: unknown,
): CreateImagesDeleteWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "expectedRevision"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  if (!workflowId || !expectedRevision) invalidRequest();
  return { workflowId, expectedRevision };
}

export function parseCreateImagesExportArchiveRequest(
  value: unknown,
): CreateImagesExportArchiveRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "expectedRevision"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  if (!workflowId || !expectedRevision) invalidRequest();
  return { workflowId, expectedRevision };
}

export function parseCreateImagesImportArchiveRequest(value: unknown): Record<string, never> {
  if (!isRecord(value) || !exactKeys(value, [])) invalidRequest();
  return {};
}

export function parseCreateImagesImportNodeBananaRequest(value: unknown): Record<string, never> {
  if (!isRecord(value) || !exactKeys(value, [])) invalidRequest();
  return {};
}

export function parseCreateImagesWorkspaceRequest(value: unknown): Record<string, never> {
  if (!isRecord(value) || !exactKeys(value, [])) invalidRequest();
  return {};
}

export function parseCreateImagesPlanAssetCleanupRequest(value: unknown): Record<string, never> {
  if (!isRecord(value) || !exactKeys(value, [])) invalidRequest();
  return {};
}

export function parseCreateImagesApplyAssetCleanupRequest(
  value: unknown,
): CreateImagesApplyAssetCleanupRequest {
  if (!isRecord(value) || !exactKeys(value, ["planId", "confirmed"])) invalidRequest();
  const planId =
    typeof value.planId === "string" && GRANT_TOKEN_PATTERN.test(value.planId)
      ? value.planId
      : undefined;
  if (!planId || value.confirmed !== true) invalidRequest();
  return { planId, confirmed: true };
}

export function parseCreateImagesPickAssetRequest(value: unknown): CreateImagesPickAssetRequest {
  return parseCreateImagesGetWorkflowRequest(value);
}

export function parseCreateImagesPasteImageRequest(value: unknown): CreateImagesPasteImageRequest {
  return parseCreateImagesGetWorkflowRequest(value);
}

export function parseCreateImagesDroppedAssetImportRequest(
  value: unknown,
): CreateImagesDroppedAssetImportRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "filePaths"])) invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  if (
    !workflowId ||
    !Array.isArray(value.filePaths) ||
    value.filePaths.length < 1 ||
    value.filePaths.length > CREATE_IMAGES_MAX_DROPPED_FILES ||
    !value.filePaths.every(
      (filePath) =>
        typeof filePath === "string" &&
        filePath.length >= 1 &&
        filePath.length <= 4_096 &&
        !filePath.includes("\0"),
    )
  ) {
    invalidRequest();
  }
  return { workflowId, filePaths: [...value.filePaths] };
}

export function parseCreateImagesGrantAssetRequest(value: unknown): CreateImagesGrantAssetRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "assetId"])) invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  const assetId =
    typeof value.assetId === "string" && ASSET_ID_PATTERN.test(value.assetId)
      ? value.assetId
      : undefined;
  if (!workflowId || !assetId) invalidRequest();
  return { workflowId, assetId };
}

export function parseCreateImagesDownloadRunAssetRequest(
  value: unknown,
): CreateImagesDownloadRunAssetRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "runId", "assetId"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const runId = opaqueId(value.runId);
  const assetId =
    typeof value.assetId === "string" && ASSET_ID_PATTERN.test(value.assetId)
      ? value.assetId
      : undefined;
  if (!workflowId || !runId || !assetId) invalidRequest();
  return { workflowId, runId, assetId };
}

export function parseCreateImagesRevokeAssetGrantRequest(
  value: unknown,
): CreateImagesRevokeAssetGrantRequest {
  if (!isRecord(value) || !exactKeys(value, ["token"])) invalidRequest();
  const token =
    typeof value.token === "string" && GRANT_TOKEN_PATTERN.test(value.token)
      ? value.token
      : undefined;
  if (!token) invalidRequest();
  return { token };
}

export function parseCreateImagesRecoverWorkflowRequest(
  value: unknown,
): CreateImagesRecoverWorkflowRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["workflowId", "source", "expectedCandidateRevision"])
  ) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedCandidateRevision = revision(value.expectedCandidateRevision);
  if (
    !workflowId ||
    !expectedCandidateRevision ||
    (value.source !== "last-known-good" && value.source !== "autosave")
  ) {
    invalidRequest();
  }
  return { workflowId, source: value.source, expectedCandidateRevision };
}

export function parseCreateImagesRepairWorkflowRequest(
  value: unknown,
): CreateImagesRepairWorkflowRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "expectedRevision"])) invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  if (!workflowId || !expectedRevision) invalidRequest();
  return { workflowId, expectedRevision };
}

export function parseCreateImagesDiscardAutosaveRequest(
  value: unknown,
): CreateImagesDiscardAutosaveRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "expectedTargetRevision"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedTargetRevision = revision(value.expectedTargetRevision);
  if (!workflowId || !expectedTargetRevision) invalidRequest();
  return { workflowId, expectedTargetRevision };
}

export function parseCreateImagesStartRunRequest(value: unknown): CreateImagesStartRunRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["workflowId", "expectedRevision", "scope", "consent"]) ||
    !isRecord(value.consent)
  ) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  const scope = runScope(value.scope);
  if (!workflowId || !expectedRevision || !scope) invalidRequest();
  if (value.consent.executionMode === "local-mock") {
    if (
      !exactKeys(value.consent, ["executionMode", "reviewed"]) ||
      value.consent.reviewed !== true
    ) {
      invalidRequest();
    }
    return {
      workflowId,
      expectedRevision,
      scope,
      consent: { executionMode: "local-mock", reviewed: true },
    };
  }
  const authorizationId = opaqueId(value.consent.authorizationId);
  if (
    value.consent.executionMode !== "gemini" ||
    !exactKeys(value.consent, [
      "executionMode",
      "version",
      "authorizationId",
      "consentFingerprint",
      "token",
      "reviewed",
    ]) ||
    value.consent.version !== 1 ||
    !authorizationId ||
    typeof value.consent.consentFingerprint !== "string" ||
    !CONSENT_FINGERPRINT_PATTERN.test(value.consent.consentFingerprint) ||
    typeof value.consent.token !== "string" ||
    !CONSENT_FINGERPRINT_PATTERN.test(value.consent.token) ||
    value.consent.reviewed !== true
  )
    invalidRequest();
  return {
    workflowId,
    expectedRevision,
    scope,
    consent: {
      executionMode: "gemini",
      version: 1,
      authorizationId,
      consentFingerprint: value.consent.consentFingerprint,
      token: value.consent.token,
      reviewed: true,
    },
  };
}

export function parseCreateImagesPrepareRunRequest(value: unknown): CreateImagesPrepareRunRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["workflowId", "expectedRevision", "scope", "executionMode"])
  )
    invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  const expectedRevision = revision(value.expectedRevision);
  const scope = runScope(value.scope);
  if (!workflowId || !expectedRevision || !scope || value.executionMode !== "gemini") {
    invalidRequest();
  }
  return { workflowId, expectedRevision, scope, executionMode: "gemini" };
}

export function parseCreateImagesStopRunRequest(value: unknown): CreateImagesStopRunRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "runId"])) invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  const runId = opaqueId(value.runId);
  if (!workflowId || !runId) invalidRequest();
  return { workflowId, runId };
}

export function parseCreateImagesGetRunRequest(value: unknown): CreateImagesGetRunRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "runId"])) invalidRequest();
  const workflowId = opaqueId(value.workflowId);
  const runId = opaqueId(value.runId);
  if (!workflowId || !runId) invalidRequest();
  return { workflowId, runId };
}

export function parseCreateImagesRecoverRunRequest(value: unknown): CreateImagesRecoverRunRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["workflowId", "runId", "source", "expectedCandidateJournalRevision"])
  ) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const runId = opaqueId(value.runId);
  const source =
    value.source === "last-known-good" || value.source === "current" ? value.source : undefined;
  const expectedCandidateJournalRevision = revision(value.expectedCandidateJournalRevision);
  if (!workflowId || !runId || !source || !expectedCandidateJournalRevision) invalidRequest();
  return { workflowId, runId, source, expectedCandidateJournalRevision };
}

export function parseCreateImagesResolveRunAmbiguityRequest(
  value: unknown,
): CreateImagesResolveRunAmbiguityRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["workflowId", "runId", "expectedJournalRevision", "resolution"])
  ) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const runId = opaqueId(value.runId);
  const expectedJournalRevision = revision(value.expectedJournalRevision);
  if (
    !workflowId ||
    !runId ||
    !expectedJournalRevision ||
    value.resolution !== "acknowledge-unresolved-submission"
  ) {
    invalidRequest();
  }
  return {
    workflowId,
    runId,
    expectedJournalRevision,
    resolution: "acknowledge-unresolved-submission",
  };
}

function retentionKeepLatest(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 900
    ? value
    : undefined;
}

export function parseCreateImagesPlanRunHistoryPruneRequest(
  value: unknown,
): CreateImagesPlanRunHistoryPruneRequest {
  if (!isRecord(value) || !exactKeys(value, ["keepLatest"])) invalidRequest();
  const keepLatest = retentionKeepLatest(value.keepLatest);
  if (!keepLatest) invalidRequest();
  return { keepLatest };
}

export function parseCreateImagesPruneRunHistoryRequest(
  value: unknown,
): CreateImagesPruneRunHistoryRequest {
  if (!isRecord(value) || !exactKeys(value, ["keepLatest", "authorizationToken", "confirmed"])) {
    invalidRequest();
  }
  const keepLatest = retentionKeepLatest(value.keepLatest);
  const authorizationToken =
    typeof value.authorizationToken === "string" &&
    RETENTION_TOKEN_PATTERN.test(value.authorizationToken)
      ? value.authorizationToken
      : undefined;
  if (!keepLatest || !authorizationToken || value.confirmed !== true) invalidRequest();
  return { keepLatest, authorizationToken, confirmed: true };
}

export function parseCreateImagesPlanDegradedRunDiscardRequest(
  value: unknown,
): CreateImagesPlanDegradedRunDiscardRequest {
  if (!isRecord(value) || !exactKeys(value, ["runId"])) invalidRequest();
  const runId = opaqueId(value.runId);
  if (!runId) invalidRequest();
  return { runId };
}

export function parseCreateImagesDiscardDegradedRunRequest(
  value: unknown,
): CreateImagesDiscardDegradedRunRequest {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ["runId", "authorizationToken", "confirmed"],
      ["expectedCurrentJournalRevision", "expectedLastKnownGoodJournalRevision"],
    )
  ) {
    invalidRequest();
  }
  const runId = opaqueId(value.runId);
  const expectedCurrentJournalRevision =
    value.expectedCurrentJournalRevision === undefined
      ? undefined
      : revision(value.expectedCurrentJournalRevision);
  const expectedLastKnownGoodJournalRevision =
    value.expectedLastKnownGoodJournalRevision === undefined
      ? undefined
      : revision(value.expectedLastKnownGoodJournalRevision);
  const authorizationToken =
    typeof value.authorizationToken === "string" &&
    RETENTION_TOKEN_PATTERN.test(value.authorizationToken)
      ? value.authorizationToken
      : undefined;
  if (
    !runId ||
    (value.expectedCurrentJournalRevision !== undefined &&
      expectedCurrentJournalRevision === undefined) ||
    (value.expectedLastKnownGoodJournalRevision !== undefined &&
      expectedLastKnownGoodJournalRevision === undefined) ||
    !authorizationToken ||
    value.confirmed !== true
  ) {
    invalidRequest();
  }
  return {
    runId,
    ...(expectedCurrentJournalRevision === undefined ? {} : { expectedCurrentJournalRevision }),
    ...(expectedLastKnownGoodJournalRevision === undefined
      ? {}
      : { expectedLastKnownGoodJournalRevision }),
    authorizationToken,
    confirmed: true,
  };
}

export function parseCreateImagesListRunsRequest(value: unknown): CreateImagesListRunsRequest {
  return parseCreateImagesGetWorkflowRequest(value);
}

export function parseCreateImagesSubscribeRunsRequest(
  value: unknown,
): CreateImagesSubscribeRunsRequest {
  return parseCreateImagesGetWorkflowRequest(value);
}

export function parseCreateImagesUnsubscribeRunsRequest(
  value: unknown,
): CreateImagesUnsubscribeRunsRequest {
  if (!isRecord(value) || !exactKeys(value, ["subscriptionId"])) invalidRequest();
  const subscriptionId =
    typeof value.subscriptionId === "string" && SUBSCRIPTION_ID_PATTERN.test(value.subscriptionId)
      ? value.subscriptionId
      : undefined;
  if (!subscriptionId) invalidRequest();
  return { subscriptionId };
}

export function parseCreateImagesGrantRunAssetRequest(
  value: unknown,
): CreateImagesGrantRunAssetRequest {
  if (!isRecord(value) || !exactKeys(value, ["workflowId", "runId", "assetId"])) {
    invalidRequest();
  }
  const workflowId = opaqueId(value.workflowId);
  const runId = opaqueId(value.runId);
  const assetId =
    typeof value.assetId === "string" && ASSET_ID_PATTERN.test(value.assetId)
      ? value.assetId
      : undefined;
  if (!workflowId || !runId || !assetId) invalidRequest();
  return { workflowId, runId, assetId };
}

export function createImagesAssetGrantUrl(token: string): string {
  if (!GRANT_TOKEN_PATTERN.test(token)) throw new Error("Invalid Create Images asset grant.");
  return `${CREATE_IMAGES_ASSET_PROTOCOL}//asset/${token}`;
}
