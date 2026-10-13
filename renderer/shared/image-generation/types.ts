// Shared, renderer-safe contract for Settings → Image Generation and the
// main-process image registry. No Node or Electron imports.

import type { FalAspectRatioSupport, ImageAspectRatio } from "./aspect-ratio.js";

export const IMAGE_GENERATION_PROVIDER_IDS = ["openrouter", "replicate", "fal"] as const;
export type ImageGenerationProviderId = (typeof IMAGE_GENERATION_PROVIDER_IDS)[number];

export const IMAGE_GENERATION_PROVIDER_NAMES: Readonly<Record<ImageGenerationProviderId, string>> = {
  openrouter: "OpenRouter",
  replicate: "Replicate",
  fal: "fal",
};

export function isImageGenerationProviderId(value: unknown): value is ImageGenerationProviderId {
  return typeof value === "string" && (IMAGE_GENERATION_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Replicate input fields that carry reference images, with how many each holds. */
export const REPLICATE_REFERENCE_FIELDS = {
  image_input: "array",
  images: "array",
  input_images: "array",
  image: "single",
  input_image: "single",
  subject_reference: "single",
} as const satisfies Record<string, "array" | "single">;
export type ReplicateReferenceField = keyof typeof REPLICATE_REFERENCE_FIELDS;
export type ReplicateReferenceMode = "array" | "single";
export const REPLICATE_REFERENCE_MODES: readonly ReplicateReferenceMode[] = ["array", "single"];

export const FAL_REFERENCE_FIELDS = ["image_urls", "image_url"] as const;
export type FalReferenceField = (typeof FAL_REFERENCE_FIELDS)[number];

/** Upper bound on reference images any adapter sends in one request. */
export const MAX_IMAGE_REFERENCES = 14;

/**
 * Per-provider request metadata. Replicate models are addressed as
 * `owner/name`; a fal logical model maps to a text endpoint and an optional
 * edit endpoint that is used when reference images are present.
 */
export type ImageModelAdapter =
  | {
      kind: "openrouter";
      /** The model can also return text alongside images. */
      textOutput?: boolean;
    }
  | {
      kind: "replicate";
      referenceField?: ReplicateReferenceField;
      /**
       * Whether `referenceField` takes a list or one image, when the model
       * differs from the field name's usual shape (`REPLICATE_REFERENCE_FIELDS`).
       */
      referenceMode?: ReplicateReferenceMode;
      maxReferences?: number;
      /** Extra fixed inputs sent with every prediction. */
      input?: Readonly<Record<string, string | number | boolean>>;
      /**
       * A pinned model version (from a fetched collection). Community models
       * can only be run through `POST /v1/predictions` with a version.
       */
      version?: string;
      /**
       * Ratios the model accepts on its `aspect_ratio` input. Absent means the
       * model has no known `aspect_ratio` input and the field is never sent.
       */
      aspectRatios?: readonly ImageAspectRatio[];
    }
  | {
      kind: "fal";
      textEndpoint: string;
      editEndpoint?: string;
      referenceField?: FalReferenceField;
      maxReferences?: number;
      /** How the model takes a requested shape; absent means it is never sent. */
      aspectRatio?: FalAspectRatioSupport;
    };

/** How a Replicate model's reference field takes images: its own mode, else the field's usual one. */
export function replicateReferenceMode(
  adapter: Extract<ImageModelAdapter, { kind: "replicate" }>,
): ReplicateReferenceMode | undefined {
  if (!adapter.referenceField) return undefined;
  return adapter.referenceMode ?? REPLICATE_REFERENCE_FIELDS[adapter.referenceField];
}

/** One curated, fetched or custom image model. */
export interface ImageCatalogEntry {
  provider: ImageGenerationProviderId;
  id: string;
  name: string;
  /** Logo slug for ImageModelLogo (see `inferImageModelMaker`). */
  maker?: string;
  acceptsReferenceImages: boolean;
  adapter: ImageModelAdapter;
}

export type ImageModelOrigin = "curated" | "fetched" | "custom";

export interface ImageModelRef {
  provider: ImageGenerationProviderId;
  id: string;
}

export interface ImageGenerationKeyStatus {
  connected: boolean;
  source: "stored" | "env" | null;
}

export interface ImageGenerationProviderView {
  id: ImageGenerationProviderId;
  name: string;
  key: ImageGenerationKeyStatus;
  /** Epoch ms of the last successful Fetch latest models, or null. */
  fetchedAt: number | null;
  fetchedCount: number;
  /** Replicate's catalog needs a key; OpenRouter and fal do not. */
  fetchRequiresKey: boolean;
}

export interface ImageGenerationModelView {
  provider: ImageGenerationProviderId;
  id: string;
  name: string;
  maker?: string;
  acceptsReferenceImages: boolean;
  enabled: boolean;
  origin: ImageModelOrigin;
}

export interface ImageGenerationState {
  providers: ImageGenerationProviderView[];
  models: ImageGenerationModelView[];
  /** The stored default, kept even while it is disabled or its key is missing. */
  defaultModel: ImageModelRef | null;
}

/**
 * What chat and Create Images need to know without reading credentials:
 * whether any image model can run, and the one to preselect. `name` is safe
 * for a system prompt (the curated name, otherwise the model id).
 */
export interface ImageGenerationSnapshot {
  available: boolean;
  defaultModel?: { provider: ImageGenerationProviderId; id: string; name: string };
}

// ---- IPC requests (renderer → main) ----

export interface ImageGenerationSetKeyRequest {
  provider: ImageGenerationProviderId;
  key: string;
}

export interface ImageGenerationProviderRequest {
  provider: ImageGenerationProviderId;
}

export interface ImageGenerationSetModelEnabledRequest {
  provider: ImageGenerationProviderId;
  id: string;
  enabled: boolean;
}

/** Several enable choices applied in one write (Settings' bulk actions). */
export interface ImageGenerationSetModelsEnabledRequest {
  changes: ImageGenerationSetModelEnabledRequest[];
}

/** `null` clears the default. */
export type ImageGenerationSetDefaultModelRequest = ImageModelRef | null;

export interface ImageGenerationAddCustomModelRequest {
  provider: ImageGenerationProviderId;
  /** OpenRouter model id, Replicate `owner/name`, or fal text endpoint id. */
  id: string;
  name?: string;
  /** OpenRouter only: the model takes reference images as input. */
  acceptsReferenceImages?: boolean;
  /** Replicate or fal: the input field that carries reference images. */
  referenceField?: string;
  /** fal only: endpoint used when reference images are present. */
  editEndpoint?: string;
}

export type ImageGenerationRemoveCustomModelRequest = ImageModelRef;

// ---- IPC results (main → renderer) ----

export type ImageGenerationErrorCode =
  | "invalid_request"
  | "invalid_key"
  | "key_required"
  | "unknown_model"
  | "network_error"
  | "rejected_key"
  | "invalid_catalog"
  | "storage_error";

export type ImageGenerationActionResult =
  | { ok: true; state: ImageGenerationState }
  | { ok: false; code: ImageGenerationErrorCode; message: string };

export const IMAGE_GENERATION_LIMITS = {
  minKeyLength: 8,
  maxKeyLength: 512,
  maxModelIdLength: 200,
  maxModelNameLength: 120,
  maxCustomModelsPerProvider: 50,
  maxFetchedModelsPerProvider: 500,
  /** Most enable choices one bulk request may carry. */
  maxBulkModelChanges: 2000,
} as const;
