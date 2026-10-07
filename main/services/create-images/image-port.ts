import type { AssistantImages, ImageContent, Models, Usage } from "@earendil-works/pi-ai";
import type {
  GeneratedImage,
  ImageGenerationFailureCode,
  ImageGenerationPort,
  ImageGenerationResult,
} from "../../../renderer/shared/images/port.js";
import { IMAGE_WORKFLOW_LIMITS } from "../../../renderer/shared/images/schema.js";
import { parseGeneratedImages, type ParsedGeneratedImages } from "../pi-model-image-output.js";
import { resolvePiModelImageInputs, type PiModelToolsHost } from "../pi-model-tools.js";
import { isStudioAssetMediaType } from "../studio-assets/contract.js";

export type ImageOperationUsage = Parameters<NonNullable<PiModelToolsHost["onUsage"]>>[0];

export interface PiImagePortOptions {
  models: Pick<Models, "getAvailableOfType" | "getModelOfType" | "generateImages">;
  providerLabel(providerId: string): string;
  /** Offline catalog hydration before listing. Never a network refresh. */
  beforeList?(): Promise<void>;
  onUsage?(record: ImageOperationUsage): Promise<void>;
}

/** Consent must name the real model, so OpenRouter's routers are never offered. */
const AUTO_ROUTER = /^openrouter\/auto(?:[-/].*)?$/u;

function failed(code: ImageGenerationFailureCode, message: string, usage?: Usage): ImageGenerationResult {
  return { kind: "failed", code, message: message.slice(0, 1_024), ...(usage ? { usage } : {}) };
}

export function createPiImageGenerationPort(options: PiImagePortOptions): ImageGenerationPort {
  const account = async (record: ImageOperationUsage) => {
    try {
      await options.onUsage?.(record);
    } catch {
      // Accounting must never hide a paid provider result.
    }
  };

  return {
    async listModels(signal) {
      await options.beforeList?.();
      const available = await options.models.getAvailableOfType("image", undefined, { signal });
      return available
        .filter((model) => !AUTO_ROUTER.test(model.id))
        .map((model) => ({
          provider: model.provider,
          providerLabel: options.providerLabel(model.provider),
          model: model.id,
          label: model.name || model.id,
          acceptsReferences: model.input.includes("image"),
          textOutput: model.output.includes("text"),
        }))
        .sort((left, right) => left.providerLabel.localeCompare(right.providerLabel) || left.label.localeCompare(right.label));
    },

    async generate(request) {
      const model = options.models.getModelOfType("image", request.provider, request.model);
      if (!model || model.provider !== request.provider || model.id !== request.model || AUTO_ROUTER.test(model.id)) {
        return failed("unknown-model", "This image model is not available. Choose another model.");
      }
      if (request.references.length > 0 && !model.input.includes("image")) {
        return failed("references-unsupported", "This image model does not accept reference images.");
      }
      if (request.references.length > IMAGE_WORKFLOW_LIMITS.maxReferences) {
        return failed(
          "references-unsupported",
          `This image request has ${request.references.length} reference images. Aiden sends at most ${IMAGE_WORKFLOW_LIMITS.maxReferences}.`,
        );
      }
      let references: ImageContent[];
      try {
        const contents: ImageContent[] = request.references.map((reference) => ({
          type: "image",
          mimeType: reference.mimeType,
          data: Buffer.from(reference.bytes).toString("base64"),
        }));
        // The chat tool's exact bounds: at most 4 references, 8 MiB and 40 megapixels.
        ({ images: references } = await resolvePiModelImageInputs(
          { resolveImages: async (ids) => ids.map((id) => ({ name: `Reference ${id}`, image: contents[Number(id) - 1]! })) },
          contents.map((_, index) => String(index + 1)),
          request.signal,
        ));
      } catch (error) {
        if (request.signal.aborted) return failed("aborted", "Stopped before sending.");
        return failed("references-unsupported", error instanceof Error ? error.message : "These reference images cannot be sent.");
      }
      if (request.signal.aborted) return failed("aborted", "Stopped before sending.");

      const identity = {
        provider: model.provider,
        providerLabel: options.providerLabel(model.provider),
        model: model.id,
        modelLabel: model.name || model.id,
      };
      let result: AssistantImages;
      try {
        result = await options.models.generateImages(
          model,
          { input: [{ type: "text", text: request.prompt }, ...references] },
          { signal: request.signal, maxRetries: 0 },
        );
      } catch (error) {
        // Models.generateImages never rejects; this guards a regression without hiding the outcome.
        await account({ ...identity, status: request.signal.aborted ? "cancelled" : "failed" });
        return failed(request.signal.aborted ? "aborted" : "provider-error", error instanceof Error ? error.message : "The image request failed.");
      }
      const stopped = result.stopReason === "aborted" || (result.stopReason !== "stop" && request.signal.aborted);
      await account({
        ...identity,
        ...(result.usage ? { usage: result.usage } : {}),
        status: result.stopReason === "stop" ? "completed" : stopped ? "cancelled" : "failed",
      });
      if (result.stopReason !== "stop") {
        return stopped
          ? failed("aborted", "The image request was stopped.", result.usage)
          : failed("provider-error", result.errorMessage ?? "The provider returned an error.", result.usage);
      }

      let parsed: ParsedGeneratedImages;
      try {
        parsed = parseGeneratedImages(result.output, { overflow: "truncate" });
      } catch (error) {
        return failed("output-invalid", error instanceof Error ? error.message : "The model returned no images.", result.usage);
      }
      const images: GeneratedImage[] = [];
      parsed.images.forEach((image, index) => {
        if (!isStudioAssetMediaType(image.mimeType)) return;
        const size = parsed.sizes[index]!;
        images.push({ mimeType: image.mimeType, bytes: new Uint8Array(Buffer.from(image.data, "base64")), width: size.width, height: size.height });
      });
      if (images.length === 0) {
        return failed("output-invalid", "The model returned no PNG, JPEG or WebP images.", result.usage);
      }
      return {
        kind: "images",
        images,
        truncated: parsed.truncated || images.length < parsed.images.length,
        ...(parsed.description ? { text: parsed.description } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.responseId ? { responseId: result.responseId } : {}),
      };
    },
  };
}
