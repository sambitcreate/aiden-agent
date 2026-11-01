import { IMAGE_WORKFLOW_LIMITS, type WorkflowNodeDimensions } from "../shared/images/schema";

/** Every image node renders at this width unless its document stores a size. The only source of the width. */
export const IMAGE_NODE_WIDTH = 280;

/**
 * The node frame around a media node's image, from `CanvasNodeChrome` and the Image Input body:
 * the title row (36), the body's side padding (12 + 12), and below the image the gap (8), the
 * small button (28) and the bottom padding (12). The image itself fills whatever is left and
 * keeps its aspect inside that box, so an estimate that is off never overflows the node.
 */
export const MEDIA_NODE_FRAME = Object.freeze({ horizontal: 24, vertical: 36 + 8 + 28 + 12 });

const MIN_SIZE = IMAGE_WORKFLOW_LIMITS.minNodeSize;
const MAX_SIZE = IMAGE_WORKFLOW_LIMITS.maxNodeSize;
const MAX_WIDTH = 1_200;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Size a media node so its frame holds the image at its aspect: the node keeps its width (the
 * shared node width by default) and its height is the frame plus the image scaled to fit.
 */
export function fitNodeToMediaAspect(
  current: WorkflowNodeDimensions | undefined,
  mediaWidth: number,
  mediaHeight: number,
): WorkflowNodeDimensions | undefined {
  if (!Number.isFinite(mediaWidth) || !Number.isFinite(mediaHeight) || mediaWidth <= 0 || mediaHeight <= 0) {
    return undefined;
  }
  const width = Math.round(clamp(current?.width ?? IMAGE_NODE_WIDTH, MIN_SIZE, MAX_WIDTH));
  const imageHeight = (width - MEDIA_NODE_FRAME.horizontal) * (mediaHeight / mediaWidth);
  const height = Math.round(clamp(MEDIA_NODE_FRAME.vertical + imageHeight, MIN_SIZE, MAX_SIZE));
  return { width, height };
}
