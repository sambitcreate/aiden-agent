import type { CreateImagesNodeDimensions } from "../shared/create-images/schema";

const MIN_WIDTH = 180;
const MAX_WIDTH = 1_200;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1_600;

export function fitCreateImagesNodeToMediaAspect(
  current: CreateImagesNodeDimensions | undefined,
  mediaWidth: number,
  mediaHeight: number,
): CreateImagesNodeDimensions | undefined {
  if (
    !Number.isFinite(mediaWidth) ||
    !Number.isFinite(mediaHeight) ||
    mediaWidth <= 0 ||
    mediaHeight <= 0
  ) {
    return undefined;
  }
  const aspect = mediaWidth / mediaHeight;
  let width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current?.width ?? 320));
  let height = width / aspect;
  if (height < MIN_HEIGHT) {
    height = MIN_HEIGHT;
    width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, height * aspect));
  } else if (height > MAX_HEIGHT) {
    height = MAX_HEIGHT;
    width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, height * aspect));
  }
  return { width: Math.round(width), height: Math.round(height) };
}
