import * as React from "react";
import type {
  CreateImagesAssetGrantView,
  CreateImagesRecentOutputView,
} from "../shared/create-images/ipc";
import type {
  CreateImagesExecutionMode,
  CreateImagesProviderStatus,
} from "../shared/create-images/providers";
import { disconnectedCreateImagesProviderStatus } from "../shared/create-images/providers";
import type { WorkflowNodeV1 } from "../shared/create-images/schema";
import type { CreateImagesNodeRunUiState } from "./run-ui-core";
import type { AssetPreviewLifecycleStatus } from "./asset-preview-lifecycle-core";

export interface CreateImagesCanvasActions {
  providerStatus: CreateImagesProviderStatus;
  executionMode: CreateImagesExecutionMode;
  updateNode(nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1): void;
  beginNodeEdit(nodeId: string, deferPublication?: boolean): void;
  updateNodeDraft(nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1): void;
  commitNodeEdit(nodeId: string): void;
  selectNode(nodeId: string): void;
  nodeLayoutLocked(nodeId: string): boolean;
  chooseImage(nodeId: string): void;
  fitImageToMedia(nodeId: string): void;
  removeImage(nodeId: string): void;
  removePromptVariable(nodeId: string, variableId: string): void;
  imageChoicePending(nodeId: string): boolean;
  retainAssetPreview(assetId: string): () => void;
  assetPreview(assetId: string): CreateImagesAssetGrantView | undefined;
  assetPreviewStatus(assetId: string): AssetPreviewLifecycleStatus | undefined;
  assetPreviewMissing(assetId: string): boolean;
  assetPreviewLoaded(assetId: string, token: string): void;
  assetPreviewFailed(assetId: string, token: string): void;
  nodeRunState(nodeId: string): CreateImagesNodeRunUiState | undefined;
  inputRunAssetIds(nodeId: string, portId: string): readonly string[];
  inputImageAuthority(
    nodeId: string,
    portId: string,
  ): { source: "workflow" | "run"; assetIds: readonly string[] } | undefined;
  retainRunAssetPreview(assetId: string): () => void;
  runAssetPreview(assetId: string): CreateImagesAssetGrantView | undefined;
  runAssetPreviewLoaded(assetId: string, token: string): void;
  runAssetPreviewFailed(assetId: string, token: string): void;
  recentNodeOutputs(nodeId: string): readonly CreateImagesRecentOutputView[];
  retainRecentAssetPreview(assetId: string): () => void;
  recentAssetPreview(assetId: string): CreateImagesAssetGrantView | undefined;
  recentAssetPreviewLoaded(assetId: string, token: string): void;
  recentAssetPreviewFailed(assetId: string, token: string): void;
  inspectAsset(
    assetId: string,
    source: "workflow" | "run" | "recent",
    label: string,
    trigger: HTMLButtonElement,
    runId?: string,
  ): void;
  saveAsset(assetId: string, source: "workflow" | "run"): void;
  exportRunAssetsZip(assetIds: readonly string[]): void;
  runAssetHidden(assetId: string): boolean;
  setRunAssetHidden(assetId: string, hidden: boolean): void;
  extractRunAssets(sourceNodeId: string, assetIds: readonly string[]): void;
}

export const CreateImagesCanvasActionsContext = React.createContext<CreateImagesCanvasActions>({
  providerStatus: disconnectedCreateImagesProviderStatus(),
  executionMode: "local-mock",
  updateNode: () => undefined,
  beginNodeEdit: () => undefined,
  updateNodeDraft: () => undefined,
  commitNodeEdit: () => undefined,
  selectNode: () => undefined,
  nodeLayoutLocked: () => false,
  chooseImage: () => undefined,
  fitImageToMedia: () => undefined,
  removeImage: () => undefined,
  removePromptVariable: () => undefined,
  imageChoicePending: () => false,
  retainAssetPreview: () => () => undefined,
  assetPreview: () => undefined,
  assetPreviewStatus: () => undefined,
  assetPreviewMissing: () => false,
  assetPreviewLoaded: () => undefined,
  assetPreviewFailed: () => undefined,
  nodeRunState: () => undefined,
  inputRunAssetIds: () => [],
  inputImageAuthority: () => undefined,
  retainRunAssetPreview: () => () => undefined,
  runAssetPreview: () => undefined,
  runAssetPreviewLoaded: () => undefined,
  runAssetPreviewFailed: () => undefined,
  recentNodeOutputs: () => [],
  retainRecentAssetPreview: () => () => undefined,
  recentAssetPreview: () => undefined,
  recentAssetPreviewLoaded: () => undefined,
  recentAssetPreviewFailed: () => undefined,
  inspectAsset: () => undefined,
  saveAsset: () => undefined,
  exportRunAssetsZip: () => undefined,
  runAssetHidden: () => false,
  setRunAssetHidden: () => undefined,
  extractRunAssets: () => undefined,
});

export function useCreateImagesCanvasActions(): CreateImagesCanvasActions {
  return React.useContext(CreateImagesCanvasActionsContext);
}
