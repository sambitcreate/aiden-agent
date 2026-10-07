// Create Images workflow document, schema v1. Types and limits only: the strict
// parser lives in main (main/services/create-images/workflow-schema.ts), so the
// renderer bundle carries no validation code it never runs.

export const IMAGE_WORKFLOW_SCHEMA_VERSION = 1 as const;

export const IMAGE_WORKFLOW_LIMITS = Object.freeze({
  maxNodes: 500,
  maxEdges: 2_000,
  /** Matches the chat `generate_image` prompt bound. */
  maxPromptBytes: 16 * 1024,
  maxTitleLength: 120,
  maxLabelLength: 120,
  maxDocumentBytes: 2 * 1024 * 1024,
  positionLimit: 1_000_000,
  minZoom: 0.1,
  maxZoom: 4,
  minNodeSize: 120,
  maxNodeSize: 1_600,
  minConcurrency: 1,
  maxConcurrency: 4,
  defaultConcurrency: 2,
  /** Pi's reference-image bound for one image request. */
  maxReferences: 4,
  /** Owner cap for CI-1 (ADR-CI §3). Raise only with CI-3 batching. */
  maxRequestsPerRun: 4,
  maxProviderIdLength: 128,
  maxModelIdLength: 256,
} as const);

export const IMAGE_NODE_TYPES = ["prompt", "image-input", "generate-image", "output"] as const;
export type ImageNodeType = (typeof IMAGE_NODE_TYPES)[number];

/** Workflow, node and edge IDs. `crypto.randomUUID()` values match. */
export const IMAGE_WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/** Image Input assets are studio asset store content addresses (sha256 hex). */
export const IMAGE_ASSET_ID_PATTERN = /^[0-9a-f]{64}$/u;

export interface WorkflowPosition {
  x: number;
  y: number;
}

export interface WorkflowNodeDimensions {
  width: number;
  height: number;
}

export interface WorkflowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ImageModelRef {
  provider: string;
  id: string;
}

interface WorkflowNodeBase<TType extends ImageNodeType, TData> {
  id: string;
  type: TType;
  position: WorkflowPosition;
  title?: string;
  dimensions?: WorkflowNodeDimensions;
  data: TData;
}

export type PromptNode = WorkflowNodeBase<"prompt", { text: string }>;
export type ImageInputNode = WorkflowNodeBase<"image-input", { assetId?: string; label?: string }>;
/** CI-1 owner cap: one provider request per Generate node. Widen `count` when batching lands. */
export type GenerateImageNode = WorkflowNodeBase<"generate-image", { model?: ImageModelRef; count: 1 }>;
export type OutputNode = WorkflowNodeBase<"output", { label?: string }>;
export type WorkflowNode = PromptNode | ImageInputNode | GenerateImageNode | OutputNode;

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export interface WorkflowDocV1 {
  schemaVersion: typeof IMAGE_WORKFLOW_SCHEMA_VERSION;
  id: string;
  title: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  viewport?: WorkflowViewport;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: { concurrency: number };
}

export interface WorkflowSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: number;
}

/** Owner decision Q1: Nano Banana 2 through OpenRouter when the user has it configured. */
export const DEFAULT_IMAGE_MODEL: Readonly<ImageModelRef> = Object.freeze({
  provider: "openrouter",
  id: "google/gemini-3.1-flash-image",
});
