import type {
  CreateImagesAspectRatio,
  CreateImagesImageSize,
  CreateImagesOutputMime,
} from "../../../renderer/shared/create-images/schema.js";

export interface ImageProviderModelCapabilities {
  id: string;
  label: string;
  providerId: string;
  aspectRatios: readonly CreateImagesAspectRatio[];
  imageSizes: readonly CreateImagesImageSize[];
  outputMimes: readonly CreateImagesOutputMime[];
  maxReferenceImages: number;
  maxOutputs: number;
  supportsEditing: boolean;
  supportsCancellation: boolean;
}

export interface ImageGenerationReference {
  assetId: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export interface ValidatedImageGenerationRequest {
  providerId: string;
  modelId: string;
  prompt: string;
  aspectRatio: CreateImagesAspectRatio;
  imageSize: CreateImagesImageSize;
  outputMime: CreateImagesOutputMime;
  count: number;
  references: readonly ImageGenerationReference[];
}

export interface ImageProviderJob {
  providerId: string;
  kind: "synchronous" | "asynchronous";
  remoteId?: string;
}

export interface ImageProviderAdapter<TCredential> {
  readonly providerId: string;
  listModels(): readonly ImageProviderModelCapabilities[];
  validate(request: ValidatedImageGenerationRequest): ValidatedImageGenerationRequest;
  submit(
    credential: TCredential,
    request: ValidatedImageGenerationRequest,
    context: { runId: string; nodeId: string; signal: AbortSignal },
  ): Promise<ImageProviderJob>;
  cancel?(
    credential: TCredential,
    job: ImageProviderJob,
    context: { signal: AbortSignal },
  ): Promise<void>;
}
