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
  textOutput: boolean;
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

export interface ImageGenerationPort {
  listModels(signal?: AbortSignal): Promise<readonly ImageModelOption[]>;
  /** Resolves provider outcomes as results; it never throws them. */
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

/** Owner decision Q1: prefer Nano Banana 2, else the first configured model. */
export function pickDefaultImageModel(
  models: readonly ImageModelOption[],
  preferred: ImageModelRef = DEFAULT_IMAGE_MODEL,
): ImageModelRef | undefined {
  const match = models.find((option) => option.provider === preferred.provider && option.model === preferred.id) ?? models[0];
  return match ? { provider: match.provider, id: match.model } : undefined;
}
