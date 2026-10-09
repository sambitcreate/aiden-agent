/**
 * Attributes the page's transient user activation to one inline visual.
 *
 * `navigator.userActivation` is page-wide: a click inside any visual activates
 * the app page, and a sandboxed guest can `focus()` itself without a gesture.
 * So "focused + active" is not enough to let a visual send as the user. A
 * frame earns a gesture only when the activation demonstrably came from input
 * into that frame:
 *
 * - activation turned on while the frame already held focus (keystrokes and
 *   clicks go to the focused frame; a click elsewhere moves focus away); or
 * - focus entered the frame together with activation while the pointer was
 *   over it and the app page had no recent input of its own (a click into
 *   it); in the expanded view, where every other visual is inert, the page
 *   input check is waived (the Expand click itself is page input); or
 * - focus entered during the page's own Tab default action (keyboard entry).
 *
 * The gesture lasts while activation stays continuously on and the frame keeps
 * focus.
 */
export interface FrameFocusEntry {
  /** Page activation when focus entered. */
  active: boolean;
  /** The pointer is over this frame. */
  hovered: boolean;
  /** The frame is the expanded top-layer view (everything else inert). */
  expanded: boolean;
  /** Focus moved here inside the page's Tab keydown default action. */
  duringTabDefault: boolean;
  /** The app page itself had pointer or key input within the activation window. */
  parentInputRecent: boolean;
}

export interface FrameGestureTracker {
  focusEntered(entry: FrameFocusEntry): void;
  focusLeft(): void;
  /** Sample page activation and focus (each animation frame while focused). */
  tick(sample: { active: boolean; focused: boolean }): void;
  gestured(sample: { active: boolean; focused: boolean }): boolean;
}

export function createFrameGestureTracker(): FrameGestureTracker {
  let attributed = false;
  let prevActive = false;
  let prevFocused = false;
  return {
    focusEntered(entry) {
      attributed =
        entry.active &&
        (entry.duringTabDefault || (entry.hovered && (entry.expanded || !entry.parentInputRecent)));
      prevActive = entry.active;
      prevFocused = true;
    },
    focusLeft() {
      attributed = false;
      prevFocused = false;
    },
    tick({ active, focused }) {
      if (!focused || !active) attributed = false;
      else if (prevFocused && !prevActive) attributed = true;
      prevActive = active;
      prevFocused = focused;
    },
    gestured({ active, focused }) {
      return attributed && active && focused;
    },
  };
}
