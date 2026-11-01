import { DESIGN_WIDE_WINDOW_MIN, DESIGN_WIDEN_TARGET } from "../../renderer/lib/environment-panel-layout.js";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The parts of a BrowserWindow that widening needs. */
export interface DesignWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle, animate?: boolean): void;
}

/**
 * Bounds for a window widened for design mode: as close to `target` as the
 * display's work area allows, sliding left only as far as it must to keep the
 * right edge on screen. Null when even the whole work area is narrower than the
 * chat and canvas minimums (840 px).
 */
export function widenedBounds(
  current: Rectangle,
  workArea: Rectangle,
  target = DESIGN_WIDEN_TARGET,
): Rectangle | null {
  const width = Math.max(current.width, Math.min(target, workArea.width));
  if (width < DESIGN_WIDE_WINDOW_MIN) return null;
  const maxX = workArea.x + workArea.width - width;
  const x = Math.max(workArea.x, Math.min(current.x, maxX));
  return { x, y: current.y, width, height: current.height };
}

/** Widen a window for design mode. A full-screen window keeps its size. */
export function widenWindowForDesign(
  window: DesignWindow | null,
  workAreaFor: (bounds: Rectangle) => Rectangle,
): { widened: boolean } {
  if (!window || window.isDestroyed() || window.isFullScreen()) return { widened: false };
  const current = window.getBounds();
  const next = widenedBounds(current, workAreaFor(current));
  if (!next) return { widened: false };
  if (next.width !== current.width || next.x !== current.x) window.setBounds(next, true);
  return { widened: true };
}
