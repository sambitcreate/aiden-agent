import type { OutputRef } from "../shared/images/run-types";
import { IMAGE_WORKFLOW_LIMITS, type ImageInputNode, type WorkflowNodeDimensions } from "../shared/images/schema";

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

/**
 * Where a new node of `size` goes so it sits at the middle of the visible canvas: `pane` is the
 * canvas element's size in screen pixels and `viewport` its pan and zoom. `cascade` nudges
 * repeated additions down and right so they do not stack exactly.
 */
export function nodePositionAtPaneCentre(
  viewport: { x: number; y: number; zoom: number },
  pane: { width: number; height: number },
  size: { width: number; height: number },
  cascade = 0,
): { x: number; y: number } {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const centreX = (pane.width / 2 - viewport.x) / zoom;
  const centreY = (pane.height / 2 - viewport.y) / zoom;
  const offset = (cascade % 6) * 24;
  return { x: Math.round(centreX - size.width / 2 + offset), y: Math.round(centreY - size.height / 2 + offset) };
}

/**
 * An Image Input holding an existing image (Use as Input), sized to the image's aspect and
 * centred in the visible canvas.
 */
export function imageInputNodeForAsset(
  image: Pick<OutputRef, "assetId" | "width" | "height">,
  id: string,
  viewport: { x: number; y: number; zoom: number },
  pane: { width: number; height: number },
  cascade = 0,
): ImageInputNode {
  const dimensions = fitNodeToMediaAspect(undefined, image.width, image.height);
  const size = dimensions ?? { width: IMAGE_NODE_WIDTH, height: IMAGE_NODE_WIDTH };
  return {
    id,
    type: "image-input",
    position: nodePositionAtPaneCentre(viewport, pane, size, cascade),
    ...(dimensions ? { dimensions } : {}),
    data: { assetId: image.assetId },
  };
}
