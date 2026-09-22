import type { WorkflowNodeV1 } from "../shared/create-images/schema";
import {
  CREATE_IMAGES_MAX_NODES,
  CREATE_IMAGES_POSITION_LIMIT,
  type CreateImagesPosition,
} from "../shared/create-images/schema";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".gif",
]);

export const CREATE_IMAGES_DROP_NODE_WIDTH = 288;
export const CREATE_IMAGES_DROP_NODE_HEIGHT = 300;
export const CREATE_IMAGES_DROP_NODE_GAP = 24;

export interface CreateImagesDragItemLike {
  readonly kind?: string;
  readonly type?: string;
}

export interface CreateImagesDragDataLike {
  readonly items?: Iterable<CreateImagesDragItemLike> | null;
  readonly types?: Iterable<string> | null;
}

export interface CreateImagesFileLike {
  readonly name?: string;
  readonly type?: string;
}

export interface CreateImagesDropState {
  readonly active: boolean;
  readonly depth: number;
  readonly targetNodeId?: string;
}

export type CreateImagesDropAction =
  | { type: "enter"; valid: boolean; targetNodeId?: string }
  | { type: "over"; valid: boolean; targetNodeId?: string }
  | { type: "leave"; inside: boolean }
  | { type: "drop" };

export interface CreateImagesDropExistingNode {
  readonly id: string;
  readonly type: WorkflowNodeV1["type"];
  readonly position: CreateImagesPosition;
  readonly width?: number;
  readonly height?: number;
}

export interface CreateImagesDropPlanInput {
  readonly dropPoint: CreateImagesPosition;
  readonly existingNodes: readonly CreateImagesDropExistingNode[];
  readonly fileCount: number;
  readonly targetNodeId?: string;
  readonly nodeWidth?: number;
  readonly nodeHeight?: number;
  readonly nodeGap?: number;
}

export interface CreateImagesDropPlan {
  readonly replacementNodeId?: string;
  readonly positions: readonly CreateImagesPosition[];
}

export const INITIAL_CREATE_IMAGES_DROP_STATE: CreateImagesDropState = Object.freeze({
  active: false,
  depth: 0,
});

function normalizedMimeType(type: string | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

function extensionForName(name: string | undefined): string {
  const value = (name ?? "").trim().toLowerCase();
  const separator = value.lastIndexOf(".");
  return separator === -1 ? "" : value.slice(separator);
}

export function isSupportedCreateImagesFile(file: CreateImagesFileLike): boolean {
  const mimeType = normalizedMimeType(file.type);
  if (mimeType.startsWith("image/")) return true;
  const extensionSupported = SUPPORTED_IMAGE_EXTENSIONS.has(extensionForName(file.name));
  return (
    extensionSupported &&
    (mimeType.length === 0 ||
      mimeType === "application/octet-stream" ||
      mimeType === "binary/octet-stream")
  );
}

export function filterSupportedCreateImagesFiles<T extends CreateImagesFileLike>(
  files: readonly T[],
): T[] {
  return files.filter(isSupportedCreateImagesFile);
}

export function sanitizeCreateImagesImageLabel(label: string | undefined): string | undefined {
  const value = label?.trim();
  if (!value) return undefined;
  const basename = value.replace(/\\/gu, "/").split("/").pop()?.trim();
  return basename ? basename.slice(0, 120) : undefined;
}

/**
 * Drag sources can hide file MIME types until drop. An empty file item type is
 * therefore treated as a potential image, while an explicitly unsupported
 * MIME type is rejected before the canvas ever shows drop affordances.
 */
export function hasPotentialCreateImagesFileDrag(data: CreateImagesDragDataLike): boolean {
  const items = Array.from(data.items ?? []);
  const fileItems = items.filter((item) => item.kind?.toLowerCase() === "file");
  if (fileItems.length > 0) {
    return fileItems.some((item) => {
      const type = normalizedMimeType(item.type);
      return type.length === 0 || type.startsWith("image/");
    });
  }
  return Array.from(data.types ?? []).some((type) => type.trim().toLowerCase() === "files");
}

export function reduceCreateImagesDropState(
  state: CreateImagesDropState,
  action: CreateImagesDropAction,
): CreateImagesDropState {
  if (action.type === "drop") return INITIAL_CREATE_IMAGES_DROP_STATE;
  if (action.type === "enter") {
    if (!action.valid) return state;
    return {
      active: true,
      depth: state.depth + 1,
      ...(action.targetNodeId ? { targetNodeId: action.targetNodeId } : {}),
    };
  }
  if (action.type === "over") {
    if (!action.valid && !state.active) return state;
    return {
      active: state.active || action.valid,
      depth: state.active ? Math.max(1, state.depth) : 1,
      ...(action.targetNodeId ? { targetNodeId: action.targetNodeId } : {}),
    };
  }
  if (!action.inside) return INITIAL_CREATE_IMAGES_DROP_STATE;
  const depth = Math.max(0, state.depth - 1);
  return depth === 0 ? INITIAL_CREATE_IMAGES_DROP_STATE : { ...state, depth };
}

function finitePosition(position: CreateImagesPosition): CreateImagesPosition {
  const coordinate = (value: number) =>
    Number.isFinite(value)
      ? Math.max(-CREATE_IMAGES_POSITION_LIMIT, Math.min(CREATE_IMAGES_POSITION_LIMIT, value))
      : 0;
  return { x: coordinate(position.x), y: coordinate(position.y) };
}

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectanglesOverlap(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function candidateOffsets(stepX: number, stepY: number): Array<{ x: number; y: number }> {
  const offsets = [{ x: 0, y: 0 }];
  // A deterministic square spiral keeps the first placement at the pointer,
  // then moves in a predictable reading order when existing nodes occupy it.
  for (let ring = 1; ring <= CREATE_IMAGES_MAX_NODES; ring += 1) {
    const x = ring * stepX;
    const y = ring * stepY;
    offsets.push(
      { x, y: 0 },
      { x: -x, y: 0 },
      { x: 0, y },
      { x: 0, y: -y },
      { x, y },
      { x: -x, y },
      { x, y: -y },
      { x: -x, y: -y },
    );
  }
  return offsets;
}

function preferredPosition(
  point: CreateImagesPosition,
  index: number,
  count: number,
  width: number,
  height: number,
  gap: number,
): CreateImagesPosition {
  const columns = Math.min(3, Math.max(1, count));
  const row = Math.floor(index / columns);
  const column = index % columns;
  const horizontalOffset = (column - (columns - 1) / 2) * (width + gap);
  return finitePosition({
    x: point.x - width / 2 + horizontalOffset,
    y: point.y - height / 2 + row * (height + gap),
  });
}

function nodeRectangle(
  node: Pick<CreateImagesDropExistingNode, "position" | "width" | "height">,
  defaultWidth: number,
  defaultHeight: number,
): Rectangle {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? defaultWidth,
    height: node.height ?? defaultHeight,
  };
}

function findAvailablePosition(
  preferred: CreateImagesPosition,
  occupied: readonly Rectangle[],
  width: number,
  height: number,
  stepX: number,
  stepY: number,
): CreateImagesPosition {
  for (const offset of candidateOffsets(stepX, stepY)) {
    const position = finitePosition({
      x: preferred.x + offset.x,
      y: preferred.y + offset.y,
    });
    const rectangle = { x: position.x, y: position.y, width, height };
    if (!occupied.some((other) => rectanglesOverlap(rectangle, other))) return position;
  }
  return preferred;
}

export function planCreateImagesDrop({
  dropPoint,
  existingNodes,
  fileCount,
  targetNodeId,
  nodeWidth = CREATE_IMAGES_DROP_NODE_WIDTH,
  nodeHeight = CREATE_IMAGES_DROP_NODE_HEIGHT,
  nodeGap = CREATE_IMAGES_DROP_NODE_GAP,
}: CreateImagesDropPlanInput): CreateImagesDropPlan {
  const count = Math.max(0, Math.min(CREATE_IMAGES_MAX_NODES, Math.floor(fileCount)));
  const target = targetNodeId
    ? existingNodes.find((node) => node.id === targetNodeId && node.type === "image-input")
    : undefined;
  const replacementNodeId = target && count > 0 ? target.id : undefined;
  const createCount = count - (replacementNodeId ? 1 : 0);
  const occupied = existingNodes.map((node) => nodeRectangle(node, nodeWidth, nodeHeight));
  const placements: CreateImagesPosition[] = [];
  const stepX = nodeWidth + nodeGap;
  const stepY = nodeHeight + nodeGap;
  for (let index = 0; index < createCount; index += 1) {
    const preferred = preferredPosition(
      dropPoint,
      index,
      createCount,
      nodeWidth,
      nodeHeight,
      nodeGap,
    );
    const position = findAvailablePosition(
      preferred,
      [
        ...occupied,
        ...placements.map((item) => ({
          x: item.x,
          y: item.y,
          width: nodeWidth,
          height: nodeHeight,
        })),
      ],
      nodeWidth,
      nodeHeight,
      stepX,
      stepY,
    );
    placements.push(position);
  }
  return {
    ...(replacementNodeId ? { replacementNodeId } : {}),
    positions: placements,
  };
}
