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
 * until the animation reaches the trailing edge. A user interruption or the
 * animation ending (`scrollend`) terminates the jump: the latch then follows
 * the real position so an aborted jump never keeps an away reader pinned.
 */
export function resolveProgrammaticFollowLatch(
  programmaticPinPending: boolean,
  atBottom: boolean,
  terminated = false,
): { pending: boolean; followLatest: boolean } {
  if (!programmaticPinPending || terminated) {
    return { pending: false, followLatest: atBottom };
  }
  if (atBottom) {
    return { pending: false, followLatest: true };
  }
  return { pending: true, followLatest: true };
}

const USER_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** Keys that scroll a focused viewport and so abort a smooth programmatic scroll. */
export function isUserScrollKey(key: string): boolean {
  return USER_SCROLL_KEYS.has(key);
}
