// The provider-agnostic image generation contract (ADR-CI §2.1). Electron-free:
// the scheduler and executor depend on this, never on a provider.
import type { Usage } from "@earendil-works/pi-ai";
import { DEFAULT_IMAGE_MODEL, type ImageModelRef } from "./schema.js";

export interface ImageModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  acceptsReferences: boolean;
  /**
   * Most reference images one request to this model may carry: the model's own
   * per-request limit (e.g. 1 for single-image editors), never above Aiden's 4.
   * Present only when `acceptsReferences` is true.
   */
  maxReferences?: number;
  textOutput: boolean;
  /** The default image model chosen in Settings → Image Generation. */
  isDefault?: boolean;
  /** Maker slug for the model's logo (e.g. "google"); absent when unknown. */
  maker?: string;
}

export interface ImageGenerationRequest {
  provider: string;
  model: string;
  prompt: string;
  references: readonly { mimeType: string; bytes: Uint8Array }[];
  signal: AbortSignal;
}

export type ImageGenerationFailureCode =
  | "aborted"
  | "unknown-model"
  | "references-unsupported"
  | "provider-error"
  | "output-invalid";

export interface GeneratedImage {
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export type ImageGenerationResult =
  | {
      kind: "images";
      images: GeneratedImage[];
      /** True when the provider returned more images than the port keeps. */
      truncated: boolean;
      text?: string;
      usage?: Usage;
      responseId?: string;
    }
  | { kind: "failed"; code: ImageGenerationFailureCode; message: string; usage?: Usage };

/**
 * The local half of a request: model lookup and reference checks, with nothing sent.
 * A refusal here never reached a provider, so it can never have been billed.
 */
export type ImageGenerationPreflight =
  | {
      kind: "ready";
      /** Sends the checked request. Once called, the request may leave the machine. */
      send(): Promise<ImageGenerationResult>;
    }
  | { kind: "failed"; code: ImageGenerationFailureCode; message: string };

export interface ImageGenerationPort {
  /** A registry that cannot load lists no models; only the caller's abort rejects. */
  listModels(signal?: AbortSignal): Promise<readonly ImageModelOption[]>;
  /** Every local check that cannot involve the network. Sends nothing. */
  preflight(request: ImageGenerationRequest): Promise<ImageGenerationPreflight>;
  /** preflight then send. Resolves provider outcomes as results; it never throws them. */
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

/**
 * The model name a consent sheet shows. A catalog-fetched name is provider-supplied,
 * so the model id is added whenever it differs from the display name.
 */
export function imageModelConsentLabel(option: Pick<ImageModelOption, "label" | "model">): string {
  return option.label === option.model ? option.model : `${option.label} (${option.model})`;
}

/**
 * The model a new Generate Image node starts with: the Settings → Image
 * Generation default, else Nano Banana 2 (owner decision Q1), else the first
 * configured model.
 */
export function pickDefaultImageModel(
  models: readonly ImageModelOption[],
  preferred: ImageModelRef = DEFAULT_IMAGE_MODEL,
): ImageModelRef | undefined {
  const match =
    models.find((option) => option.isDefault) ??
    models.find((option) => option.provider === preferred.provider && option.model === preferred.id) ??
    models[0];
  return match ? { provider: match.provider, id: match.model } : undefined;
}
