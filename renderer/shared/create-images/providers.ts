import type {
  CreateImagesAspectRatio,
  CreateImagesImageSize,
  CreateImagesOutputMime,
  GenerateImageNodeV1,
} from "./schema";

export const CREATE_IMAGES_PROVIDER_STATUS_VERSION = 1 as const;
export const CREATE_IMAGES_GEMINI_PROVIDER_ID = "gemini" as const;

export type CreateImagesExecutionMode = "local-mock" | typeof CREATE_IMAGES_GEMINI_PROVIDER_ID;

export type CreateImagesProviderConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "invalid"
  | "unavailable";

export type CreateImagesCapabilityState = "current" | "stale" | "unknown";

export type CreateImagesProviderSafeErrorCode =
  | "credential-missing"
  | "credential-invalid"
  | "credential-scope-unverified"
  | "capability-check-failed"
  | "provider-unreachable"
  | "rate-limited"
  | "feature-unavailable";

export interface CreateImagesProviderModelCapability {
  id: string;
  label: string;
  aspectRatios: readonly CreateImagesAspectRatio[];
  imageSizes: readonly CreateImagesImageSize[];
  outputMimes: readonly CreateImagesOutputMime[];
  maxReferenceImages: number;
  maxOutputs: number;
  supportsEditing: boolean;
  supportsCancellation: boolean;
}

export interface CreateImagesProviderCapabilitySnapshot {
  catalogId: string;
  verifiedAt: string;
  state: CreateImagesCapabilityState;
  models: readonly CreateImagesProviderModelCapability[];
}

/**
 * Renderer-safe connection DTO. It intentionally contains no key, credential
 * value, endpoint, absolute path, request body, prompt, or reference image.
 */
export interface CreateImagesProviderStatus {
  schemaVersion: typeof CREATE_IMAGES_PROVIDER_STATUS_VERSION;
  providerId: typeof CREATE_IMAGES_GEMINI_PROVIDER_ID;
  displayName: "Google Gemini";
  connectionState: CreateImagesProviderConnectionState;
  credentialKind?: "google-api-key";
  capabilitySnapshot?: CreateImagesProviderCapabilitySnapshot;
  safeErrorCode?: CreateImagesProviderSafeErrorCode;
  retryAfterMs?: number;
}

const COMMON_GEMINI_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const satisfies readonly CreateImagesAspectRatio[];

/** Release-pinned renderer catalog matching the Phase 0 Gemini contract. */
export const CREATE_IMAGES_GEMINI_RELEASE_CATALOG: CreateImagesProviderCapabilitySnapshot =
  Object.freeze({
    catalogId: "gemini-interactions-2026-08-11",
    verifiedAt: "2026-08-11T00:00:00.000Z",
    state: "current",
    models: Object.freeze([
      Object.freeze({
        id: "gemini-3.1-flash-lite-image",
        label: "Nano Banana 2 Lite",
        aspectRatios: COMMON_GEMINI_ASPECT_RATIOS,
        imageSizes: ["1K"] as const,
        outputMimes: ["image/png", "image/jpeg"] as const,
        maxReferenceImages: 14,
        maxOutputs: 1,
        supportsEditing: true,
        supportsCancellation: false,
      }),
      Object.freeze({
        id: "gemini-3.1-flash-image",
        label: "Nano Banana 2",
        aspectRatios: COMMON_GEMINI_ASPECT_RATIOS,
        imageSizes: ["1K", "2K", "4K"] as const,
        outputMimes: ["image/png", "image/jpeg"] as const,
        maxReferenceImages: 14,
        maxOutputs: 1,
        supportsEditing: true,
        supportsCancellation: false,
      }),
      Object.freeze({
        id: "gemini-3-pro-image",
        label: "Nano Banana Pro",
        aspectRatios: COMMON_GEMINI_ASPECT_RATIOS,
        imageSizes: ["1K", "2K", "4K"] as const,
        outputMimes: ["image/png", "image/jpeg"] as const,
        maxReferenceImages: 14,
        maxOutputs: 1,
        supportsEditing: true,
        supportsCancellation: false,
      }),
    ]),
  });

export type CreateImagesProviderBindingIssue =
  | "connection-not-ready"
  | "capabilities-unavailable"
  | "capabilities-stale"
  | "model-unselected"
  | "model-not-curated"
  | "model-no-longer-available"
  | "aspect-ratio-no-longer-supported"
  | "image-size-no-longer-supported"
  | "output-format-no-longer-supported"
  | "output-count-no-longer-supported";

export type CreateImagesProviderBindingResult =
  | { status: "ready"; model: CreateImagesProviderModelCapability }
  | { status: "blocked"; issue: CreateImagesProviderBindingIssue };

function releaseModel(
  modelId: string | undefined,
): CreateImagesProviderModelCapability | undefined {
  return CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models.find((model) => model.id === modelId);
}

/**
 * Capability drift is fail-closed: a connected provider must return a current
 * main-owned snapshot and every selected option must still be present.
 */
export function evaluateCreateImagesProviderBinding(
  node: GenerateImageNodeV1,
  provider: CreateImagesProviderStatus,
): CreateImagesProviderBindingResult {
  if (!node.data.modelId) return { status: "blocked", issue: "model-unselected" };
  if (!releaseModel(node.data.modelId)) {
    return { status: "blocked", issue: "model-not-curated" };
  }
  if (provider.connectionState !== "connected") {
    return { status: "blocked", issue: "connection-not-ready" };
  }
  const snapshot = provider.capabilitySnapshot;
  if (!snapshot) return { status: "blocked", issue: "capabilities-unavailable" };
  if (snapshot.state !== "current") {
    return { status: "blocked", issue: "capabilities-stale" };
  }
  const model = snapshot.models.find((candidate) => candidate.id === node.data.modelId);
  if (!model) return { status: "blocked", issue: "model-no-longer-available" };
  if (!model.aspectRatios.includes(node.data.aspectRatio)) {
    return { status: "blocked", issue: "aspect-ratio-no-longer-supported" };
  }
  if (!model.imageSizes.includes(node.data.imageSize)) {
    return { status: "blocked", issue: "image-size-no-longer-supported" };
  }
  if (!model.outputMimes.includes(node.data.outputMime)) {
    return { status: "blocked", issue: "output-format-no-longer-supported" };
  }
  if (node.data.count > model.maxOutputs) {
    return { status: "blocked", issue: "output-count-no-longer-supported" };
  }
  return { status: "ready", model };
}

export function createImagesCuratedGeminiModels(
  provider: CreateImagesProviderStatus,
): readonly CreateImagesProviderModelCapability[] {
  const snapshot = provider.capabilitySnapshot;
  if (provider.connectionState !== "connected" || snapshot?.state !== "current") {
    return CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models;
  }
  const availableIds = new Set(snapshot.models.map((model) => model.id));
  return CREATE_IMAGES_GEMINI_RELEASE_CATALOG.models.filter((model) => availableIds.has(model.id));
}

export function createImagesProviderModelLabel(modelId: string | undefined): string {
  if (!modelId) return "Choose a supported model";
  return releaseModel(modelId)?.label ?? "Unsupported model";
}

export function disconnectedCreateImagesProviderStatus(): CreateImagesProviderStatus {
  return {
    schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
    providerId: CREATE_IMAGES_GEMINI_PROVIDER_ID,
    displayName: "Google Gemini",
    connectionState: "disconnected",
    safeErrorCode: "credential-missing",
  };
}
