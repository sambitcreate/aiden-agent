function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export const MAX_MODELS_DEV_PROVIDERS = 1_024;
export const MAX_MODELS_DEV_MODELS = 100_000;
export const MAX_MODELS_DEV_ID_LENGTH = 512;
export const MAX_MODELS_DEV_NUMERIC_VALUE = 1_000_000_000;

function assertOptionalString(value, field) {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`models.dev model ${field} must be a string when present.`);
  }
}

function assertOptionalBoolean(value, field) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`models.dev model ${field} must be a boolean when present.`);
  }
}

function assertOptionalStringArray(value, field) {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`models.dev model ${field} must be a string array when present.`);
  }
}

function assertOptionalLimit(value, field) {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_MODELS_DEV_NUMERIC_VALUE)
  ) {
    throw new Error(`models.dev model ${field} must be a non-negative number when present.`);
  }
}

function validateModel(modelValue, providerId, modelId) {
  const model = record(modelValue);
  if (!model) {
    throw new Error(`models.dev provider ${providerId} has an invalid model ${modelId}.`);
  }
  if (typeof model.name !== "string" || model.name.length === 0) {
    throw new Error(`models.dev model ${providerId}/${modelId} must have a name.`);
  }
  for (const field of ["id", "knowledge", "release_date", "last_updated"]) {
    assertOptionalString(model[field], `${providerId}/${modelId}.${field}`);
  }
  for (const field of ["attachment", "reasoning", "tool_call", "open_weights"]) {
    assertOptionalBoolean(model[field], `${providerId}/${modelId}.${field}`);
  }

  const modalities = model.modalities === undefined ? null : record(model.modalities);
  if (model.modalities !== undefined && !modalities) {
    throw new Error(`models.dev model ${providerId}/${modelId}.modalities must be an object.`);
  }
  assertOptionalStringArray(modalities?.input, `${providerId}/${modelId}.modalities.input`);
  assertOptionalStringArray(modalities?.output, `${providerId}/${modelId}.modalities.output`);

  const limit = model.limit === undefined ? null : record(model.limit);
  if (model.limit !== undefined && !limit) {
    throw new Error(`models.dev model ${providerId}/${modelId}.limit must be an object.`);
  }
  assertOptionalLimit(limit?.context, `${providerId}/${modelId}.limit.context`);
  assertOptionalLimit(limit?.output, `${providerId}/${modelId}.limit.output`);
}

export function validateModelsDevSnapshot(value) {
  const catalog = record(value);
  if (!catalog) {
    throw new Error("models.dev returned an unexpected payload.");
  }
  let modelCount = 0;
  const providers = Object.entries(catalog);
  if (providers.length > MAX_MODELS_DEV_PROVIDERS) {
    throw new Error("models.dev returned too many providers.");
  }
  for (const [providerId, providerValue] of providers) {
    if (providerId.length === 0 || providerId.length > MAX_MODELS_DEV_ID_LENGTH) {
      throw new Error("models.dev returned an invalid provider identity.");
    }
    const provider = record(providerValue);
    const models = record(provider?.models);
    if (!provider || !models) {
      throw new Error(`models.dev provider ${providerId} must contain a models object.`);
    }
    for (const [modelId, model] of Object.entries(models)) {
      if (modelId.length === 0 || modelId.length > MAX_MODELS_DEV_ID_LENGTH) {
        throw new Error(`models.dev provider ${providerId} contains an invalid model id.`);
      }
      validateModel(model, providerId, modelId);
      modelCount += 1;
      if (modelCount > MAX_MODELS_DEV_MODELS) {
        throw new Error("models.dev returned too many models.");
      }
    }
  }
  if (Object.keys(catalog).length === 0 || modelCount === 0) {
    throw new Error("models.dev returned an empty catalog.");
  }
  return value;
}

export function serializeModelsDevSnapshot(value, maximumBytes = MAX_MODELS_DEV_SNAPSHOT_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("models.dev snapshot byte limit must be a positive safe integer.");
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error("Validated models.dev snapshot exceeds the packaged snapshot byte limit.");
  }
  return serialized;
}
import { Buffer } from "node:buffer";

export const MAX_MODELS_DEV_SNAPSHOT_BYTES = 64 * 1024 * 1024;
