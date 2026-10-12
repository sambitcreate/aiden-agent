// Device-local Image Generation settings: per-model enable choices, the
// default model, custom model ids and the cached "Fetch latest models" lists.
// Keys never live here; they are in the encrypted credential store.

import { DataStore } from "../data-store.js";
import {
  FAL_REFERENCE_FIELDS,
  IMAGE_GENERATION_LIMITS,
  isImageGenerationProviderId,
  MAX_IMAGE_REFERENCES,
  REPLICATE_REFERENCE_FIELDS,
  type FalReferenceField,
  type ImageCatalogEntry,
  type ImageGenerationProviderId,
  type ImageModelAdapter,
  type ImageModelRef,
  type ReplicateReferenceField,
} from "../../../renderer/shared/image-generation/types.js";
import { isFalEndpointId } from "./fal-images.js";

export const IMAGE_GENERATION_SETTINGS_FILE = "image-generation-settings.json";

export interface FetchedImageCatalog {
  fetchedAt: number;
  models: ImageCatalogEntry[];
}

export interface ImageGenerationSettings {
  version: 1;
  /** Explicit choices. A model without one is enabled unless it came from a fetch. */
  enabled: Partial<Record<ImageGenerationProviderId, Record<string, boolean>>>;
  defaultModel: ImageModelRef | null;
  custom: Partial<Record<ImageGenerationProviderId, ImageCatalogEntry[]>>;
  fetched: Partial<Record<ImageGenerationProviderId, FetchedImageCatalog>>;
}

export function defaultImageGenerationSettings(): ImageGenerationSettings {
  return { version: 1, enabled: {}, defaultModel: null, custom: {}, fetched: {} };
}

const OPENROUTER_ID = /^[a-z0-9][a-z0-9._:-]*\/[a-z0-9][a-z0-9._:-]*$/iu;
const REPLICATE_ID = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/iu;
const MAKER = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const INPUT_KEY = /^[a-z_][a-z0-9_]{0,63}$/u;
export const REPLICATE_VERSION_ID = /^[a-z0-9]{1,128}$/iu;
export const MAX_ENABLED_CHOICES = 2000;
const MAX_FIXED_INPUTS = 16;

export function isValidImageModelId(provider: ImageGenerationProviderId, id: string): boolean {
  if (id.length === 0 || id.length > IMAGE_GENERATION_LIMITS.maxModelIdLength || id.trim() !== id) return false;
  if (provider === "openrouter") return OPENROUTER_ID.test(id);
  if (provider === "replicate") return REPLICATE_ID.test(id);
  return isFalEndpointId(id);
}

function fail(): never {
  throw new Error("Image generation settings are invalid.");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : record(value);
}

function maxReferences(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_IMAGE_REFERENCES
    ? (value as number)
    : fail();
}

function parseAdapter(provider: ImageGenerationProviderId, id: string, value: unknown): ImageModelAdapter {
  const adapter = record(value);
  if (adapter.kind !== provider) fail();
  if (provider === "openrouter") {
    if (adapter.textOutput !== undefined && typeof adapter.textOutput !== "boolean") fail();
    return { kind: "openrouter", ...(adapter.textOutput === true ? { textOutput: true } : {}) };
  }
  const max = maxReferences(adapter.maxReferences);
  if (provider === "replicate") {
    const field = adapter.referenceField;
    if (field !== undefined && (typeof field !== "string" || !Object.prototype.hasOwnProperty.call(REPLICATE_REFERENCE_FIELDS, field))) fail();
    let input: Record<string, string | number | boolean> | undefined;
    if (adapter.input !== undefined) {
      const raw = record(adapter.input);
      const entries = Object.entries(raw);
      if (entries.length > MAX_FIXED_INPUTS) fail();
      input = {};
      for (const [key, entry] of entries) {
        if (!INPUT_KEY.test(key) || key === "prompt") fail();
        if (typeof entry === "string" ? entry.length > 200 : typeof entry !== "number" && typeof entry !== "boolean") {
          fail();
        }
        input[key] = entry as string | number | boolean;
      }
    }
    const version = adapter.version;
    if (version !== undefined && (typeof version !== "string" || !REPLICATE_VERSION_ID.test(version))) fail();
    return {
      kind: "replicate",
      ...(field ? { referenceField: field as ReplicateReferenceField, ...(max ? { maxReferences: max } : {}) } : {}),
      ...(input ? { input } : {}),
      ...(typeof version === "string" ? { version } : {}),
    };
  }
  if (adapter.textEndpoint !== id) fail();
  const edit = adapter.editEndpoint;
  if (edit !== undefined && (typeof edit !== "string" || !isFalEndpointId(edit))) fail();
  const field = adapter.referenceField;
  if (field !== undefined && !(FAL_REFERENCE_FIELDS as readonly unknown[]).includes(field)) fail();
  return {
    kind: "fal",
    textEndpoint: id,
    ...(edit
      ? {
          editEndpoint: edit,
          referenceField: (field as FalReferenceField | undefined) ?? "image_urls",
          ...(max ? { maxReferences: max } : {}),
        }
      : {}),
  };
}

/** Strictly validate one stored catalog entry for a provider. */
export function parseImageCatalogEntry(provider: ImageGenerationProviderId, value: unknown): ImageCatalogEntry {
  const entry = record(value);
  if (entry.provider !== provider) fail();
  const id = entry.id;
  if (typeof id !== "string" || !isValidImageModelId(provider, id)) fail();
  const name = entry.name;
  if (typeof name !== "string" || !name.trim() || name.length > IMAGE_GENERATION_LIMITS.maxModelNameLength) fail();
  if (entry.maker !== undefined && (typeof entry.maker !== "string" || !MAKER.test(entry.maker))) fail();
  const adapter = parseAdapter(provider, id, entry.adapter);
  let acceptsReferenceImages: boolean;
  if (adapter.kind === "replicate") acceptsReferenceImages = adapter.referenceField !== undefined;
  else if (adapter.kind === "fal") acceptsReferenceImages = adapter.editEndpoint !== undefined;
  else if (typeof entry.acceptsReferenceImages === "boolean") acceptsReferenceImages = entry.acceptsReferenceImages;
  else fail();
  return {
    provider,
    id,
    name: name.trim(),
    ...(typeof entry.maker === "string" ? { maker: entry.maker } : {}),
    acceptsReferenceImages,
    adapter,
  };
}

function parseEntries(provider: ImageGenerationProviderId, value: unknown, limit: number): ImageCatalogEntry[] {
  if (!Array.isArray(value) || value.length > limit) fail();
  const seen = new Set<string>();
  return value.map((raw) => {
    const entry = parseImageCatalogEntry(provider, raw);
    if (seen.has(entry.id)) fail();
    seen.add(entry.id);
    return entry;
  });
}

/** Validate a whole settings document. Throws on anything unexpected. */
export function normalizeImageGenerationSettings(value: unknown): ImageGenerationSettings {
  const document = record(value);
  if (document.version !== 1) fail();
  const settings = defaultImageGenerationSettings();

  for (const [provider, raw] of Object.entries(optionalRecord(document.enabled))) {
    if (!isImageGenerationProviderId(provider)) fail();
    const choices = record(raw);
    const entries = Object.entries(choices);
    if (entries.length > MAX_ENABLED_CHOICES) fail();
    const parsed: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
    for (const [id, enabled] of entries) {
      if (!isValidImageModelId(provider, id) || typeof enabled !== "boolean") fail();
      parsed[id] = enabled;
    }
    settings.enabled[provider] = parsed;
  }

  if (document.defaultModel !== undefined && document.defaultModel !== null) {
    const ref = record(document.defaultModel);
    if (!isImageGenerationProviderId(ref.provider) || typeof ref.id !== "string") fail();
    if (!isValidImageModelId(ref.provider, ref.id)) fail();
    settings.defaultModel = { provider: ref.provider, id: ref.id };
  }

  for (const [provider, raw] of Object.entries(optionalRecord(document.custom))) {
    if (!isImageGenerationProviderId(provider)) fail();
    settings.custom[provider] = parseEntries(provider, raw, IMAGE_GENERATION_LIMITS.maxCustomModelsPerProvider);
  }

  for (const [provider, raw] of Object.entries(optionalRecord(document.fetched))) {
    if (!isImageGenerationProviderId(provider)) fail();
    const cache = record(raw);
    const fetchedAt = cache.fetchedAt;
    if (typeof fetchedAt !== "number" || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) fail();
    settings.fetched[provider] = {
      fetchedAt,
      models: parseEntries(provider, cache.models, IMAGE_GENERATION_LIMITS.maxFetchedModelsPerProvider),
    };
  }
  return settings;
}

export interface ImageGenerationSettingsStore {
  read(): Promise<ImageGenerationSettings>;
  update(mutate: (draft: ImageGenerationSettings) => void): Promise<ImageGenerationSettings>;
  reset(): Promise<void>;
  /** True when the file existed but failed validation and defaults are in use. */
  loadedFromCorruptFile(): Promise<boolean>;
}

/** A DataStore-backed settings store; `root` is injectable for tests. */
export function createImageGenerationSettingsStore(root?: () => string): ImageGenerationSettingsStore {
  const store = new DataStore<ImageGenerationSettings>(
    IMAGE_GENERATION_SETTINGS_FILE,
    defaultImageGenerationSettings(),
    root,
    { maxBytes: 4 * 1024 * 1024, fileMode: 0o600, normalize: normalizeImageGenerationSettings },
  );
  return {
    async read() {
      return structuredClone(await store.load());
    },
    async update(mutate) {
      return store.update((draft) => {
        mutate(draft);
        // Re-validate so a buggy mutation can never persist an invalid document.
        // Normalizing only reads the draft and builds a fresh document.
        const next = normalizeImageGenerationSettings(draft);
        Object.assign(draft, next);
        return structuredClone(next);
      });
    },
    async reset() {
      await store.save(defaultImageGenerationSettings());
    },
    loadedFromCorruptFile: () => store.loadedFromCorruptFile(),
  };
}
