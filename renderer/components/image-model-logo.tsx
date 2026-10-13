// Maker and provider marks for image-generation models. They render exactly
// like ProviderIcon: mono CSS-mask marks in currentColor with a neutral
// initial fallback. Image marks stay out of provider-logos (desktop only).

import { inferImageModelMaker } from "../shared/image-generation/catalog";
import type { ImageGenerationProviderId } from "../shared/image-generation/types";
import { IMAGE_GENERATION_PROVIDER_NAMES } from "../shared/image-generation/types";
import { MarkInitial, ThemedMark } from "./themed-mark";

const IMAGE_LOGO_URLS: Readonly<Record<string, string>> = {
  alibaba: new URL("../assets/image-model-logos/alibaba.svg", import.meta.url).href,
  "black-forest-labs": new URL("../assets/image-model-logos/black-forest-labs.svg", import.meta.url)
    .href,
  bria: new URL("../assets/image-model-logos/bria.svg", import.meta.url).href,
  bytedance: new URL("../assets/image-model-logos/bytedance.svg", import.meta.url).href,
  fal: new URL("../assets/image-model-logos/fal.svg", import.meta.url).href,
  ideogram: new URL("../assets/image-model-logos/ideogram.svg", import.meta.url).href,
  kling: new URL("../assets/image-model-logos/kling.svg", import.meta.url).href,
  krea: new URL("../assets/image-model-logos/krea.svg", import.meta.url).href,
  lightricks: new URL("../assets/image-model-logos/lightricks.svg", import.meta.url).href,
  luma: new URL("../assets/image-model-logos/luma.svg", import.meta.url).href,
  meta: new URL("../assets/image-model-logos/meta.svg", import.meta.url).href,
  microsoft: new URL("../assets/image-model-logos/microsoft.svg", import.meta.url).href,
  midjourney: new URL("../assets/image-model-logos/midjourney.svg", import.meta.url).href,
  "pruna-ai": new URL("../assets/image-model-logos/pruna-ai.svg", import.meta.url).href,
  qwen: new URL("../assets/image-model-logos/qwen.svg", import.meta.url).href,
  recraft: new URL("../assets/image-model-logos/recraft.svg", import.meta.url).href,
  replicate: new URL("../assets/image-model-logos/replicate.svg", import.meta.url).href,
  reve: new URL("../assets/image-model-logos/reve.svg", import.meta.url).href,
  runway: new URL("../assets/image-model-logos/runway.svg", import.meta.url).href,
  "stability-ai": new URL("../assets/image-model-logos/stability-ai.svg", import.meta.url).href,
  "tencent-hunyuan": new URL("../assets/image-model-logos/tencent-hunyuan.svg", import.meta.url)
    .href,
  // Makers that already have a chat-provider mark reuse it.
  deepseek: new URL("../assets/provider-logos/deepseek.svg", import.meta.url).href,
  google: new URL("../assets/provider-logos/google.svg", import.meta.url).href,
  minimax: new URL("../assets/provider-logos/minimax.svg", import.meta.url).href,
  nvidia: new URL("../assets/provider-logos/nvidia.svg", import.meta.url).href,
  openai: new URL("../assets/provider-logos/openai.svg", import.meta.url).href,
  openrouter: new URL("../assets/provider-logos/openrouter.svg", import.meta.url).href,
  xai: new URL("../assets/provider-logos/xai.svg", import.meta.url).href,
};

function logoUrl(slug: string | undefined): string | undefined {
  return slug && Object.prototype.hasOwnProperty.call(IMAGE_LOGO_URLS, slug)
    ? IMAGE_LOGO_URLS[slug]
    : undefined;
}

/** The maker's mark for an image model; an explicit maker wins over inference. */
export function ImageModelLogo({
  maker,
  providerId,
  modelId,
  label,
  className,
}: {
  maker?: string;
  providerId: string;
  modelId: string;
  /** Model name, used for the initial fallback. */
  label: string;
  className?: string;
}) {
  const slug = maker ?? inferImageModelMaker(providerId, modelId);
  const iconUrl = logoUrl(slug);
  if (!slug || !iconUrl) {
    return <MarkInitial label={label} data-image-logo-fallback={modelId} className={className} />;
  }
  return <ThemedMark iconUrl={iconUrl} data-image-logo={slug} className={className} />;
}

/** The mark of an image-generation provider (OpenRouter, Replicate, fal). */
export function ImageProviderLogo({
  providerId,
  className,
}: {
  providerId: ImageGenerationProviderId;
  className?: string;
}) {
  const iconUrl = logoUrl(providerId);
  if (!iconUrl) {
    return (
      <MarkInitial
        label={IMAGE_GENERATION_PROVIDER_NAMES[providerId] ?? providerId}
        data-image-logo-fallback={providerId}
        className={className}
      />
    );
  }
  return <ThemedMark iconUrl={iconUrl} data-image-logo={providerId} className={className} />;
}
