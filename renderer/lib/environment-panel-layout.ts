/** Preferred Review/Files width when the workbench is wide enough for side-by-side. */
export const DEFAULT_PANEL_WIDTH = 560;
/** Narrowest useful expanded Environment surface (Files already uses a compact tree/editor below 540). */
export const MIN_PANEL_WIDTH = 480;
/** Widest expanded Environment surface. */
export const MAX_PANEL_WIDTH = 720;
/** Conversation column that must remain usable beside an inline Environment surface. */
export const MIN_CONVERSATION_WIDTH = 560;
/** Overlay sheet keeps a thin uncovered strip so the dimmed thread stays visible. */
export const PANEL_EDGE_GUTTER = 44;

/**
 * Side-by-side needs at least this much workbench width. Below that, Review/Files
 * becomes an overlay. This is independent of SplitView's 700px sidebar chrome
 * breakpoint — overlay is fit-based, not a fixed window-width trigger.
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
 * column. Only overlay when even that minimum cannot fit — closing the gap where
 * a wide preferred width would otherwise force overlay while a narrower panel
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
