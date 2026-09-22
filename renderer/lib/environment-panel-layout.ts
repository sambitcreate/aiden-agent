/** Preferred Review/Files width when the workbench is wide enough for side-by-side. */
export const DEFAULT_PANEL_WIDTH = 560;
/** Narrowest useful expanded Environment surface (Files already uses a compact tree/editor below 540). */
export const MIN_PANEL_WIDTH = 480;
/** Widest expanded Environment surface. */
export const MAX_PANEL_WIDTH = 720;
/** Conversation column that must remain usable beside an inline Environment surface. */
export const MIN_CONVERSATION_WIDTH = 560;
/** Floating tools keep a thin uncovered strip so the thread remains visible and interactive. */
export const PANEL_EDGE_GUTTER = 44;
export const QUICK_VIEW_WIDTH = 380;
export const QUICK_VIEW_MIN_WIDTH = 300;
export const SURFACE_GAP = 12;

/**
 * Side-by-side needs at least this much workbench width. Below that, Review/Files
 * becomes a floating surface. This is independent of SplitView's 700px sidebar
 * chrome breakpoint — floating mode is fit-based, not a fixed window-width trigger.
 */
export const INLINE_MIN_CONTAINER_WIDTH = MIN_PANEL_WIDTH + MIN_CONVERSATION_WIDTH;

export function clampEnvironmentPanelWidth(value: number, containerWidth: number): number {
  const available = Math.max(0, containerWidth - PANEL_EDGE_GUTTER);
  const maximum = Math.min(MAX_PANEL_WIDTH, available || MAX_PANEL_WIDTH);
  const minimum = Math.min(MIN_PANEL_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Resolve the rendered panel width and whether it can sit inline.
 *
 * Prefer shrinking the saved width down to {@link MIN_PANEL_WIDTH} so side-by-side
 * remains available whenever the minimum panel still leaves a usable conversation
 * column. Only float when even that minimum cannot fit — closing the gap where
 * a wide preferred width would otherwise force floating mode while a narrower panel
 * would still fit.
 */
export function resolveEnvironmentPanelLayout(
  preferredWidth: number,
  containerWidth: number,
): { width: number; inline: boolean } {
  const available = Math.max(0, containerWidth - PANEL_EDGE_GUTTER);
  const minPanel = Math.min(MIN_PANEL_WIDTH, available || MIN_PANEL_WIDTH);
  const canInline = containerWidth - minPanel >= MIN_CONVERSATION_WIDTH;

  if (!canInline) {
    return {
      width: clampEnvironmentPanelWidth(preferredWidth, containerWidth),
      inline: false,
    };
  }

  const inlineMax = containerWidth - MIN_CONVERSATION_WIDTH;
  const preferred = clampEnvironmentPanelWidth(preferredWidth, containerWidth);
  return {
    width: Math.min(preferred, inlineMax),
    inline: true,
  };
}

export function resolveEnvironmentPanelResizeBounds(
  containerWidth: number,
  inline: boolean,
): { min: number; max: number } {
  const availableMaximum = inline
    ? containerWidth - MIN_CONVERSATION_WIDTH
    : containerWidth - PANEL_EDGE_GUTTER;
  const max = Math.max(0, Math.min(MAX_PANEL_WIDTH, availableMaximum));
  return { min: Math.min(MIN_PANEL_WIDTH, max), max };
}

export interface QuickViewLayout {
  width: number;
  right: number;
  alongsideTools: boolean;
}

/**
 * Keep Quick View beside Environment when the measured workbench can fit both.
 * On smaller allocations the surfaces share the right edge and the provider's
 * foreground state decides which one is presented; neither open state is lost.
 */
export function resolveQuickViewLayout(
  containerWidth: number,
  toolsOpen: boolean,
  toolsWidth: number,
  toolsInline: boolean,
): QuickViewLayout {
  const detachedWidth = Math.max(0, Math.min(QUICK_VIEW_WIDTH, containerWidth - 24));
  if (!toolsOpen) return { width: detachedWidth, right: 12, alongsideTools: false };

  const right = toolsWidth + (toolsInline ? SURFACE_GAP : SURFACE_GAP * 2);
  const availableWidth = containerWidth - right - 12;
  if (availableWidth >= QUICK_VIEW_MIN_WIDTH) {
    return {
      width: Math.min(QUICK_VIEW_WIDTH, availableWidth),
      right,
      alongsideTools: true,
    };
  }
  return { width: detachedWidth, right: 12, alongsideTools: false };
}
