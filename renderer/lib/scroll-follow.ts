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

/**
 * Content growth moves the trailing edge away from a previously latched viewport.
 * Pin from that pre-update latch instead of the post-layout distance.
 */
export function shouldPinAfterContentGrowth(wasFollowingLatest: boolean): boolean {
  return wasFollowingLatest;
}

/** Pin an overflow list so its latest rows are in view when the surface opens. */
export function pinOverflowListToEnd(element: { scrollHeight: number; scrollTop: number } | null): void {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}

/**
 * Smooth jump-to-bottom samples intermediate scrollTop. Keep follow latched
 * until the animation reaches the trailing edge.
 */
export function resolveProgrammaticFollowLatch(
  programmaticPinPending: boolean,
  atBottom: boolean,
): { pending: boolean; followLatest: boolean } {
  if (!programmaticPinPending) {
    return { pending: false, followLatest: atBottom };
  }
  if (atBottom) {
    return { pending: false, followLatest: true };
  }
  return { pending: true, followLatest: true };
}
