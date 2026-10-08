// Run-history types for Create Images. Electron-free: shared by the main-process
// ledger, the IPC layer and the renderer.

/** Media types a generated or imported image may have. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

/** A reference to one stored image in the studio asset store. */
export interface OutputRef {
  assetId: string;
  width: number;
  height: number;
  mediaType: ImageMediaType;
}

/** Which part of a workflow a run covers: all of it, a node and what follows it, or a node alone. */
export type RunScope =
  | { kind: "all" }
  | { kind: "from-node"; nodeId: string }
  | { kind: "node-only"; nodeId: string };

/** Lifecycle of a whole run. */
export type RunState = "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";

/** Lifecycle of one node attempt within a run. */
export type AttemptState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "interrupted";

/** Whether the provider reported a cost for an attempt. */
export type AttemptCostStatus = "reported" | "unavailable";

/** One run, without its attempts. */
export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  scope: RunScope;
  state: RunState;
  requestLimit: number;
  requestsSent: number;
  createdAt: number;
  finishedAt?: number;
  endReason?: string;
}

/** One node attempt within a run, including whether a paid request may have left. */
export interface AttemptSnapshot {
  nodeId: string;
  variant: number;
  state: AttemptState;
  provider?: string;
  model?: string;
  submittedAt?: number;
  finishedAt?: number;
  errorCode?: string;
  errorMessage?: string;
  cancelRequested: boolean;
  truncated: boolean;
  costUsd?: number;
  costStatus?: AttemptCostStatus;
  output: OutputRef[];
  mayHaveBeenBilled: boolean;
}

/** A run with its attempts and a monotonic version for change detection. */
export interface RunSnapshot {
  version: number;
  run: RunSummary;
  attempts: AttemptSnapshot[];
}

/** One provider request the user is asked to approve. */
export interface ImageRunConsentRequest {
  nodeId: string;
  variant: number;
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  referenceCount: number;
  referenceBytes: number;
  pendingReferenceCount: number;
}

/** The exact set of requests a consent sheet shows before a run may start. */
export interface ImageRunConsentPlan {
  consentId: string;
  workflowId: string;
  workflowRevision: number;
  scope: RunScope;
  requests: ImageRunConsentRequest[];
  totalRequests: number;
  estimate: { kind: "unknown" };
  createdAt: number;
  expiresAt: number;
}
