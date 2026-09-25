/** Distance remaining before the viewport's trailing edge. */
export function distanceFromScrollBottom(
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
): number {
  return scrollHeight - clientHeight - scrollTop;
}

/** Idle follow latch uses a small slop so streaming layout jitter stays latched. */
export const SCROLL_FOLLOW_BOTTOM_THRESHOLD_PX = 24;

export function isAtScrollBottom(
  distanceFromBottom: number,
  thresholdPx = SCROLL_FOLLOW_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom < thresholdPx;
}

export function shouldFollowScrollBottom(
  autoScrollEnabled: boolean,
  atBottom: boolean,
): boolean {
  return Boolean(autoScrollEnabled) && atBottom;
}

/** Pin an overflow list so its latest rows are in view when the surface opens. */
export function pinOverflowListToEnd(element: { scrollHeight: number; scrollTop: number } | null): void {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}
