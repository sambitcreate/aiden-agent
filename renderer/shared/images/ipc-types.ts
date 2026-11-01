// Request and response shapes for the imageWorkflows IPC channels. Electron-free:
// shared by the main-process handlers and the renderer client.
import type { ImageModelOption } from "./port.js";
import type { ImageRunConsentPlan, ImageMediaType, OutputRef, RunScope, RunSnapshot, RunState, RunSummary } from "./run-types.js";
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
  /** Why a delete was refused: a run is in progress, or the workflow is already gone. */
  reason?: "busy" | "not-found";
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

export type StartRunResponse = { runId: string } | { error: "expired" | "stale" | "model-unavailable" | "too-many-runs" };

export type GetRunRequest = { runId: string } | { workflowId: string };

export interface GetRunResponse {
  snapshot: RunSnapshot | null;
  assetUrls: Record<string, string>;
}

export interface ListRunsResponse {
  runs: RunSummary[];
}

/** Most images one gallery response lists; run retention keeps the real total well below this. */
export const GALLERY_MAX_ITEMS = 2_000;

/** Most images one Save All asks to copy into a folder. */
export const SAVE_ALL_MAX_IMAGES = 200;

/** The gallery of generated images: one workflow's, or every workflow's when `workflowId` is absent. */
export interface GalleryRequest {
  workflowId?: string;
}

/** One generated image with what made it. Newest first in a response. */
export interface GalleryItem extends OutputRef {
  runId: string;
  /** How the run that made this image ended (or "running"). */
  runState: RunState;
  workflowId: string;
  /** The workflow's current title; absent if the workflow no longer exists. */
  workflowTitle?: string;
  nodeId: string;
  /** The Generate node's current title; absent if the node no longer exists. */
  nodeTitle?: string;
  variant: number;
  /** Position among the images this request returned. */
  index: number;
  provider: string;
  model: string;
  /** The prompt text sent with the request, as recorded when the run started. */
  prompt?: string;
  /** When the request finished. */
  createdAt: number;
  /** Whether Aiden's auto-saved copy of this image is on disk. */
  saved: boolean;
  /** Document-bound thumbnail URL (512 px). */
  thumbUrl: string;
}

export interface GalleryResponse {
  items: GalleryItem[];
  /** Where auto-saved images go, for display only (for example "Pictures › Aiden › Create Images"). */
  saveFolderLabel: string;
}

/**
 * Actions on generated or imported images. Every op names images by asset id only; file
 * paths and dialogs stay in the main process.
 * - view: a document-bound URL for the full-size original.
 * - save-as: a Save dialog for one image (opens in Downloads).
 * - save-all: a folder picker (opens in Downloads), then copies of up to SAVE_ALL_MAX_IMAGES images.
 * - reveal-saved: shows what a save-as or save-all just wrote, named by the `savedId` it returned.
 * - copy: the image onto the system clipboard.
 * - reveal: shows the auto-saved copy in the file manager, saving it first if it is missing.
 * - reveal-folder: opens the auto-save folder.
 * - drag: starts a native drag of the image file out of the window.
 */
export type ImageActionRequest =
  | { op: "view" | "save-as" | "copy" | "reveal" | "drag"; assetId: string }
  | { op: "save-all"; assetIds: string[] }
  | { op: "reveal-saved"; savedId: string }
  | { op: "reveal-folder" };

export type ImageActionResponse =
  | { ok: true; url?: string; count?: number; savedId?: string }
  | { ok: false; reason: "cancelled" | "not-found" | "unsupported" | "failed"; message?: string };
