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

/** Keys that move a focused viewport away from the live edge. */
const AWAY_SCROLL_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Whether a scrolling key moves the viewport toward the start. Shift+Space
 * pages up; plain Space pages down.
 */
export function isAwayScrollKey(key: string, shiftKey = false): boolean {
  return AWAY_SCROLL_KEYS.has(key) || (key === " " && shiftKey);
}

/**
 * Follow re-arms when the reader brings the viewport back within this distance
 * of the bottom. Content growth alone never moves a reader into or out of it.
 */
export const FOLLOW_REARM_DISTANCE_PX = 40;
/** The jump button appears only beyond this distance while idle… */
export const JUMP_BUTTON_IDLE_DISTANCE_PX = 80;
/** …and beyond this one while a reply streams, so a single landing paragraph never flashes it. */
export const JUMP_BUTTON_STREAMING_DISTANCE_PX = 160;
/** The jump button appears after this long away from the bottom and hides immediately. */
export const JUMP_BUTTON_SHOW_DELAY_MS = 150;
/**
 * Wheel events closer together than this belong to one gesture. After a jump,
 * an upward gesture that was already coasting is momentum, not a new intent.
 */
export const WHEEL_GESTURE_QUIET_MS = 160;

/** A user action that can move the viewport away from the live edge. */
export type FollowIntent = "wheelUp" | "drag" | "key";

export interface FollowState {
  /** The latch: keep the viewport pinned to the bottom as content grows. */
  readonly following: boolean;
  /** A smooth jump to the bottom is still animating (the PR #250 latch). */
  readonly jumpPending: boolean;
  /** An upward wheel gesture that started before the last jump is still coasting. */
  readonly ignoringMomentum: boolean;
  readonly lastWheelAt: number | null;
  /** The last measured distance from the bottom. */
  readonly distance: number;
  /** The reader is holding the scrollbar; where it settles is their choice. */
  readonly scrollbarHeld: boolean;
  /**
   * The scroll offset follow last pinned the viewport at. Growth never lowers
   * the offset, so a following viewport that turns up well above it was moved
   * by something else: focus, scroll restoration, or a selection drag.
   */
  readonly pinnedTop: number | null;
}

export type FollowEvent =
  /**
   * The user did something that can move the viewport toward the start.
   * `canScrollUp` is false when that action cannot actually move it (content
   * does not overflow, or a drag still sits inside the re-arm band).
   */
  | { type: "userIntent"; intent: FollowIntent; at: number; canScrollUp: boolean }
  /** A scroll position sample. `ended` marks `scrollend`. */
  | { type: "settle"; distance: number; scrollTop?: number; ended?: boolean }
  /** Content or viewport size changed; `distance` is measured after any snap. */
  | { type: "contentResize"; distance: number; scrollTop?: number }
  /** The reader pressed the scrollbar. A press alone never ends follow. */
  | { type: "scrollbarHold" }
  /** The reader let go of the scrollbar; `distance` is where it settled. */
  | { type: "scrollbarRelease"; distance: number }
  /** Jump to the bottom. Smooth jumps keep a pending latch until they land. */
  | { type: "jump"; smooth: boolean }
  /** A different conversation opened: follow from its bottom. */
  | { type: "reset" };

export const INITIAL_FOLLOW_STATE: FollowState = {
  following: true,
  jumpPending: false,
  ignoringMomentum: false,
  lastWheelAt: null,
  distance: 0,
  scrollbarHeld: false,
  pinnedTop: null,
};

/** Records where a following viewport sits at the bottom, or forgets it. */
function withPinnedTop(state: FollowState, scrollTop: number | undefined): FollowState {
  if (!state.following) return state.pinnedTop === null ? state : { ...state, pinnedTop: null };
  if (scrollTop === undefined || state.jumpPending || state.distance > FOLLOW_REARM_DISTANCE_PX) return state;
  return { ...state, pinnedTop: scrollTop };
}

function isCoastingWheel(state: FollowState, at: number): boolean {
  return (
    state.ignoringMomentum &&
    state.lastWheelAt !== null &&
    at - state.lastWheelAt < WHEEL_GESTURE_QUIET_MS
  );
}

/**
 * Whether an upward wheel event belongs to a gesture that was already coasting
 * when the reader jumped to the bottom. Such events must not break follow, and
 * the scroller should swallow them so they cannot drag the view away either.
 */
export function followIgnoresWheel(state: FollowState, at: number): boolean {
  return isCoastingWheel(state, at);
}

/**
 * Stick-to-bottom as an intent latch. Only a user gesture that can move the
 * viewport up turns follow off; growth, keyboard insets, and layout settling
 * never do. A viewport that something else carried well above where follow
 * pinned it (focus moving to an earlier message, scroll restoration) has also
 * left the bottom, so follow lets it stay there. Follow turns back on only when
 * the viewport moves back toward the bottom and lands within
 * {@link FOLLOW_REARM_DISTANCE_PX}; while the scrollbar is held, only on release.
 */
export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "userIntent": {
      if (event.intent === "wheelUp") {
        if (isCoastingWheel(state, event.at)) return { ...state, lastWheelAt: event.at };
        const next = { ...state, ignoringMomentum: false, lastWheelAt: event.at };
        if (!event.canScrollUp) return next;
        return { ...next, following: false, jumpPending: false };
      }
      // A deliberate drag or key always ends the momentum window and an
      // in-flight smooth jump, even when it cannot move the view.
      const released = { ...state, ignoringMomentum: false, jumpPending: false };
      return event.canScrollUp ? { ...released, following: false } : released;
    }
    case "settle": {
      const towardEnd = event.distance < state.distance;
      const nearEnd = event.distance <= FOLLOW_REARM_DISTANCE_PX;
      const rearm = !state.following && !state.scrollbarHeld && towardEnd && nearEnd;
      const landed = nearEnd && towardEnd;
      const draggedAway = state.scrollbarHeld && !nearEnd;
      const displaced =
        state.following &&
        !state.jumpPending &&
        !nearEnd &&
        event.scrollTop !== undefined &&
        state.pinnedTop !== null &&
        event.scrollTop < state.pinnedTop - FOLLOW_REARM_DISTANCE_PX;
      return withPinnedTop(
        {
          ...state,
          distance: event.distance,
          following: (state.following || rearm) && !draggedAway && !displaced,
          jumpPending: state.jumpPending && !event.ended && !landed,
        },
        event.scrollTop,
      );
    }
    case "contentResize":
      return withPinnedTop({ ...state, distance: event.distance }, event.scrollTop);
    case "scrollbarHold":
      return { ...state, scrollbarHeld: true, ignoringMomentum: false, jumpPending: false };
    case "scrollbarRelease": {
      const nearEnd = event.distance <= FOLLOW_REARM_DISTANCE_PX;
      return withPinnedTop(
        {
          ...state,
          scrollbarHeld: false,
          distance: event.distance,
          following: state.following || nearEnd,
        },
        undefined,
      );
    }
    case "jump":
      return {
        ...state,
        following: true,
        jumpPending: event.smooth,
        ignoringMomentum: true,
        scrollbarHeld: false,
        pinnedTop: null,
      };
    case "reset":
      return { ...INITIAL_FOLLOW_STATE };
  }
}

/** Whether a following viewport needs another snap to reach the true bottom. */
export function followNeedsSnap(state: FollowState): boolean {
  return state.following && !state.jumpPending && state.distance > 0.5;
}

/**
 * Whether the jump-to-bottom button should be offered. Distance only decides
 * visibility; it never changes the follow latch.
 */
export function shouldOfferJumpToBottom(state: FollowState, streaming: boolean): boolean {
  if (state.following || state.jumpPending) return false;
  return (
    state.distance >
    (streaming ? JUMP_BUTTON_STREAMING_DISTANCE_PX : JUMP_BUTTON_IDLE_DISTANCE_PX)
  );
}
