import type {
  ImageProviderModelCapabilities,
  ValidatedImageGenerationRequest,
} from "../provider-contract.js";

export const GEMINI_INTERACTIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const COMMON_ASPECT_RATIOS = [
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
] as const;

/**
 * Release-pinned image catalog verified against Google's Interactions API on
 * 2026-08-11. Runtime execution accepts no arbitrary renderer model ID.
 */
export const GEMINI_IMAGE_MODELS: readonly ImageProviderModelCapabilities[] = [
  {
    id: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite",
    providerId: "gemini",
    aspectRatios: COMMON_ASPECT_RATIOS,
    imageSizes: ["1K"],
    outputMimes: ["image/png", "image/jpeg"],
    maxReferenceImages: 14,
    maxOutputs: 1,
    supportsEditing: true,
    supportsCancellation: false,
  },
  {
    id: "gemini-3.1-flash-image",
    label: "Nano Banana 2",
    providerId: "gemini",
    aspectRatios: COMMON_ASPECT_RATIOS,
    imageSizes: ["1K", "2K", "4K"],
    outputMimes: ["image/png", "image/jpeg"],
    maxReferenceImages: 14,
    maxOutputs: 1,
    supportsEditing: true,
    supportsCancellation: false,
  },
  {
    id: "gemini-3-pro-image",
    label: "Nano Banana Pro",
    providerId: "gemini",
    aspectRatios: COMMON_ASPECT_RATIOS,
    imageSizes: ["1K", "2K", "4K"],
    outputMimes: ["image/png", "image/jpeg"],
    maxReferenceImages: 14,
    maxOutputs: 1,
    supportsEditing: true,
    supportsCancellation: false,
  },
];

export interface GeminiInteractionsRequestBody {
  model: string;
  input: Array<
    | { type: "text"; text: string }
    | { type: "image"; mime_type: "image/png" | "image/jpeg" | "image/webp"; data: string }
  >;
  response_format: {
    type: "image";
    mime_type: "image/png" | "image/jpeg";
    aspect_ratio: string;
    image_size: string;
  };
  store: false;
  background: false;
}

function selectedModel(modelId: string): ImageProviderModelCapabilities {
  const model = GEMINI_IMAGE_MODELS.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("This Gemini image model is not supported by this Aiden release.");
  return model;
}

export function validateGeminiImageRequest(
  request: ValidatedImageGenerationRequest,
): ValidatedImageGenerationRequest {
  if (request.providerId !== "gemini") throw new Error("Expected a Gemini image request.");
  const model = selectedModel(request.modelId);
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("Gemini image generation requires a prompt.");
  if (prompt.length > 32_000) throw new Error("The image prompt exceeds Aiden's safe limit.");
  if (!model.aspectRatios.includes(request.aspectRatio)) {
    throw new Error("The selected Gemini model does not support this aspect ratio.");
  }
  if (!model.imageSizes.includes(request.imageSize)) {
    throw new Error("The selected Gemini model does not support this image size.");
  }
  if (!model.outputMimes.includes(request.outputMime)) {
    throw new Error("The selected Gemini model does not support this output format.");
  }
  if (request.count !== 1) {
    throw new Error(
      "The Gemini Interactions image adapter currently supports one output per call.",
    );
  }
  const references = request.references;
  if (references.length > model.maxReferenceImages) {
    throw new Error(
      `The selected Gemini model accepts at most ${model.maxReferenceImages} references.`,
    );
  }
  let totalBytes = 0;
  for (const reference of references) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(reference.assetId)) {
      throw new Error("Gemini references require opaque Aiden asset IDs.");
    }
    const byteLength = reference.bytes.byteLength;
    if (byteLength === 0 || byteLength > 20 * 1024 * 1024) {
      throw new Error("Each Gemini reference must be between 1 byte and 20 MB.");
    }
    totalBytes += byteLength;
  }
  if (totalBytes > 64 * 1024 * 1024) {
    throw new Error("Gemini reference images exceed Aiden's 64 MB request limit.");
  }
  return { ...request, prompt };
}

export function buildGeminiInteractionsRequest(
  request: ValidatedImageGenerationRequest,
): GeminiInteractionsRequestBody {
  const validated = validateGeminiImageRequest(request);
  return {
    model: validated.modelId,
    input: [
      { type: "text", text: validated.prompt },
      ...validated.references.map((reference) => ({
        type: "image" as const,
        mime_type: reference.mimeType,
        data: Buffer.from(
          reference.bytes.buffer,
          reference.bytes.byteOffset,
          reference.bytes.byteLength,
        ).toString("base64"),
      })),
    ],
    response_format: {
      type: "image",
      mime_type: validated.outputMime,
      aspect_ratio: validated.aspectRatio,
      image_size: validated.imageSize,
    },
    store: false,
    background: false,
  };
}
