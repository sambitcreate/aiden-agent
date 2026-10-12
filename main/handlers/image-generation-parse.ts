// Exact-shape request parsers for the imageGeneration:* channels. Anything
// else is rejected before any store, key or network is touched.

import { hasExactKeys, isRecord } from "../shared/guards.js";
import { INVALID_IMAGE_GENERATION_REQUEST } from "../services/image-generation/action.js";
import {
  IMAGE_GENERATION_LIMITS,
  isImageGenerationProviderId,
  type ImageGenerationAddCustomModelRequest,
  type ImageGenerationProviderId,
  type ImageGenerationProviderRequest,
  type ImageGenerationSetKeyRequest,
  type ImageGenerationSetModelEnabledRequest,
  type ImageModelRef,
} from "../../renderer/shared/image-generation/types.js";

function invalid(): never {
  throw new Error(INVALID_IMAGE_GENERATION_REQUEST);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plain(value) || !hasExactKeys(value, required, optional)) invalid();
  return value;
}

function provider(value: unknown): ImageGenerationProviderId {
  return isImageGenerationProviderId(value) ? value : invalid();
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : invalid();
}

function modelId(value: unknown): string {
  return boundedString(value, IMAGE_GENERATION_LIMITS.maxModelIdLength);
}

export function parseProviderRequest(value: unknown): ImageGenerationProviderRequest {
  return { provider: provider(shape(value, ["provider"]).provider) };
}

/** The key is length-bounded here; content rules are applied by the runtime. */
export function parseSetKeyRequest(value: unknown): ImageGenerationSetKeyRequest {
  const request = shape(value, ["provider", "key"]);
  return {
    provider: provider(request.provider),
    key: boundedString(request.key, IMAGE_GENERATION_LIMITS.maxKeyLength * 2),
  };
}

export function parseModelRef(value: unknown): ImageModelRef {
  const request = shape(value, ["provider", "id"]);
  return { provider: provider(request.provider), id: modelId(request.id) };
}

export function parseSetModelEnabledRequest(value: unknown): ImageGenerationSetModelEnabledRequest {
  const request = shape(value, ["provider", "id", "enabled"]);
  if (typeof request.enabled !== "boolean") invalid();
  return { provider: provider(request.provider), id: modelId(request.id), enabled: request.enabled };
}

export function parseSetDefaultModelRequest(value: unknown): ImageModelRef | null {
  return value === null ? null : parseModelRef(value);
}

export function parseAddCustomModelRequest(value: unknown): ImageGenerationAddCustomModelRequest {
  const request = shape(
    value,
    ["provider", "id"],
    ["name", "acceptsReferenceImages", "referenceField", "editEndpoint"],
  );
  if (request.acceptsReferenceImages !== undefined && typeof request.acceptsReferenceImages !== "boolean") invalid();
  return {
    provider: provider(request.provider),
    id: modelId(request.id),
    ...(request.name !== undefined && request.name !== ""
      ? { name: boundedString(request.name, IMAGE_GENERATION_LIMITS.maxModelNameLength) }
      : {}),
    ...(request.acceptsReferenceImages !== undefined
      ? { acceptsReferenceImages: request.acceptsReferenceImages as boolean }
      : {}),
    ...(request.referenceField !== undefined ? { referenceField: boundedString(request.referenceField, 64) } : {}),
    ...(request.editEndpoint !== undefined && request.editEndpoint !== ""
      ? { editEndpoint: modelId(request.editEndpoint) }
      : {}),
  };
}
