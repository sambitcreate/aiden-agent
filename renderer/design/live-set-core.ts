// Which design frames get a real iframe. Live iframes are expensive, so at
// most six exist at once; every other file or artifact frame shows its last
// snapshot. Pure, so it is tested without a DOM.

import type { DesignFrame } from "../shared/design-canvas/schema";

/** The most iframes the canvas runs at once. */
export const DESIGN_LIVE_LIMIT = 6;
/** Below this zoom every frame shows its snapshot. */
export const DESIGN_LIVE_MIN_ZOOM = 0.25;
/**
 * A frame that was live and is still at least half on screen ranks as if it
 * covered this much more area, so a small pan does not swap it for a newcomer
 * of about the same size (and flash its iframe away and back).
 */
const KEEP_LIVE_BONUS = 1.5;

const canBeLive = (frame: DesignFrame) => frame.kind === "file" || frame.kind === "artifact";

export function selectLiveFrames(input: {
  frames: DesignFrame[];
  /** React Flow's viewport: screen = canvas × zoom + (x, y). */
  viewport: { x: number; y: number; zoom: number };
  /** The canvas's size on screen, in CSS pixels. */
  view: { w: number; h: number };
  selected: ReadonlySet<string>;
  entered: string | null;
  previous: ReadonlySet<string>;
}): Set<string> {
  const { viewport, view } = input;
  const live = new Set<string>();
  if (!(viewport.zoom >= DESIGN_LIVE_MIN_ZOOM)) return live;
  const candidates = input.frames.filter(canBeLive);
  const add = (id: string) => {
    if (live.size < DESIGN_LIVE_LIMIT) live.add(id);
  };

  if (input.entered !== null && candidates.some((frame) => frame.id === input.entered)) add(input.entered);
  for (const frame of candidates) if (input.selected.has(frame.id)) add(frame.id);

  const ranked: Array<{ id: string; score: number; order: number }> = [];
  candidates.forEach((frame, order) => {
    if (live.has(frame.id)) return;
    const left = Math.max(0, frame.x * viewport.zoom + viewport.x);
    const top = Math.max(0, frame.y * viewport.zoom + viewport.y);
    const right = Math.min(view.w, (frame.x + frame.w) * viewport.zoom + viewport.x);
    const bottom = Math.min(view.h, (frame.y + frame.h) * viewport.zoom + viewport.y);
    const visible = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (visible <= 0) return;
    const full = frame.w * frame.h * viewport.zoom * viewport.zoom;
    const keeps = input.previous.has(frame.id) && visible >= full / 2;
    ranked.push({ id: frame.id, score: keeps ? visible * KEEP_LIVE_BONUS : visible, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  for (const entry of ranked) add(entry.id);
  return live;
}
