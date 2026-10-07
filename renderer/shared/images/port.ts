// The provider-agnostic image generation contract (ADR-CI §2.1). Types only and
// Electron-free: the scheduler and executor depend on this, never on a provider.
import type { Usage } from "@earendil-works/pi-ai";

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
