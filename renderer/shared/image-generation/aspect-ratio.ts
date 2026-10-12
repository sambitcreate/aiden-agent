// Aspect ratios a chat `generate_image` call may request, and how each image
// provider expresses them. Renderer-safe: no Node or Electron imports. The
// list is shared with the in-chat placeholder (see placeholder-spec.ts) and
// mirrored by the iOS and Android clients.

export const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/** The ratio the placeholder uses when a call names none (or an unknown one). */
export const DEFAULT_IMAGE_ASPECT_RATIO: ImageAspectRatio = "1:1";

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value);
}

/** Width over height, e.g. 16/9 for "16:9". */
export function imageAspectRatioValue(ratio: ImageAspectRatio): number {
  const [width, height] = ratio.split(":").map(Number) as [number, number];
  return width / height;
}

/**
 * fal's `image_size` presets. 3:2 and 2:3 have no preset, so a model that
 * only takes `image_size` keeps its default shape for those.
 */
export const FAL_IMAGE_SIZE_PRESETS: Readonly<Partial<Record<ImageAspectRatio, string>>> = {
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
};

/**
 * How a fal model takes a shape: an `aspect_ratio` string from a known set,
 * or an `image_size` preset (see FAL_IMAGE_SIZE_PRESETS).
 */
export type FalAspectRatioSupport =
  | { field: "aspect_ratio"; values: readonly ImageAspectRatio[] }
  | { field: "image_size" };

/**
 * The request field and value that ask a fal model for `ratio`, or undefined
 * when the model can't express it (the field is then omitted).
 */
export function falAspectRatioInput(
  support: FalAspectRatioSupport | undefined,
  ratio: ImageAspectRatio | undefined,
): { field: "aspect_ratio" | "image_size"; value: string } | undefined {
  if (!support || !ratio) return undefined;
  if (support.field === "aspect_ratio")
    return support.values.includes(ratio) ? { field: "aspect_ratio", value: ratio } : undefined;
  const preset = FAL_IMAGE_SIZE_PRESETS[ratio];
  return preset ? { field: "image_size", value: preset } : undefined;
}

/** The ratios in a provider's enum that Aiden can request, in Aiden's order. */
export function supportedImageAspectRatios(values: readonly unknown[]): ImageAspectRatio[] {
  return IMAGE_ASPECT_RATIOS.filter((ratio) => values.includes(ratio));
}
