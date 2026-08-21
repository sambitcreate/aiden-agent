import type { CreateImagesRecentOutputView } from "../shared/create-images/ipc";
import { CREATE_IMAGES_ASSET_ID_PATTERN } from "../shared/create-images/schema";

export const CREATE_IMAGES_RECENT_OUTPUT_DRAG_MIME =
  "application/x-aiden-create-images-recent-output";
export const CREATE_IMAGES_RECENT_OUTPUT_DRAG_VERSION = 1 as const;
const MAX_RECENT_OUTPUT_DRAG_BYTES = 2_048;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface CreateImagesRecentOutputDragV1 {
  version: typeof CREATE_IMAGES_RECENT_OUTPUT_DRAG_VERSION;
  assetId: string;
  runId: string;
  workflowId: string;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function createCreateImagesRecentOutputDrag(
  item: CreateImagesRecentOutputView,
): CreateImagesRecentOutputDragV1 {
  return {
    version: CREATE_IMAGES_RECENT_OUTPUT_DRAG_VERSION,
    assetId: item.assetId,
    runId: item.runId,
    workflowId: item.workflowId,
    label: item.prompt.trim().slice(0, 160) || `Generated image ${item.assetId.slice(0, 8)}`,
  };
}

export function serializeCreateImagesRecentOutputDrag(
  value: CreateImagesRecentOutputDragV1,
): string | undefined {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength <= MAX_RECENT_OUTPUT_DRAG_BYTES
    ? serialized
    : undefined;
}

export function parseCreateImagesRecentOutputDrag(
  serialized: string,
): CreateImagesRecentOutputDragV1 | undefined {
  if (
    typeof serialized !== "string" ||
    serialized.length === 0 ||
    new TextEncoder().encode(serialized).byteLength > MAX_RECENT_OUTPUT_DRAG_BYTES
  ) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "assetId", "runId", "workflowId", "label"])
  ) {
    return undefined;
  }
  if (
    value.version !== CREATE_IMAGES_RECENT_OUTPUT_DRAG_VERSION ||
    typeof value.assetId !== "string" ||
    !CREATE_IMAGES_ASSET_ID_PATTERN.test(value.assetId) ||
    typeof value.runId !== "string" ||
    !OPAQUE_ID_PATTERN.test(value.runId) ||
    typeof value.workflowId !== "string" ||
    !OPAQUE_ID_PATTERN.test(value.workflowId) ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 160
  ) {
    return undefined;
  }
  return {
    version: CREATE_IMAGES_RECENT_OUTPUT_DRAG_VERSION,
    assetId: value.assetId,
    runId: value.runId,
    workflowId: value.workflowId,
    label: value.label,
  };
}
