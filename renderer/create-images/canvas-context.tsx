import * as React from "react";
import type { CreateImagesAssetGrantView } from "../shared/create-images/ipc";
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
  beginNodeEdit(nodeId: string): void;
  updateNodeDraft(nodeId: string, update: (node: WorkflowNodeV1) => WorkflowNodeV1): void;
  commitNodeEdit(nodeId: string): void;
  selectNode(nodeId: string): void;
  chooseImage(nodeId: string): void;
  removeImage(nodeId: string): void;
  imageChoicePending(nodeId: string): boolean;
  retainAssetPreview(assetId: string): () => void;
  assetPreview(assetId: string): CreateImagesAssetGrantView | undefined;
  assetPreviewStatus(assetId: string): AssetPreviewLifecycleStatus | undefined;
  assetPreviewMissing(assetId: string): boolean;
  assetPreviewLoaded(assetId: string, token: string): void;
  assetPreviewFailed(assetId: string, token: string): void;
  nodeRunState(nodeId: string): CreateImagesNodeRunUiState | undefined;
  retainRunAssetPreview(assetId: string): () => void;
  runAssetPreview(assetId: string): CreateImagesAssetGrantView | undefined;
  runAssetPreviewLoaded(assetId: string, token: string): void;
  runAssetPreviewFailed(assetId: string, token: string): void;
}

export const CreateImagesCanvasActionsContext = React.createContext<CreateImagesCanvasActions>({
  providerStatus: disconnectedCreateImagesProviderStatus(),
  executionMode: "local-mock",
  updateNode: () => undefined,
  beginNodeEdit: () => undefined,
  updateNodeDraft: () => undefined,
  commitNodeEdit: () => undefined,
  selectNode: () => undefined,
  chooseImage: () => undefined,
  removeImage: () => undefined,
  imageChoicePending: () => false,
  retainAssetPreview: () => () => undefined,
  assetPreview: () => undefined,
  assetPreviewStatus: () => undefined,
  assetPreviewMissing: () => false,
  assetPreviewLoaded: () => undefined,
  assetPreviewFailed: () => undefined,
  nodeRunState: () => undefined,
  retainRunAssetPreview: () => () => undefined,
  runAssetPreview: () => undefined,
  runAssetPreviewLoaded: () => undefined,
  runAssetPreviewFailed: () => undefined,
});

export function useCreateImagesCanvasActions(): CreateImagesCanvasActions {
  return React.useContext(CreateImagesCanvasActionsContext);
}
