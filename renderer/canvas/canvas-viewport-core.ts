export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 4;

export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
