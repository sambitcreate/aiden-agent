import type { BrowserBounds, BrowserCommandResult, BrowserElement, BrowserState, BrowserViewport } from "../shared/browser";
import { BROWSER_VIEWPORT_PRESETS } from "../shared/browser";

/** Chromium's standard device catalog, matching the reference browser. */
export const BROWSER_DEVICE_PRESETS = BROWSER_VIEWPORT_PRESETS.map((preset) => [preset.name, preset.width, preset.height] as const);

const presentationQueues = new Map<string, Promise<void>>();
/** A remount cannot let its predecessor's delayed hide overtake its show. */
export function enqueueBrowserPresentation(key: string, operation: () => Promise<unknown>): Promise<void> {
  const next = (presentationQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation).then(() => undefined);
  presentationQueues.set(key, next);
  void next.finally(() => { if (presentationQueues.get(key) === next) presentationQueues.delete(key); }).catch(() => undefined);
  return next;
}

export function acceptBrowserState(current: BrowserState | null, next: BrowserState, workspaceId: string): BrowserState | null {
  if (next.workspaceId !== workspaceId) return current;
  if (current?.workspaceId === workspaceId && current.revision > next.revision) return current;
  return next;
}

export function validBrowserViewport(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height)
    && width >= 240 && height >= 240 && width <= 3840 && height <= 3840
    && width * height <= 3840 * 2160;
}

export function resizeBrowserViewport(viewport: BrowserViewport, width: number, height: number, dimension: "width" | "height" = "width"): BrowserViewport | null {
  let nextWidth = Math.round(width);
  let nextHeight = Math.round(height);
  if (viewport.ratioLocked) {
    const ratio = viewport.width / viewport.height;
    if (dimension === "width") nextHeight = Math.round(nextWidth / ratio);
    else nextWidth = Math.round(nextHeight * ratio);
  }
  return validBrowserViewport(nextWidth, nextHeight)
    ? { mode: "responsive", width: nextWidth, height: nextHeight, ratioLocked: viewport.ratioLocked }
    : null;
}

export function browserAnnotationRegion(start: { x: number; y: number }, end: { x: number; y: number }): BrowserBounds {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function browserElementAtPoint(elements: BrowserElement[], point: { x: number; y: number }): BrowserElement | null {
  return elements.filter(({ bounds: b }) => b.width > 0 && b.height > 0 && point.x >= b.x && point.y >= b.y && point.x <= b.x + b.width && point.y <= b.y + b.height)
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height)[0] ?? null;
}

export function browserBoundsFromRect(rect: Pick<DOMRect, "x" | "y" | "width" | "height">): BrowserBounds | null {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}

/** Save-dialog cancellation is a successful command without a written file. */
export function savedBrowserScreenshotPath(result: BrowserCommandResult | null): string | null {
  const value = result?.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || !("path" in value)) return null;
  return typeof value.path === "string" && value.path.trim() ? value.path : null;
}
