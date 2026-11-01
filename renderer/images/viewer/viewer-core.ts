// Electron-free logic behind the image viewer: stepping, the filmstrip window, fit and
// actual-size geometry, the details list and the words shown after an image action.
// Shared by the editor's viewer and the cross-workflow library.
import type { GalleryItem, ImageActionResponse } from "../../shared/images/ipc-types";
import type { ImageModelOption } from "../../shared/images/port";
import type { ImageMediaType } from "../../shared/images/run-types";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The next index after a step, clamped to the list: the viewer never wraps around. */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** "3 of 12": the active image's position, counted from one. */
export function positionLabel(index: number, count: number): string {
  return `${Math.min(index + 1, count)} of ${count}`;
}

/**
 * The slice of a long list the filmstrip renders, `[start, end)`, at most `size` long and
 * centred on the active image except where the list starts or ends.
 */
export function filmstripWindow(index: number, count: number, size: number): { start: number; end: number } {
  if (count <= size) return { start: 0, end: Math.max(0, count) };
  const start = Math.max(0, Math.min(count - size, index - Math.floor(size / 2)));
  return { start, end: start + size };
}

const usable = (size: Size) => Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;

/** The scale that fits an image inside the stage. Never above 1: a small image is never upscaled. */
export function fitScale(natural: Size, box: Size): number {
  if (!usable(natural) || !usable(box)) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}

/** Whether 100% shows more than the fitted image, so a click has something to zoom into. */
export function canZoom(natural: Size, box: Size): boolean {
  return fitScale(natural, box) < 1;
}

/**
 * Keeps an actual-size image covering the stage: the offset of the image's centre from the
 * stage's centre may move only as far as the image overhangs that side.
 */
export function clampPan(offset: Point, natural: Size, box: Size): Point {
  const limit = (image: number, stage: number) => Math.max(0, (image - stage) / 2);
  const clamp = (value: number, max: number) => (max === 0 ? 0 : Math.max(-max, Math.min(max, value)));
  return {
    x: clamp(offset.x, limit(natural.width, box.width)),
    y: clamp(offset.y, limit(natural.height, box.height)),
  };
}

/**
 * The pan for switching from fit to 100% with the clicked spot staying under the pointer.
 * `point` is the click relative to the stage's centre; at fit the image is centred.
 */
export function zoomAnchorPan(point: Point, natural: Size, box: Size): Point {
  const scale = fitScale(natural, box);
  return clampPan({ x: point.x * (1 - 1 / scale), y: point.y * (1 - 1 / scale) }, natural, box);
}

const FORMAT_LABELS: Record<ImageMediaType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

export function formatLabel(mediaType: ImageMediaType): string {
  return FORMAT_LABELS[mediaType] ?? mediaType;
}

/** The model's and provider's display names from the configured catalog, else the raw ids. */
export function modelNames(
  item: Pick<GalleryItem, "provider" | "model">,
  models: readonly ImageModelOption[],
): { model?: string; provider?: string } {
  const option = models.find((candidate) => candidate.provider === item.provider && candidate.model === item.model);
  const providerOption = option ?? models.find((candidate) => candidate.provider === item.provider);
  return {
    ...(option ? { model: option.label } : item.model ? { model: item.model } : {}),
    ...(providerOption ? { provider: providerOption.providerLabel } : item.provider ? { provider: item.provider } : {}),
  };
}

export interface DetailRow {
  label: string;
  value: string;
}

/** What the viewer's Details list shows, leaving out anything that was not recorded. */
export function detailRows(
  item: GalleryItem,
  models: readonly ImageModelOption[],
  formatTime: (timestamp: number) => string,
): DetailRow[] {
  const names = modelNames(item, models);
  const rows: (DetailRow | null)[] = [
    names.model ? { label: "Model", value: names.model } : null,
    names.provider ? { label: "Provider", value: names.provider } : null,
    usable(item) ? { label: "Size", value: `${item.width} × ${item.height}` } : null,
    { label: "Format", value: formatLabel(item.mediaType) },
    item.createdAt > 0 ? { label: "Created", value: formatTime(item.createdAt) } : null,
    item.workflowTitle ? { label: "Workflow", value: item.workflowTitle } : null,
    item.nodeTitle ? { label: "Node", value: item.nodeTitle } : null,
  ];
  return rows.filter((row): row is DetailRow => row !== null);
}

/** Lines past which a prompt is folded to four lines behind "Show full prompt" before measuring. */
export function promptLikelyClamped(prompt: string): boolean {
  return prompt.split("\n").length > 4 || prompt.length > 220;
}

/** The file-manager action's name on this platform. */
export function revealLabel(isMac: boolean): string {
  return isMac ? "Show in Finder" : "Show in folder";
}

export type ImageActionOp = "save-as" | "save-all" | "copy" | "reveal" | "reveal-saved" | "reveal-folder" | "drag" | "view";

export type ActionOutcome = { kind: "success"; text: string } | { kind: "error"; text: string } | null;

const FAILED: Record<ImageActionOp, string> = {
  "save-as": "Aiden couldn't save the image.",
  "save-all": "Aiden couldn't save the images.",
  copy: "Aiden couldn't copy the image.",
  reveal: "Aiden couldn't show the image.",
  "reveal-saved": "Aiden couldn't show what it saved.",
  "reveal-folder": "Aiden couldn't open the folder.",
  drag: "Aiden couldn't drag the image.",
  view: "Aiden couldn't open the full-size image.",
};

const UNSUPPORTED: Record<ImageActionOp, string> = {
  "save-as": "Saving images isn't available on this computer.",
  "save-all": "Saving images isn't available on this computer.",
  copy: "Copying images isn't available on this computer.",
  reveal: "Showing files isn't available on this computer.",
  "reveal-saved": "Showing files isn't available on this computer.",
  "reveal-folder": "Showing files isn't available on this computer.",
  drag: "Dragging images out isn't available on this computer.",
  view: "The full-size image isn't available on this computer.",
};

/**
 * What to tell the person after an image action. A cancelled dialog says nothing, and a
 * successful reveal or drag speaks for itself.
 */
export function actionOutcome(op: ImageActionOp, response: ImageActionResponse): ActionOutcome {
  if (response.ok) {
    if (op === "save-as") return { kind: "success", text: "Image saved" };
    if (op === "copy") return { kind: "success", text: "Image copied" };
    if (op === "save-all") {
      const count = response.count ?? 0;
      return { kind: "success", text: count === 1 ? "Saved 1 image" : `Saved ${count} images` };
    }
    return null;
  }
  switch (response.reason) {
    case "cancelled":
      return null;
    case "not-found":
      if (op === "reveal-saved") return { kind: "error", text: "Aiden no longer knows where that was saved." };
      return { kind: "error", text: op === "save-all" ? "These images are no longer available." : "This image is no longer available." };
    case "unsupported":
      return { kind: "error", text: UNSUPPORTED[op] };
    case "failed":
      return { kind: "error", text: response.message?.trim() || FAILED[op] };
  }
}

/** The same outcome for a call that threw before main answered. */
export function thrownOutcome(op: ImageActionOp): ActionOutcome {
  return { kind: "error", text: FAILED[op] };
}
