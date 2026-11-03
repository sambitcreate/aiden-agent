import type { AssistantImages, ImageApi, ImageContent, ImageModel, Models, Usage } from "@earendil-works/pi-ai";
import type {
  GeneratedImage,
  ImageGenerationFailureCode,
  ImageGenerationPort,
  ImageGenerationPreflight,
  ImageGenerationRequest,
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
  /**
   * Offline registry hydration before any lookup (listing or a request), since
   * model lookups are synchronous. Never a network refresh.
   */
  prepare?(): Promise<void>;
  /** The Settings → Image Generation default, from the cached runtime snapshot. */
  defaultModel?(): Promise<{ provider: string; id: string } | undefined>;
  /** Maker slug for a model's logo. */
  maker?(providerId: string, modelId: string): string | undefined;
  onUsage?(record: ImageOperationUsage): Promise<void>;
}

/** Consent must name the real model, so OpenRouter's routers are never offered. */
const AUTO_ROUTER = /^openrouter\/auto(?:[-/].*)?$/u;

function failed(code: ImageGenerationFailureCode, message: string, usage?: Usage): ImageGenerationResult & { kind: "failed" } {
  return { kind: "failed", code, message: message.slice(0, 1_024), ...(usage ? { usage } : {}) };
}

type ImageModelEntry = ImageModel<ImageApi>;

/** Most references one request may carry: the model's own per-request limit, never above Aiden's. */
export function modelReferenceLimit(model: Pick<ImageModelEntry, "input" | "inputLimits">): number {
  if (!model.input.includes("image")) return 0;
  const own = model.inputLimits?.images?.maxPerRequest;
  return typeof own === "number" && Number.isInteger(own) && own > 0
    ? Math.min(own, IMAGE_WORKFLOW_LIMITS.maxReferences)
    : IMAGE_WORKFLOW_LIMITS.maxReferences;
}

const MAX_REFUSAL_TEXT = 280;

/** A model's caption as one bounded line, so a refusal can be shown without trusting its layout. */
function oneLine(output: AssistantImages["output"]): string {
  const text = output
    .flatMap((item) => (item && typeof item === "object" && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join(" ")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  return text.length > MAX_REFUSAL_TEXT ? `${text.slice(0, MAX_REFUSAL_TEXT - 1).trimEnd()}…` : text;
}

export function createPiImageGenerationPort(options: PiImagePortOptions): ImageGenerationPort {
  const account = async (record: ImageOperationUsage) => {
    try {
      await options.onUsage?.(record);
    } catch {
      // Accounting must never hide a paid provider result.
    }
  };

  async function preflight(request: ImageGenerationRequest): Promise<ImageGenerationPreflight> {
    try {
      await options.prepare?.();
    } catch {
      return failed("unknown-model", "Image models could not be loaded. Check Settings → Image Generation.");
    }
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
    const limit = modelReferenceLimit(model);
    if (request.references.length > limit) {
      return failed(
        "references-unsupported",
        `This image request has ${request.references.length} reference images. This model accepts at most ${limit}.`,
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
    return { kind: "ready", send: () => send(model, request, references) };
  }

  async function send(model: ImageModelEntry, request: ImageGenerationRequest, references: ImageContent[]): Promise<ImageGenerationResult> {
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

    // Only stored types count toward the 4-image cap, so an interim GIF cannot push out a valid image.
    const output = Array.isArray(result.output) ? result.output : [];
    const kept = output.filter((item) => !(item && typeof item === "object" && item.type === "image" && !isStudioAssetMediaType(item.mimeType)));
    const droppedType = kept.length < output.length;
    const caption = oneLine(output);
    if (!kept.some((item) => item && typeof item === "object" && item.type === "image")) {
      const none = droppedType ? "The model returned no PNG, JPEG or WebP images." : "The model returned no images.";
      return failed("output-invalid", caption ? `${none} It said: “${caption}”` : none, result.usage);
    }
    let parsed: ParsedGeneratedImages;
    try {
      parsed = parseGeneratedImages(kept, { overflow: "truncate" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The model returned no images.";
      return failed("output-invalid", caption ? `${message} It said: “${caption}”` : message, result.usage);
    }
    const images: GeneratedImage[] = parsed.images.map((image, index) => {
      const size = parsed.sizes[index]!;
      return { mimeType: image.mimeType, bytes: new Uint8Array(Buffer.from(image.data, "base64")), width: size.width, height: size.height };
    });
    return {
      kind: "images",
      images,
      truncated: parsed.truncated || droppedType,
      ...(parsed.description ? { text: parsed.description } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.responseId ? { responseId: result.responseId } : {}),
    };
  }

  return {
    async listModels(signal) {
      try {
        await options.prepare?.();
      } catch {
        // An image-settings load failure must not block opening or creating a workflow.
        return [];
      }
      const available = await options.models.getAvailableOfType("image", undefined, { signal });
      // A missing default only loses the preselection; the list still loads.
      const preferred = await options.defaultModel?.().catch(() => undefined);
      return available
        .filter((model) => !AUTO_ROUTER.test(model.id))
        .map((model) => {
          const maker = options.maker?.(model.provider, model.id);
          const acceptsReferences = model.input.includes("image");
          return {
            provider: model.provider,
            providerLabel: options.providerLabel(model.provider),
            model: model.id,
            label: model.name || model.id,
            acceptsReferences,
            ...(acceptsReferences ? { maxReferences: modelReferenceLimit(model) } : {}),
            textOutput: model.output.includes("text"),
            ...(preferred?.provider === model.provider && preferred.id === model.id ? { isDefault: true } : {}),
            ...(maker ? { maker } : {}),
          };
        })
        .sort((left, right) => left.providerLabel.localeCompare(right.providerLabel) || left.label.localeCompare(right.label));
    },

    preflight,

    async generate(request) {
      const checked = await preflight(request);
      return checked.kind === "ready" ? checked.send() : checked;
    },
  };
}
