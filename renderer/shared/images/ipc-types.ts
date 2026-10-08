// Request and response shapes for the imageWorkflows IPC channels. Electron-free:
// shared by the main-process handlers and the renderer client.
import type { ImageModelOption } from "./port.js";
import type { ImageRunConsentPlan, ImageMediaType, OutputRef, RunScope, RunSnapshot, RunSummary } from "./run-types.js";
import type { ImageWorkflowTemplate } from "./templates.js";
import type { WorkflowDocV1, WorkflowSummary } from "./schema.js";

/** Largest image the import channel accepts, before the store sniffs its content. */
export const IMAGE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/** A graph or planning problem shown beside the node or edge it names. */
export interface GraphIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

export interface ListWorkflowsResponse {
  workflows: WorkflowSummary[];
  /** Distinct images per workflow (run outputs plus Image Input assets), as the delete confirmation names them. */
  imageCounts: Record<string, number>;
}

export interface CreateWorkflowRequest {
  template: ImageWorkflowTemplate;
  title?: string;
}

export interface WorkflowResponse {
  workflow: WorkflowDocV1;
}

export interface GetWorkflowResponse {
  workflow: WorkflowDocV1;
  latestOutputs: Record<string, OutputRef[]>;
  staleNodeIds: string[];
  /** Document-bound display URLs for the assets this response names. */
  assetUrls: Record<string, string>;
}

export interface SaveWorkflowRequest {
  workflowId: string;
  baseRevision: number;
  document: WorkflowDocV1;
}

export type SaveWorkflowResponse =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict" | "invalid" | "not-found"; issues?: string[] };

export type MutateWorkflowRequest =
  | { op: "rename"; workflowId: string; title: string }
  | { op: "duplicate" | "delete"; workflowId: string };

export interface MutateWorkflowResponse {
  ok: boolean;
  workflowId?: string;
}

export interface ListModelsResponse {
  models: ImageModelOption[];
}

export type ImportImageRequest =
  | { source: "dialog" }
  | { source: "bytes"; name: string; mimeType: string; data: Uint8Array };

export type ImportImageResponse =
  | { assetId: string; mimeType: ImageMediaType; width: number; height: number; bytes: number; url: string }
  | { cancelled: true };

export interface PrepareRunRequest {
  workflowId: string;
  revision: number;
  scope: RunScope;
}

export type PrepareRunResponse = { plan: ImageRunConsentPlan } | { issues: GraphIssue[] };

export type StartRunResponse = { runId: string } | { error: "expired" | "stale" | "model-unavailable" };

export type GetRunRequest = { runId: string } | { workflowId: string };

export interface GetRunResponse {
  snapshot: RunSnapshot | null;
  assetUrls: Record<string, string>;
}

export interface ListRunsResponse {
  runs: RunSummary[];
}
