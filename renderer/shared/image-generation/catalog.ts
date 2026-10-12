// Curated, bundled image-model catalogs for Replicate and fal, plus maker
// inference for logos. Renderer-safe: no Node or Electron imports. OpenRouter's
// curated list comes from Pi's bundled catalog in main.
//
// Reference-image fields are listed only where they were verified; a model
// whose field is unknown is offered as text-to-image only.

import type {
  FalReferenceField,
  ImageCatalogEntry,
  ImageGenerationProviderId,
  ReplicateReferenceField,
} from "./types.js";

function replicate(
  id: string,
  name: string,
  maker: string,
  reference?: { field: ReplicateReferenceField; max?: number },
): ImageCatalogEntry {
  return {
    provider: "replicate",
    id,
    name,
    maker,
    acceptsReferenceImages: reference !== undefined,
    adapter: {
      kind: "replicate",
      ...(reference ? { referenceField: reference.field, maxReferences: reference.max ?? 4 } : {}),
    },
  };
}

function fal(
  id: string,
  name: string,
  maker: string,
  edit?: { endpoint: string; field?: FalReferenceField; max?: number },
): ImageCatalogEntry {
  return {
    provider: "fal",
    id,
    name,
    maker,
    acceptsReferenceImages: edit !== undefined,
    adapter: {
      kind: "fal",
      textEndpoint: id,
      ...(edit
        ? {
            editEndpoint: edit.endpoint,
            referenceField: edit.field ?? "image_urls",
            maxReferences: edit.max ?? (edit.field === "image_url" ? 1 : 4),
          }
        : {}),
    },
  };
}

const BFL = "black-forest-labs";

export const CURATED_REPLICATE_IMAGE_MODELS: readonly ImageCatalogEntry[] = [
  replicate("black-forest-labs/flux-3-image", "FLUX.3", BFL, { field: "images", max: 10 }),
  replicate("black-forest-labs/flux-2-max", "FLUX.2 Max", BFL, { field: "input_images", max: 8 }),
  replicate("black-forest-labs/flux-2-pro", "FLUX.2 Pro", BFL, { field: "input_images", max: 8 }),
  replicate("black-forest-labs/flux-2-flex", "FLUX.2 Flex", BFL),
  replicate("black-forest-labs/flux-kontext-max", "FLUX Kontext Max", BFL, { field: "input_image" }),
  replicate("black-forest-labs/flux-1.1-pro-ultra", "FLUX 1.1 Pro Ultra", BFL),
  replicate("black-forest-labs/flux-schnell", "FLUX Schnell", BFL),
  replicate("google/nano-banana-2.1", "Nano Banana 2.1", "google", { field: "image_input", max: 14 }),
  replicate("google/nano-banana-pro", "Nano Banana Pro", "google", { field: "image_input", max: 14 }),
  replicate("google/imagen-4-ultra", "Imagen 4 Ultra", "google"),
  replicate("google/imagen-4-fast", "Imagen 4 Fast", "google"),
  replicate("openai/gpt-image-2", "GPT Image 2", "openai", { field: "input_images" }),
  replicate("openai/gpt-image-2.5-flare", "GPT Image 2.5 Flare", "openai", { field: "input_images" }),
  replicate("bytedance/seedream-5-pro", "Seedream 5 Pro", "bytedance", { field: "image_input", max: 10 }),
  replicate("bytedance/seedream-4.5", "Seedream 4.5", "bytedance", { field: "image_input", max: 10 }),
  replicate("xai/grok-imagine-image-2", "Grok Imagine 2", "xai", { field: "image" }),
  replicate("ideogram-ai/ideogram-4-5", "Ideogram 4.5", "ideogram"),
  replicate("ideogram-ai/ideogram-v4-turbo", "Ideogram 4 Turbo", "ideogram"),
  replicate("recraft-ai/recraft-v4.1-pro", "Recraft 4.1 Pro", "recraft"),
  replicate("qwen/qwen-image-2-pro", "Qwen Image 2 Pro", "qwen"),
  replicate("qwen/qwen-image-edit-2511", "Qwen Image Edit 2511", "qwen", { field: "image" }),
  replicate("tencent/hunyuan-image-3", "Hunyuan Image 3", "tencent-hunyuan"),
  replicate("luma/photon", "Luma Photon", "luma"),
  replicate("minimax/image-01", "MiniMax Image 01", "minimax", { field: "subject_reference" }),
  replicate("bria/fibo", "Bria FIBO", "bria"),
  replicate("stability-ai/stable-diffusion-3.5-large", "Stable Diffusion 3.5 Large", "stability-ai"),
  replicate("nvidia/sana", "NVIDIA Sana", "nvidia"),
];

export const CURATED_FAL_IMAGE_MODELS: readonly ImageCatalogEntry[] = [
  fal("blackforestlabs/flux-3/text-to-image", "FLUX.3", BFL, { endpoint: "blackforestlabs/flux-3/edit-image" }),
  fal("fal-ai/flux-2-max", "FLUX.2 Max", BFL),
  fal("fal-ai/flux-2-pro", "FLUX.2 Pro", BFL),
  fal("fal-ai/flux-2/klein/9b", "FLUX.2 Klein 9B", BFL),
  fal("fal-ai/flux-pro/kontext/max/text-to-image", "FLUX Kontext Max", BFL, {
    endpoint: "fal-ai/flux-pro/kontext/max",
    field: "image_url",
  }),
  fal("fal-ai/flux/schnell", "FLUX Schnell", BFL),
  fal("google/nano-banana-2.1", "Nano Banana 2.1", "google", { endpoint: "google/nano-banana-2.1/edit" }),
  fal("fal-ai/nano-banana-pro", "Nano Banana Pro", "google", { endpoint: "fal-ai/nano-banana-pro/edit" }),
  fal("openai/gpt-image-2", "GPT Image 2", "openai", { endpoint: "openai/gpt-image-2/edit" }),
  fal("openai/gpt-image-2.5/flare/text-to-image", "GPT Image 2.5 Flare", "openai", {
    endpoint: "openai/gpt-image-2.5/flare/edit",
  }),
  fal("bytedance/seedream/v5/pro/text-to-image", "Seedream 5 Pro", "bytedance", {
    endpoint: "bytedance/seedream/v5/pro/edit",
  }),
  fal("bytedance/seedream/v5/flash/text-to-image", "Seedream 5 Flash", "bytedance"),
  fal("xai/grok-imagine-image/v2.0/text-to-image", "Grok Imagine 2", "xai", {
    endpoint: "xai/grok-imagine-image/v2.0/edit",
  }),
  fal("ideogram/v4.5", "Ideogram 4.5", "ideogram", { endpoint: "ideogram/v4.5/edit" }),
  fal("fal-ai/recraft/v4.1/pro/text-to-image", "Recraft 4.1 Pro", "recraft"),
  fal("alibaba/qwen-image-3/text-to-image", "Qwen Image 3", "qwen", { endpoint: "alibaba/qwen-image-3/edit" }),
  fal("microsoft/mai-image-2.5-pro", "MAI Image 2.5 Pro", "microsoft", {
    endpoint: "microsoft/mai-image-2.5-pro/edit",
  }),
  fal("meta/muse-image/text-to-image", "Muse Image", "meta", { endpoint: "meta/muse-image/edit" }),
  fal("krea/v2/large/text-to-image", "Krea 2 Large", "krea"),
  fal("fal-ai/hunyuan-image/v3/instruct/text-to-image", "Hunyuan Image 3", "tencent-hunyuan"),
  fal("fal-ai/kling-image/v3/text-to-image", "Kling Image 3", "kling"),
  fal("bria/fibo-gen-1.5/text-to-image", "Bria FIBO", "bria"),
  fal("fal-ai/stable-diffusion-v35-large", "Stable Diffusion 3.5 Large", "stability-ai"),
  fal("fal-ai/minimax/image-01", "MiniMax Image 01", "minimax"),
];

export function curatedImageModels(provider: ImageGenerationProviderId): readonly ImageCatalogEntry[] {
  if (provider === "replicate") return CURATED_REPLICATE_IMAGE_MODELS;
  if (provider === "fal") return CURATED_FAL_IMAGE_MODELS;
  return [];
}

// ---- Maker inference ----

/** Model-family keywords win over the owner or namespace (e.g. `fal-ai/flux`). */
const MAKER_KEYWORDS: readonly (readonly [RegExp, string])[] = [
  [/(?:^|[^a-z])flux(?:[^a-z]|$)|kontext/u, "black-forest-labs"],
  [/seedream|seededit/u, "bytedance"],
  [/nano-banana|imagen|gemini/u, "google"],
  [/gpt-image|dall-e|gpt-5(?:\.\d+)?-image/u, "openai"],
  [/grok/u, "xai"],
  [/qwen/u, "qwen"],
  [/hunyuan/u, "tencent-hunyuan"],
  [/kling/u, "kling"],
  [/ideogram/u, "ideogram"],
  [/recraft/u, "recraft"],
  [/krea/u, "krea"],
  [/minimax/u, "minimax"],
  [/stable-diffusion|sdxl|(?:^|[^a-z])sd-?3/u, "stability-ai"],
  [/(?:^|[^a-z])fibo|(?:^|\/)bria/u, "bria"],
  [/photon|(?:^|\/)luma/u, "luma"],
  [/mai-image/u, "microsoft"],
  [/muse-image/u, "meta"],
  [/midjourney/u, "midjourney"],
  [/(?:^|\/)reve/u, "reve"],
  [/(?:^|[^a-z])ltx/u, "lightricks"],
  [/runway|(?:^|\/)gen-?4/u, "runway"],
  [/(?:^|\/)sana/u, "nvidia"],
];

/** Owner or namespace segment (first path segment) to logo slug. */
const MAKER_OWNERS: Readonly<Record<string, string>> = {
  "black-forest-labs": "black-forest-labs",
  blackforestlabs: "black-forest-labs",
  bfl: "black-forest-labs",
  google: "google",
  openai: "openai",
  bytedance: "bytedance",
  "bytedance-seed": "bytedance",
  xai: "xai",
  "x-ai": "xai",
  ideogram: "ideogram",
  "ideogram-ai": "ideogram",
  recraft: "recraft",
  "recraft-ai": "recraft",
  qwen: "qwen",
  alibaba: "alibaba",
  tencent: "tencent-hunyuan",
  luma: "luma",
  minimax: "minimax",
  bria: "bria",
  "stability-ai": "stability-ai",
  nvidia: "nvidia",
  krea: "krea",
  microsoft: "microsoft",
  meta: "meta",
  kwaivgi: "kling",
  prunaai: "pruna-ai",
  "pruna-ai": "pruna-ai",
  runwayml: "runway",
  lightricks: "lightricks",
  deepseek: "deepseek",
};

/**
 * Infer the maker logo slug for an image model id. Pure and offline: the
 * name's model family wins, then the owner or namespace. Unknown makers return
 * undefined so the UI can fall back to an initial.
 */
export function inferImageModelMaker(providerId: string, modelId: string): string | undefined {
  const id = modelId.trim().toLowerCase();
  if (!id) return undefined;
  for (const [pattern, maker] of MAKER_KEYWORDS) {
    if (pattern.test(id)) return maker;
  }
  const owner = id.split("/", 1)[0] ?? "";
  if (Object.prototype.hasOwnProperty.call(MAKER_OWNERS, owner)) return MAKER_OWNERS[owner];
  // OpenRouter's own routers carry the OpenRouter mark.
  if (providerId === "openrouter" && owner === "openrouter") return "openrouter";
  return undefined;
}

/** Display name for an OpenRouter model: drops the "Vendor: " prefix, since the maker logo says it. */
export function openRouterImageModelDisplayName(name: string): string {
  return name.replace(/^[^:]{1,40}:\s+/u, "").trim() || name;
}
